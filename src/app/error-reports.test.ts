import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorReportSaved, WorkspaceGateway } from "../services/workspace-gateway";
import {
  APP_VERSION,
  ERROR_REPORT_DEDUPE_MS,
  createErrorReportRecorder,
  fallbackReportText,
  useErrorReports,
} from "./error-reports";

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
}));

vi.mock("../services/clipboard", () => ({
  copyText: mocks.copyText,
}));

function saved(text: string): ErrorReportSaved {
  return { path: "/data/error-reports/r.json", text };
}

function gatewayWith(recordErrorReport: ReturnType<typeof vi.fn>) {
  return { recordErrorReport } as unknown as WorkspaceGateway;
}

beforeEach(() => {
  mocks.copyText.mockReset();
  mocks.copyText.mockResolvedValue(undefined);
});

describe("createErrorReportRecorder", () => {
  it("sends the message with the frontend version and user agent", async () => {
    const recordErrorReport = vi.fn(async () => saved("report"));
    const recorder = createErrorReportRecorder(gatewayWith(recordErrorReport));

    await recorder.record({ message: "boom", source: "canvas", boardId: "b1" });

    expect(recordErrorReport).toHaveBeenCalledWith({
      message: "boom",
      source: "canvas",
      boardId: "b1",
      frontendVersion: APP_VERSION,
      userAgent: navigator.userAgent,
    });
  });

  it("records the same message once within the dedupe window", async () => {
    let now = 1_000;
    const recordErrorReport = vi.fn(async () => saved("report"));
    const recorder = createErrorReportRecorder(gatewayWith(recordErrorReport), () => now);

    await recorder.record({ message: "boom" });
    now += ERROR_REPORT_DEDUPE_MS - 1;
    await recorder.record({ message: "boom" });
    await recorder.record({ message: "other" });
    expect(recordErrorReport).toHaveBeenCalledTimes(2);

    now += 1;
    await recorder.record({ message: "boom" });
    expect(recordErrorReport).toHaveBeenCalledTimes(3);
  });

  it("swallows a failed recording, including a synchronous throw", async () => {
    const rejecting = createErrorReportRecorder(
      gatewayWith(vi.fn(async () => Promise.reject(new Error("disk full")))),
    );
    await expect(rejecting.record({ message: "boom" })).resolves.toBeNull();

    const throwing = createErrorReportRecorder(
      gatewayWith(
        vi.fn(() => {
          throw new Error("no backend");
        }),
      ),
    );
    await expect(throwing.record({ message: "boom" })).resolves.toBeNull();
  });

  it("reportText returns the recorded text, or the fallback when recording failed", async () => {
    const ok = createErrorReportRecorder(gatewayWith(vi.fn(async () => saved("backend text"))));
    await ok.record({ message: "boom" });
    await expect(ok.reportText("boom")).resolves.toBe("backend text");

    const failed = createErrorReportRecorder(gatewayWith(vi.fn(async () => Promise.reject("x"))));
    await failed.record({ message: "boom" });
    await expect(failed.reportText("boom")).resolves.toBe(fallbackReportText("boom"));
    await expect(failed.reportText("never recorded")).resolves.toBe(fallbackReportText("never recorded"));
  });
});

describe("fallbackReportText", () => {
  it("carries the message, the version and the user agent", () => {
    const text = fallbackReportText("database error: locked");
    expect(text).toContain("database error: locked");
    expect(text).toContain(APP_VERSION);
    expect(text).toContain(navigator.userAgent);
  });
});

describe("useErrorReports", () => {
  interface ShownErrors {
    canvasError: string | null;
    trashError: string | null;
    trashEmptyError: string | null;
  }

  function harness(recordErrorReport = vi.fn(async () => saved("backend text"))) {
    const gateway = gatewayWith(recordErrorReport);
    const initialProps: ShownErrors = { canvasError: null, trashError: null, trashEmptyError: null };
    const hook = renderHook(
      (props: ShownErrors) => useErrorReports({ gateway, boardId: "board-1", ...props }),
      { initialProps },
    );
    return { ...hook, recordErrorReport };
  }

  it("records each newly shown error with its source", async () => {
    const test = harness();
    expect(test.recordErrorReport).not.toHaveBeenCalled();

    test.rerender({ canvasError: "canvas boom", trashError: null, trashEmptyError: null });
    test.rerender({ canvasError: "canvas boom", trashError: "trash boom", trashEmptyError: "empty boom" });

    await waitFor(() => expect(test.recordErrorReport).toHaveBeenCalledTimes(3));
    expect(test.recordErrorReport).toHaveBeenCalledWith(
      expect.objectContaining({ message: "canvas boom", source: "canvas", boardId: "board-1" }),
    );
    expect(test.recordErrorReport).toHaveBeenCalledWith(
      expect.objectContaining({ message: "trash boom", source: "trash" }),
    );
    expect(test.recordErrorReport).toHaveBeenCalledWith(
      expect.objectContaining({ message: "empty boom", source: "trash-empty" }),
    );
  });

  it("copyReport copies the recorded text and never copies on its own", async () => {
    const test = harness();
    test.rerender({ canvasError: "canvas boom", trashError: null, trashEmptyError: null });
    await waitFor(() => expect(test.recordErrorReport).toHaveBeenCalled());
    expect(mocks.copyText).not.toHaveBeenCalled();

    await act(() => test.result.current.copyReport("canvas boom"));
    expect(mocks.copyText).toHaveBeenCalledWith("backend text");
  });

  it("copyReport falls back to the frontend text when recording failed", async () => {
    const test = harness(vi.fn(async () => Promise.reject(new Error("disk full"))));
    test.rerender({ canvasError: "canvas boom", trashError: null, trashEmptyError: null });
    await waitFor(() => expect(test.recordErrorReport).toHaveBeenCalled());

    await act(() => test.result.current.copyReport("canvas boom"));
    expect(mocks.copyText).toHaveBeenCalledWith(fallbackReportText("canvas boom"));
  });
});
