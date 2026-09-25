import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { UpdatePrompt } from "./UpdatePrompt";
import {
  STARTUP_CHECK_DELAY_MS,
  UP_TO_DATE_VISIBLE_MS,
  useUpdateCheck,
  type UseUpdateCheckOptions,
} from "./use-update-check";

const checkMock = vi.fn();
const relaunchMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => checkMock() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }));

type ProgressHandler = (event: DownloadEvent) => void;

function fakeUpdate(
  version: string,
  downloadAndInstall: (onEvent: ProgressHandler) => Promise<void> = async () => {},
) {
  return {
    version,
    currentVersion: "0.2.0",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn(downloadAndInstall),
  };
}

function Harness(props: UseUpdateCheckOptions & { withCheckButton?: boolean }) {
  const updates = useUpdateCheck({ enabled: true, ...props });
  return (
    <>
      {props.withCheckButton && (
        <button type="button" onClick={() => void updates.checkNow()}>
          Check for updates…
        </button>
      )}
      <UpdatePrompt controller={updates} />
    </>
  );
}

/** Runs the startup timer and lets the mocked plugin calls resolve. */
async function passStartupDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);
  });
}

describe("update check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkMock.mockReset();
    relaunchMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing outside Tauri (browser / e2e build)", async () => {
    render(<Harness enabled={false} />);
    await passStartupDelay();
    expect(checkMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("checks only after the startup delay and shows the banner when an update exists", async () => {
    checkMock.mockResolvedValue(fakeUpdate("0.3.0"));
    render(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS - 1);
    });
    expect(checkMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("MySpace 0.3.0 is available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeInTheDocument();
  });

  it("stays hidden when no update is available on startup", async () => {
    checkMock.mockResolvedValue(null);
    render(<Harness />);
    await passStartupDelay();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("swallows a failed startup check (no banner, app unaffected)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkMock.mockRejectedValue(new Error("offline"));
    render(<Harness />);
    await passStartupDelay();
    expect(screen.queryByTestId("update-prompt")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("Later hides the banner for the session", async () => {
    checkMock.mockResolvedValue(fakeUpdate("0.3.0"));
    render(<Harness />);
    await passStartupDelay();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("manual check reports up to date, then the message goes away", async () => {
    checkMock.mockResolvedValue(null);
    render(<Harness withCheckButton startupDelayMs={60_000} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates…" }));
    });
    expect(screen.getByText("You’re up to date")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UP_TO_DATE_VISIBLE_MS);
    });
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("manual check shows an error inline", async () => {
    checkMock.mockRejectedValue(new Error("network down"));
    render(<Harness withCheckButton startupDelayMs={60_000} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates…" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check for updates: network down");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("manual check brings back an update dismissed with Later", async () => {
    checkMock.mockResolvedValue(fakeUpdate("0.3.0"));
    render(<Harness withCheckButton />);
    await passStartupDelay();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates…" }));
    });
    expect(screen.getByText("MySpace 0.3.0 is available")).toBeInTheDocument();
  });

  it("Update and restart flushes, shows download progress, installs, then relaunches", async () => {
    let emit: ProgressHandler = () => {};
    let finish: () => void = () => {};
    const update = fakeUpdate(
      "0.3.0",
      (onEvent) =>
        new Promise<void>((resolve) => {
          emit = onEvent;
          finish = resolve;
        }),
    );
    checkMock.mockResolvedValue(update);
    const flush = vi.fn().mockResolvedValue(undefined);
    render(<Harness flushBeforeInstall={flush} />);
    await passStartupDelay();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);

    act(() => emit({ event: "Started", data: { contentLength: 1000 } }));
    act(() => emit({ event: "Progress", data: { chunkLength: 250 } }));
    expect(screen.getByText(/Downloading MySpace 0\.3\.0… 25%/)).toBeInTheDocument();
    expect(screen.getByTestId("update-progress")).toHaveAttribute("value", "25");
    act(() => emit({ event: "Progress", data: { chunkLength: 750 } }));
    expect(screen.getByTestId("update-progress")).toHaveAttribute("value", "100");
    act(() => emit({ event: "Finished" }));
    expect(screen.getByText(/Installing MySpace 0\.3\.0/)).toBeInTheDocument();
    expect(relaunchMock).not.toHaveBeenCalled();

    await act(async () => {
      finish();
    });
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed install shows the error inline and offers a retry", async () => {
    const update = fakeUpdate("0.3.0", async () => {
      throw new Error("signature mismatch");
    });
    checkMock.mockResolvedValue(update);
    render(<Harness />);
    await passStartupDelay();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Update failed: signature mismatch");
    expect(relaunchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
  });
});
