// Tiptap extension configuration: the approved StarterKit subset (plan D2).
// Paragraph, headings 1-3, bold, italic, bullet/ordered lists, blockquote.
//
// Everything outside V1 is explicitly disabled so that pastes and shortcuts
// cannot silently introduce structures (links, code blocks, strike, underline,
// horizontal rules, task items, etc.) into persisted documents before the schema
// and runtime validation catch up.

import StarterKit from "@tiptap/starter-kit";

export function createEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Disable nodes/marks outside the V1 schema. Everything else (paragraph,
      // bold, italic, bulletList, orderedList, blockquote) stays at its default
      // (enabled).
      codeBlock: false,
      code: false,
      link: false,
      strike: false,
      underline: false,
      horizontalRule: false,
    }),
  ];
}
