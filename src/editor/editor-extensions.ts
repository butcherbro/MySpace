// Tiptap extension configuration: the approved StarterKit subset (plan D2).
// Paragraph, headings 1-3, bold, italic, strike, bullet/ordered lists, blockquote.
//
// Everything outside V1 is explicitly disabled so that pastes and shortcuts
// cannot silently introduce structures (links, code blocks, underline,
// horizontal rules, task items, etc.) into persisted documents before the schema
// and runtime validation catch up.

import Link from "@tiptap/extension-link";
import Strike from "@tiptap/extension-strike";
import StarterKit from "@tiptap/starter-kit";
import { SearchHighlightExtension } from "./search-highlight";
import { TextColor } from "./text-color";

// Tiptap's Strike по умолчанию биндит Mod-Shift-s; постановка задачи требует
// Cmd+Shift+X — переопределяем шорткат отдельным расширением вместо
// StarterKit-варианта.
const StrikeWithShortcut = Strike.extend({
  addKeyboardShortcuts() {
    return { "Mod-Shift-x": () => this.editor.commands.toggleStrike() };
  },
});

export function createEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Disable nodes/marks outside the V1 schema. Everything else (paragraph,
      // bold, italic, bulletList, orderedList, blockquote) stays at its default
      // (enabled).
      codeBlock: false,
      code: false,
      // Link is added separately below (as the `Link` extension) so its
      // autolink/paste options stay explicit; disabling it here avoids a
      // duplicate extension.
      link: false,
      // Strike is added separately below with a custom shortcut.
      strike: false,
      underline: false,
      horizontalRule: false,
    }),
    Link.configure({
      // Open links on click only while the editor is not editable, so a click
      // during editing (or during card drag) never navigates away.
      openOnClick: true,
      autolink: true,
      linkOnPaste: true,
    }),
    StrikeWithShortcut,
    SearchHighlightExtension,
    TextColor,
  ];
}
