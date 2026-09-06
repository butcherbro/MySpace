import { Icon, type IconName } from "../icons/Icon";

interface ToolButtonProps {
  icon: IconName;
  label: string;
  visibleLabel: string;
  onClick: () => void;
}

export function ToolButton({ icon, label, visibleLabel, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      className="tool-button"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} className="tool-button__icon" />
      <span className="tool-button__label">{visibleLabel}</span>
    </button>
  );
}
