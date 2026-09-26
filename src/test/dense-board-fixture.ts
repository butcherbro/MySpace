import type {
  AssetDto,
  BoardPortalDto,
  BoardSnapshot,
  EmbedCardDto,
  FilesystemAliasDto,
  ImageCardDto,
  NoteCardDto,
} from "../services/workspace-gateway";

// Test-only deterministic dense board. Activated only via the browser-test
// `?fixture=dense` query parameter — never seeded into real user data.

const fakeAsset: AssetDto = {
  id: "fixture-asset",
  fileName: "shot.png",
  mimeType: "image/png",
  width: 640,
  height: 480,
  sizeBytes: 0,
  filePath: "fixture-asset.png",
};

function portal(id: string, x: number, y: number, color: string, symbol: string | null): BoardPortalDto {
  return {
    kind: "board_portal",
    id,
    boardId: "home",
    frame: { x, y, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    target: {
      id: `board-${id}`,
      boardRevision: 1,
      title: `Board ${id}`,
      colorToken: color,
      symbol,
      childBoardCount: 0,
      childCardCount: 0,
      coverAsset: null,
    },
  };
}

function note(id: string, x: number, y: number, text: string): NoteCardDto {
  return {
    kind: "note",
    id,
    boardId: "home",
    frame: { x, y, width: 240, height: 120 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc" },
    plainText: text,
    colorToken: "default",
  };
}

function image(id: string, x: number, y: number, caption: string): ImageCardDto {
  return {
    kind: "image",
    id,
    boardId: "home",
    frame: { x, y, width: 240, height: 180 },
    zIndex: 0,
    revision: 1,
    asset: fakeAsset,
    captionJson: { type: "doc" },
    captionPlainText: caption,
  };
}

function folderAlias(id: string, x: number, y: number, pathHint: string, displayName: string): FilesystemAliasDto {
  return {
    kind: "filesystem_alias",
    id,
    boardId: "home",
    frame: { x, y, width: 280, height: 180 },
    zIndex: 0,
    revision: 1,
    targetKind: "folder",
    pathHint,
    displayName,
    originDeviceId: "mock-device",
    originDeviceName: "This Mac",
    local: true,
  };
}

function link(id: string, x: number, y: number, title: string): EmbedCardDto {
  return {
    kind: "embed",
    id,
    boardId: "home",
    frame: { x, y, width: 280, height: 200 },
    zIndex: 0,
    revision: 1,
    sourceUrl: "https://example.com",
    displayUrl: "example.com",
    siteName: "Example",
    title,
    provider: null,
    descriptionJson: { type: "doc" },
    descriptionPlainText: "",
    descriptionOrigin: null,
    faviconAsset: null,
    previewAsset: null,
    previewOrigin: null,
    metadataStatus: "ready",
    metadataError: null,
  };
}

/**
 * P1.8 budget fixture: `?fixture=dense&notes=N` replaces the mixed dense board
 * with N note cards on a 40-column grid, each carrying a real (formatted)
 * document so the idle static renderer does real work. Additive: without
 * `notes`, `?fixture=dense` is unchanged (the visual-shell screenshots use it).
 */
export const DENSE_NOTE_COLUMNS = 40;
export const DENSE_NOTE_PITCH = { x: 260, y: 140 } as const;

function requestedNoteCount(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("notes");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : null;
}

export function denseNotes(count: number): NoteCardDto[] {
  return Array.from({ length: count }, (_, i) => {
    const text = `Note ${i}: a short line of text`;
    return {
      ...note(
        `dense-note-${i}`,
        40 + (i % DENSE_NOTE_COLUMNS) * DENSE_NOTE_PITCH.x,
        40 + Math.floor(i / DENSE_NOTE_COLUMNS) * DENSE_NOTE_PITCH.y,
        text,
      ),
      documentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: `Note ${i}`, marks: [{ type: "bold" }] },
              { type: "text", text: ": a short line of text" },
            ],
          },
        ],
      },
    };
  });
}

export function denseBoardSnapshot(): BoardSnapshot {
  const noteCount = requestedNoteCount();
  const colors = ["terracotta", "moss", "sky", "sand", "ink", "terracotta"];
  const portals = Array.from({ length: 12 }, (_, i) =>
    portal(
      `portal-${i}`,
      (i % 4) * 160 + 40,
      Math.floor(i / 4) * 150 + 40,
      colors[i % colors.length],
      null,
    ),
  );
  return {
    board: {
      id: "home",
      title: "Home",
      parentBoardId: null,
      revision: 1,
      colorToken: "ink",
      symbol: null,
      coverAsset: null,
    },
    breadcrumbs: [{ id: "home", title: "Home" }],
    viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
    cards: noteCount !== null ? denseNotes(noteCount) : [
      ...portals,
      note("note-0", 40, 500, "A longer note used to check dense scanability and text wrapping."),
      note("note-1", 320, 500, "Second note."),
      image("image-0", 40, 640, "Screenshot of a dashboard"),
      image("image-1", 320, 640, "Another screenshot"),
      link("link-0", 40, 820, "Example link"),
      link("link-1", 360, 820, "Another link"),
      folderAlias("folder-0", 40, 1040, "/Users/me/Research", "Research"),
    ],
    unsortedCards: [],
  };
}