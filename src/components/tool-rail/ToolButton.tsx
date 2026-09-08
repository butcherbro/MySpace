import { Icon, type IconName } from "../icons/Icon";

interface ToolButtonProps {
  icon: IconName;
  label: string;
  visibleLabel: string;
  onClick: () => void;
  /** Marks the button as active (e.g. Bold is on at the caret). */
  active?: boolean;
  /** Optional mousedown handler (e.g. keep editor focus for formatting tools). */
  onMouseDown?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function ToolButton({
  icon,
  label,
  visibleLabel,
  onClick,
  active = false,
  onMouseDown,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`tool-button${active ? " tool-button--active" : ""}`}
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={label}
      aria-label={label}
      aria-pressed={active ? "true" : undefined}
    >
      <Icon name={icon} className="tool-button__icon" />
      <span className="tool-button__label">{visibleLabel}</span>
    </button>
  );
}
