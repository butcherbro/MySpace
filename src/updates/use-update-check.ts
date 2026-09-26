import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

/**
 * In-app updates (tauri-plugin-updater). The plugin reads `latest.json` from the
 * public MySpace-releases repo (see `plugins.updater` in tauri.conf.json),
 * verifies the minisign signature, and installs the new bundle; we then
 * relaunch through tauri-plugin-process. Talks to the plugin JS API directly,
 * not through the workspace gateway: updates are not workspace data.
 */

/** Delay before the automatic startup check, so it never competes with the first board load. */
export const STARTUP_CHECK_DELAY_MS = 3000;
/** How long "You're up to date" stays up after a manual check. */
export const UP_TO_DATE_VISIBLE_MS = 4000;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string; version: string | null };

export interface UpdateController {
  /** `false` outside the Tauri WebView (browser dev, e2e): nothing is ever checked. */
  supported: boolean;
  state: UpdateState;
  /** The banner is visible (state is not idle and the user did not press Later). */
  visible: boolean;
  /** Manual "Check for updates…": also reports "You're up to date" and errors. */
  checkNow: () => Promise<void>;
  /** Download, install, then relaunch. */
  install: () => Promise<void>;
  /** "Later": hides the banner for this session (until the next manual check). */
  dismiss: () => void;
}

export interface UpdaterApi {
  check: () => Promise<Update | null>;
  relaunch: () => Promise<void>;
}

const defaultApi: UpdaterApi = {
  check: async () => (await import("@tauri-apps/plugin-updater")).check(),
  relaunch: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

export interface UseUpdateCheckOptions {
  /** Defaults to "running inside Tauri". */
  enabled?: boolean;
  /** Injected in tests; defaults to the plugin JS API. */
  api?: UpdaterApi;
  startupDelayMs?: number;
  /**
   * Settles pending writes before the app is replaced. On Windows the plugin
   * exits the process as soon as the installer starts, and `relaunch()` skips
   * the window close handler, so the close-flush never runs on its own.
   */
  flushBeforeInstall?: () => Promise<void>;
}

export function useUpdateCheck(options: UseUpdateCheckOptions = {}): UpdateController {
  const supported = options.enabled ?? isTauriRuntime();
  const startupDelayMs = options.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const api = () => latest.current.api ?? defaultApi;

  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const update = useRef<Update | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = (next: UpdateState) => {
    if (mounted.current) setState(next);
  };

  const runCheck = useCallback(async (manual: boolean): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    if (manual) {
      setDismissed(false);
      set({ kind: "checking" });
    }
    try {
      const found = await api().check();
      const previous = update.current;
      update.current = found;
      if (previous && previous !== found) void previous.close().catch(() => {});
      if (found) set({ kind: "available", version: found.version });
      else set(manual ? { kind: "upToDate" } : { kind: "idle" });
    } catch (error) {
      // A failed startup check (offline, releases repo unreachable) is not
      // worth interrupting anyone for; a manual one says what went wrong.
      if (manual) set({ kind: "error", message: `Could not check for updates: ${describe(error)}`, version: null });
      else console.warn("update check failed", error);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    const timer = setTimeout(() => void runCheck(false), startupDelayMs);
    return () => clearTimeout(timer);
  }, [supported, startupDelayMs, runCheck]);

  // "You're up to date" is a transient confirmation.
  useEffect(() => {
    if (state.kind !== "upToDate") return;
    const timer = setTimeout(() => set({ kind: "idle" }), UP_TO_DATE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [state.kind]);

  const install = useCallback(async (): Promise<void> => {
    const found = update.current;
    if (!found || busy.current) return;
    busy.current = true;
    const version = found.version;
    let downloaded = 0;
    let total: number | null = null;
    set({ kind: "downloading", version, downloaded, total });
    try {
      const flush = latest.current.flushBeforeInstall;
      if (flush) await flush();
      await found.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            set({ kind: "downloading", version, downloaded, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({ kind: "downloading", version, downloaded, total });
            break;
          case "Finished":
            set({ kind: "installing", version });
            break;
        }
      });
      // Windows never gets here: the installer takes over and restarts the app.
      set({ kind: "installing", version });
      await api().relaunch();
    } catch (error) {
      set({ kind: "error", message: `Update failed: ${describe(error)}`, version });
    } finally {
      busy.current = false;
    }
  }, []);

  const checkNow = useCallback(() => runCheck(true), [runCheck]);
  const dismiss = useCallback(() => setDismissed(true), []);

  return {
    supported,
    state,
    visible: supported && !dismissed && state.kind !== "idle",
    checkNow,
    install,
    dismiss,
  };
}
