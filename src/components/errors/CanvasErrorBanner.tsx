import { useState } from "react";
import { useShellPlatform } from "../../app/platform";
import "./canvas-error-banner.css";

interface CanvasErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onCopyText?: () => void;
  /** Copies the error report for this message; rejects if copying failed. */
  onCopyReport?: () => Promise<void>;
  /** If true, the failure is fatal (blocking) and Retry is still offered. */
  fatal?: boolean;
}

/**
 * A persistent error banner for save failures. Keeps the user's pending content
 * visible and offers Retry (and Copy Text for note-save failures) so nothing is
 * silently discarded (plan Section H / Task 5.3). "Copy report" puts the saved
 * error report on the clipboard for the developer.
 */
export function CanvasErrorBanner({
  message,
  onRetry,
  onCopyText,
  onCopyReport,
  fatal,
}: CanvasErrorBannerProps) {
  const platform = useShellPlatform();
  // Подтверждение привязано к сообщению: новая ошибка снова показывает кнопку.
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const copied = copiedMessage === message;

  const handleCopyReport = () => {
    onCopyReport?.().then(
      () => setCopiedMessage(message),
      () => {},
    );
  };

  return (
    <div
      className={`error-banner ${fatal ? "error-banner--fatal" : ""}`}
      data-testid="error-banner"
      role="alert"
    >
      <div className="error-banner__text">
        <span className="error-banner__message">{message}</span>
        {onCopyReport && platform === "windows" && (
          <span className="error-banner__hint">Press Copy report and send it to the developer.</span>
        )}
      </div>
      <div className="error-banner__actions">
        {onCopyReport &&
          (copied ? (
            <span className="error-banner__copied" role="status">
              Report copied — send it to the developer
            </span>
          ) : (
            <button type="button" className="error-banner__btn" onClick={handleCopyReport}>
              Copy report
            </button>
          ))}
        {onCopyText && (
          <button type="button" className="error-banner__btn" onClick={onCopyText}>
            Copy text
          </button>
        )}
        {onRetry && (
          <button type="button" className="error-banner__btn error-banner__btn--primary" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
