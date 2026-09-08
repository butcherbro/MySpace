// Transient search-match highlight for the Tiptap editor.
//
// This is UI-only state: it never touches the document, never triggers
// `onUpdate`/autosave, and never changes a revision. Matches are rendered with
// a ProseMirror DecorationSet (inline `<span class="search-highlight">`), so
// the authoritative `documentJson` stays exactly as it was.

import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const searchHighlightKey = new PluginKey("searchHighlight");

function buildDecorations(doc: PMNode, query: string): DecorationSet {
  const q = query.trim().toLowerCase();
  if (!q) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const lower = node.text.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx !== -1) {
      decorations.push(
        Decoration.inline(pos + idx, pos + idx + q.length, { class: "search-highlight" }),
      );
      idx = lower.indexOf(q, idx + q.length);
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const searchHighlightPlugin = new Plugin({
  key: searchHighlightKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, value, _oldState, newState) {
      const query = tr.getMeta(searchHighlightKey);
      if (query !== undefined && query !== null) {
        return buildDecorations(newState.doc, query as string);
      }
      if (tr.docChanged) {
        return value.map(tr.mapping, tr.doc);
      }
      return value;
    },
  },
  props: {
    decorations(state) {
      return searchHighlightKey.getState(state);
    },
  },
});

/** The plugin wrapped as a Tiptap extension, added at editor creation time. */
export const SearchHighlightExtension = Extension.create({
  name: "searchHighlight",
  addProseMirrorPlugins() {
    return [searchHighlightPlugin];
  },
});

/** Applies (or clears, for an empty string) the transient highlight. */
export function setSearchHighlight(editor: Editor, query: string): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, query));
}
