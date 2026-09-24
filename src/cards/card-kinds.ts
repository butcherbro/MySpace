// Single source of truth for the frontend's persisted card kinds.
//
// `CardDto["kind"]` (services/workspace-gateway.ts) mirrors the backend's
// domain kinds. Everywhere else on the frontend that needs "the list of card
// kinds" (the canvas's own vocabulary, Trash entries, clipboard/paste
// eligibility) derives from `CARD_KINDS`/`CARD_KIND_INFO` here instead of
// re-listing the seven kinds by hand (P1.3 step 4).

import type { CardDto } from "../services/workspace-gateway";

/** Every persisted card kind, in the order the registry/renderer checks them. */
export const CARD_KINDS = [
  "note",
  "board_portal",
  "image",
  "embed",
  "filesystem_alias",
  "file",
  "board_shortcut",
] as const;

export type CardKind = (typeof CARD_KINDS)[number];

// Compile-time guarantee that this list and `CardDto["kind"]` never drift
// apart: if either union gains/loses a member without the other, this file
// fails to typecheck.
type _CardKindsMatchCardDto = [CardDto["kind"]] extends [CardKind]
  ? [CardKind] extends [CardDto["kind"]]
    ? true
    : never
  : never;
const _cardKindsMatchCardDto: _CardKindsMatchCardDto = true;
void _cardKindsMatchCardDto;

/** How a card copies into the internal card clipboard (app/card-clipboard.ts). */
export type ClipboardCapability =
  /** Not copyable via the internal card clipboard. */
  | "none"
  /** Copies as a structured `CopiedCard` entry that can be pasted back. */
  | "structured";

export interface CardKindInfo {
  /**
   * Whether the card is a plain leaf card. `board_portal` is the one
   * non-leaf kind: it leads to a whole sub-board rather than holding content
   * itself.
   */
  isLeaf: boolean;
  /**
   * The `TrashItem`/`TrashItemInput` kind a card of this kind is trashed as,
   * or `null` if it has no direct Trash entry of its own (e.g. it is only
   * ever trashed as part of its owning board). Every current kind trashes as
   * itself.
   */
  trashKind: CardKind | null;
  /** Whether/how the kind can be copied into the internal card clipboard. */
  clipboard: ClipboardCapability;
  /** Whether a paste can create a new card of this kind. */
  paste: boolean;
}

export const CARD_KIND_INFO: Record<CardKind, CardKindInfo> = {
  note: { isLeaf: true, trashKind: "note", clipboard: "structured", paste: true },
  board_portal: { isLeaf: false, trashKind: "board_portal", clipboard: "structured", paste: true },
  image: { isLeaf: true, trashKind: "image", clipboard: "structured", paste: true },
  embed: { isLeaf: true, trashKind: "embed", clipboard: "none", paste: false },
  filesystem_alias: { isLeaf: true, trashKind: "filesystem_alias", clipboard: "none", paste: false },
  file: { isLeaf: true, trashKind: "file", clipboard: "none", paste: false },
  board_shortcut: { isLeaf: true, trashKind: "board_shortcut", clipboard: "structured", paste: true },
};

/** Kinds that can be copied into the internal card clipboard (App.tsx's Cmd+C). */
export const CLIPBOARD_COPYABLE_KINDS: readonly CardKind[] = CARD_KINDS.filter(
  (kind) => CARD_KIND_INFO[kind].clipboard !== "none",
);

/** Kinds a paste can create. */
export const PASTE_CREATABLE_KINDS: readonly CardKind[] = CARD_KINDS.filter((kind) => CARD_KIND_INFO[kind].paste);

/** The `TrashItem`/`TrashItemInput` kind union, derived from the registry. */
export type TrashKind = Exclude<CardKindInfo["trashKind"], null>;
