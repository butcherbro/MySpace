// Text color mark for the editor: a semantic preset stored in the document.
//
// Only the preset id (`blue`, `green`, …) is persisted; the actual color comes
// from CSS design tokens, so the palette can change later without a data
// migration. `default` means "no user color" (mark removed).

import { Mark, mergeAttributes } from "@tiptap/core";

export type TextColorId = "default" | "blue" | "green" | "orange" | "red" | "gray";

export const TEXT_COLOR_IDS: TextColorId[] = [
  "default",
  "blue",
  "green",
  "orange",
  "red",
  "gray",
];

export interface TextColorOption {
  id: TextColorId;
  label: string;
}

/** Order/UI metadata for the rail palette. */
export const TEXT_COLOR_OPTIONS: TextColorOption[] = [
  { id: "default", label: "Default" },
  { id: "blue", label: "Blue" },
  { id: "green", label: "Green" },
  { id: "orange", label: "Orange" },
  { id: "red", label: "Red" },
  { id: "gray", label: "Gray" },
];

export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-color"),
        renderHTML: (attributes) => (attributes.color ? { "data-color": attributes.color } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-color]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const color = HTMLAttributes["data-color"] as string | undefined;
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: color ? `text-color--${color}` : "text-color" }),
      0,
    ];
  },
});
