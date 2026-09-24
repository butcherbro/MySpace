import { describe, expect, it } from "vitest";
import {
  CARD_KINDS,
  CARD_KIND_INFO,
  CLIPBOARD_COPYABLE_KINDS,
  PASTE_CREATABLE_KINDS,
  type CardKind,
} from "./card-kinds";
import type { CardDto } from "../services/workspace-gateway";

// Every kind a real CardDto can carry, listed independently of card-kinds.ts
// so this test would actually fail if the registry fell out of sync.
const ALL_CARD_DTO_KINDS: CardDto["kind"][] = [
  "note",
  "board_portal",
  "image",
  "embed",
  "filesystem_alias",
  "file",
  "board_shortcut",
];

describe("card-kinds registry", () => {
  it("has exactly one entry per CardDto kind", () => {
    expect(new Set(CARD_KINDS)).toEqual(new Set(ALL_CARD_DTO_KINDS));
    expect(CARD_KINDS.length).toBe(ALL_CARD_DTO_KINDS.length);
  });

  it("gives every CardDto kind a registry entry", () => {
    for (const kind of ALL_CARD_DTO_KINDS) {
      expect(CARD_KIND_INFO[kind]).toBeDefined();
    }
  });

  it("has no entries beyond the declared CardKind union", () => {
    const keys = Object.keys(CARD_KIND_INFO) as CardKind[];
    expect(new Set(keys)).toEqual(new Set(CARD_KINDS));
  });

  it("treats every kind but board_portal as a leaf", () => {
    for (const kind of CARD_KINDS) {
      expect(CARD_KIND_INFO[kind].isLeaf).toBe(kind !== "board_portal");
    }
  });

  it("derives the clipboard-copyable kinds from the registry", () => {
    expect(new Set(CLIPBOARD_COPYABLE_KINDS)).toEqual(
      new Set(CARD_KINDS.filter((k) => CARD_KIND_INFO[k].clipboard !== "none")),
    );
    // Matches App.tsx's Cmd+C eligibility (note/image/board_portal/board_shortcut).
    expect(new Set(CLIPBOARD_COPYABLE_KINDS)).toEqual(
      new Set(["note", "image", "board_portal", "board_shortcut"]),
    );
  });

  it("derives the paste-creatable kinds from the registry", () => {
    expect(new Set(PASTE_CREATABLE_KINDS)).toEqual(new Set(CLIPBOARD_COPYABLE_KINDS));
  });

  it("gives every kind a trashKind that round-trips through CARD_KINDS", () => {
    for (const kind of CARD_KINDS) {
      const trashKind = CARD_KIND_INFO[kind].trashKind;
      expect(trashKind === null || CARD_KINDS.includes(trashKind)).toBe(true);
    }
  });
});
