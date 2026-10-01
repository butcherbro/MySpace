import { useCallback, useEffect, useMemo } from "react";
import { copyText } from "../services/clipboard";
import type { ErrorReportSaved, WorkspaceGateway } from "../services/workspace-gateway";
import { useLatestRef } from "./use-latest-ref";

// Error reports: every newly shown error is saved by the backend under
// `<data dir>/error-reports/`, so the developer can read what happened without
// asking the user. The same report's text is what "Copy report" puts on the
// clipboard (the only way to get it off a Windows machine). Recording is
// best-effort and silent: a failure never shows an error of its own.

/** The same message shown again within this window is recorded once. */
export const ERROR_REPORT_DEDUPE_MS = 3_000;
/** The frontend's own version (`package.json`, injected by Vite). */
export const APP_VERSION: string = __APP_VERSION__;
/** How many distinct messages keep their report for "Copy report". */
const REMEMBERED_MESSAGES = 20;

export interface ErrorReportDetails {
  message: string;
  /** Saved with the report but not shown in the banner (for example the text a failed save kept). */
  detail?: string;
  /**
   * A newer report of a message already recorded, made on purpose (for example
   * with newer text): saved even within the dedupe window, and "Copy report"
   * copies it from then on.
   */
  supersede?: boolean;
  code?: string;
  boardId?: string;
  source?: string;
}

export interface ErrorReportRecorder {
  /** Records a report (deduplicated); resolves `null` when recording failed. */
  record(details: ErrorReportDetails): Promise<ErrorReportSaved | null>;
  /** The report text for `message`, or the frontend fallback without one. */
  reportText(message: string): Promise<string>;
}

/** What "Copy report" copies when the backend could not save a report. */
export function fallbackReportText(message: string): string {
  return [
    "MySpace error report (not saved by the app)",
    `App version: ${APP_VERSION}`,
    `Message: ${message}`,
    `User agent: ${navigator.userAgent}`,
  ].join("\n");
}

export function createErrorReportRecorder(
  gateway: Pick<WorkspaceGateway, "recordErrorReport">,
  now: () => number = Date.now,
): ErrorReportRecorder {
  const recent = new Map<string, { at: number; report: Promise<ErrorReportSaved | null> }>();

  return {
    record(details) {
      const at = now();
      const previous = recent.get(details.message);
      // Повтор того же сообщения — тот же отчёт, с какими бы подробностями он ни
      // пришёл: частоту отчётов с подробностями задаёт тот, кто их пишет.
      if (previous && !details.supersede && at - previous.at < ERROR_REPORT_DEDUPE_MS) return previous.report;

      const { detail, code, boardId, source } = details;
      // `then` ловит и синхронный throw шлюза: запись отчёта не должна ронять UI.
      const report = Promise.resolve()
        .then(() =>
          gateway.recordErrorReport({
            code,
            boardId,
            source,
            message: detail === undefined ? details.message : `${details.message}\n\n${detail}`,
            frontendVersion: APP_VERSION,
            userAgent: navigator.userAgent,
          }),
        )
        .catch(() => null);
      recent.delete(details.message);
      recent.set(details.message, { at, report });
      // Map хранит порядок вставки: первым идёт самый давний.
      for (const oldest of recent.keys()) {
        if (recent.size <= REMEMBERED_MESSAGES) break;
        recent.delete(oldest);
      }
      return report;
    },
    async reportText(message) {
      const saved = await recent.get(message)?.report;
      return saved?.text ?? fallbackReportText(message);
    },
  };
}

export interface UseErrorReportsOptions {
  gateway: Pick<WorkspaceGateway, "recordErrorReport">;
  /** The canvas error banner's message (`state.error`). */
  canvasError: string | null;
  boardId: string | null | undefined;
  trashError: string | null;
  trashEmptyError: string | null;
}

/**
 * Records a report whenever one of the user-visible errors changes to a new
 * message, and returns `copyReport` for the banner's "Copy report" button.
 */
export function useErrorReports({
  gateway,
  canvasError,
  boardId,
  trashError,
  trashEmptyError,
}: UseErrorReportsOptions) {
  const recorder = useMemo(() => createErrorReportRecorder(gateway), [gateway]);
  // Доска читается через ref: смена доски сама по себе не новая ошибка.
  const boardIdRef = useLatestRef(boardId);

  useEffect(() => {
    if (!canvasError) return;
    void recorder.record({
      message: canvasError,
      boardId: boardIdRef.current ?? undefined,
      source: "canvas",
    });
  }, [recorder, canvasError, boardIdRef]);

  useEffect(() => {
    if (trashError) void recorder.record({ message: trashError, source: "trash" });
  }, [recorder, trashError]);

  useEffect(() => {
    if (trashEmptyError) void recorder.record({ message: trashEmptyError, source: "trash-empty" });
  }, [recorder, trashEmptyError]);

  const copyReport = useCallback(
    async (message: string) => copyText(await recorder.reportText(message)),
    [recorder],
  );

  const recordReport = useCallback(
    (details: ErrorReportDetails) => {
      void recorder.record(details);
    },
    [recorder],
  );

  return { copyReport, recordReport };
}
