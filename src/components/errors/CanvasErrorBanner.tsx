import "./canvas-error-banner.css";

interface CanvasErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onCopyText?: () => void;
  /** If true, the failure is fatal (blocking) and Retry is still offered. */
  fatal?: boolean;
}

/**
 * A persistent error banner for save failures. Keeps the user's pending content
 * visible and offers Retry (and Copy Text for note-save failures) so nothing is
 * silently discarded (plan Section H / Task 5.3).
 */
export function CanvasErrorBanner({
  message,
  onRetry,
  onCopyText,
  fatal,
}: CanvasErrorBannerProps) {
  return (
    <div
      className={`error-banner ${fatal ? "error-banner--fatal" : ""}`}
      data-testid="error-banner"
      role="alert"
    >
      <span className="error-banner__message">{message}</span>
      <div className="error-banner__actions">
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
