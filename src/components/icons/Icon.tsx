import type { SVGProps } from "react";
import "./icon.css";

export type IconName =
  | "note"
  | "link"
  | "board"
  | "image"
  | "arrow-left"
  | "search"
  | "undo"
  | "redo"
  | "bookmark";

interface IconProps {
  name: IconName;
  label?: string;
  className?: string;
}

const ICONS: Record<IconName, () => React.JSX.Element> = {
  note: () => (
    <>
      <path d="M7 3.75h7.5L17.75 7v13.25H7z" />
      <path d="M14.5 3.75V7h3.25" />
      <path d="M9.5 11h5" />
      <path d="M9.5 14h4" />
    </>
  ),
  link: () => (
    <>
      <path d="M14.25 9.75a3.75 3.75 0 0 1 0 5.3l-1.1 1.1a3.75 3.75 0 0 1-5.3 0l-.2-.2" />
      <path d="M9.75 14.25a3.75 3.75 0 0 1 0-5.3l1.1-1.1a3.75 3.75 0 0 1 5.3 0l.2.2" />
      <path d="m10.5 13.5 3-3" />
    </>
  ),
  board: () => (
    <>
      <rect x="4.75" y="5" width="14.5" height="14" rx="2" />
      <path d="M8 8.5h8" />
      <path d="M8 12h4.5" />
      <path d="M8 15.5h6" />
    </>
  ),
  image: () => (
    <>
      <rect x="4.75" y="5" width="14.5" height="14" rx="2" />
      <path d="M7 15.5 10.25 12l2.75 2.75 1.5-1.5 2.25 2.25" />
      <circle cx="9" cy="9" r="1.25" />
    </>
  ),
  "arrow-left": () => (
    <>
      <path d="M10 6.5 5.5 12 10 17.5" />
      <path d="M5.5 12h13" />
    </>
  ),
  search: () => (
    <>
      <circle cx="11" cy="11" r="5.5" />
      <path d="m15.5 15.5 3 3" />
    </>
  ),
  undo: () => (
    <>
      <path d="M7.5 8.5H4.75v-2.75" />
      <path d="M4.75 8.5a8.5 8.5 0 1 1 1.1 8.25" />
    </>
  ),
  redo: () => (
    <>
      <path d="M16.5 8.5h2.75v-2.75" />
      <path d="M19.25 8.5a8.5 8.5 0 1 0-1.1 8.25" />
    </>
  ),
  bookmark: () => (
    <>
      <path d="M7 5.5h10v13L12 15l-5 3.5z" />
    </>
  ),
};

export function Icon({ name, label, className }: IconProps) {
  const ariaProps: Pick<SVGProps<SVGSVGElement>, "aria-hidden" | "aria-label" | "role"> = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true };

  const IconPath = ICONS[name];

  return (
    <svg
      className={["icon", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...ariaProps}
    >
      <IconPath />
    </svg>
  );
}
