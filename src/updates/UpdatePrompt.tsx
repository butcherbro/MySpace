import type { UpdateController } from "./use-update-check";
import "./update-prompt.css";

interface UpdatePromptProps {
  controller: UpdateController;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Small, non-blocking update banner at the bottom-right. Never modal: the app
 * stays fully usable while it is up, and "Later" hides it for the session.
 */
export function UpdatePrompt({ controller }: UpdatePromptProps) {
  const { state, visible, install, dismiss } = controller;
  if (!visible) return null;

  const later = (
    <button type="button" className="update-prompt__button" onClick={dismiss}>
      Later
    </button>
  );

  let content;
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      content = <p className="update-prompt__text">Checking for updates…</p>;
      break;
    case "upToDate":
      content = (
        <>
          <p className="update-prompt__text">You’re up to date</p>
          <div className="update-prompt__actions">
            <button type="button" className="update-prompt__button" onClick={dismiss}>
              OK
            </button>
          </div>
        </>
      );
      break;
    case "available":
      content = (
        <>
          <p className="update-prompt__text">MySpace {state.version} is available</p>
          <div className="update-prompt__actions">
            {later}
            <button
              type="button"
              className="update-prompt__button update-prompt__button--primary"
              onClick={() => void install()}
            >
              Update and restart
            </button>
          </div>
        </>
      );
      break;
    case "downloading": {
      const percent =
        state.total && state.total > 0
          ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
          : null;
      content = (
        <>
          <p className="update-prompt__text">
            Downloading MySpace {state.version}…{" "}
            {percent !== null ? `${percent}%` : formatMegabytes(state.downloaded)}
          </p>
          <progress
            className="update-prompt__progress"
            data-testid="update-progress"
            max={100}
            value={percent ?? undefined}
            aria-label="Update download progress"
          />
        </>
      );
      break;
    }
    case "installing":
      content = <p className="update-prompt__text">Installing MySpace {state.version}… The app will restart.</p>;
      break;
    case "error":
      content = (
        <>
          <p className="update-prompt__error" role="alert">
            {state.message}
          </p>
          <div className="update-prompt__actions">
            <button type="button" className="update-prompt__button" onClick={dismiss}>
              Close
            </button>
            {state.version !== null && (
              <button
                type="button"
                className="update-prompt__button update-prompt__button--primary"
                onClick={() => void install()}
              >
                Try again
              </button>
            )}
          </div>
        </>
      );
      break;
  }

  return (
    <div className="update-prompt" role="status" aria-live="polite" data-testid="update-prompt">
      {content}
    </div>
  );
}
