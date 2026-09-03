// Minimal DOM polyfills required by ProseMirror / Tiptap in jsdom.
// jsdom lacks `elementFromPoint`, `Range.getClientRects`, and
// `Range.getBoundingClientRect`, which ProseMirror's view (and its
// mouse/selection handling) calls during layout and coordinate lookups.

if (!document.elementFromPoint) {
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
}

if (typeof Range !== "undefined") {
  const emptyRect = {
    x: 0,
    y: 0,
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }

  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => emptyRect;
  }
}
