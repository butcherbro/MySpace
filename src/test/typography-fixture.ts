import { documentToPlainText, plainTextToDocument } from "../editor/document-codec";
import type { BoardSnapshot, CardDto, EmbedCardDto, NoteCardDto } from "../services/workspace-gateway";

// Browser-mock fixture for comparing typography variants on realistic content
// (Russian prose with marks, headings, lists, links, GitHub-style link cards).
// Activated only via `?fixture=typography` — never seeded into real user data.

type Inline = { type: "text"; text: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

const text = (value: string): Inline => ({ type: "text", text: value });
const bold = (value: string): Inline => ({ type: "text", text: value, marks: [{ type: "bold" }] });
const anchor = (value: string, href: string): Inline => ({
  type: "text",
  text: value,
  marks: [{ type: "link", attrs: { href } }],
});

const paragraph = (...content: Inline[]) => ({ type: "paragraph", content });
const listItem = (...content: Inline[]) => ({ type: "listItem", content: [paragraph(...content)] });

function note(id: string, x: number, y: number, width: number, height: number, content: unknown[]): NoteCardDto {
  const documentJson = { type: "doc", content };
  return {
    kind: "note",
    id,
    boardId: "home",
    frame: { x, y, width, height },
    zIndex: 0,
    revision: 1,
    createdAt: Date.UTC(2025, 7, 24),
    groupId: null,
    documentJson,
    plainText: documentToPlainText(documentJson),
    colorToken: "default",
  };
}

function link(
  id: string,
  x: number,
  y: number,
  sourceUrl: string,
  siteName: string,
  title: string,
  description: string,
  descriptionOrigin: "user" | "site",
): EmbedCardDto {
  return {
    kind: "embed",
    id,
    boardId: "home",
    frame: { x, y, width: 320, height: 240 },
    zIndex: 0,
    revision: 1,
    createdAt: Date.UTC(2025, 7, 24),
    groupId: null,
    sourceUrl,
    displayUrl: sourceUrl.replace(/^https?:\/\//, ""),
    siteName,
    title,
    provider: null,
    descriptionJson: plainTextToDocument(description),
    descriptionPlainText: description,
    descriptionOrigin,
    faviconAsset: null,
    previewAsset: null,
    previewOrigin: null,
    metadataStatus: "ready",
    metadataError: null,
  };
}

// Нижний ряд сдвинут с запасом: заметки и ссылки сами подрастают под контент.
const TOP_ROW_Y = 40;
const BOTTOM_ROW_Y = 460;

function typographyCards(): CardDto[] {
  return [
    note("typo-note-ru", 40, TOP_ROW_Y, 420, 240, [
      paragraph(
        text("Ты же знаешь, что нам нужно будет "),
        bold("для каждого автора"),
        text(" делать свой "),
        bold("YouTube-канал"),
        text(". И для этого нам нужна будет не квадратная обложка, а горизонтальная, под формат видео."),
      ),
      paragraph(bold("надо настроить создание каналов и авто наполнение их при выпуске релиза!!!")),
    ]),
    note("typo-note-lmarena", 500, TOP_ROW_Y, 380, 320, [
      { type: "heading", attrs: { level: 2 }, content: [text("Lmarena")] },
      paragraph(anchor("lmarena.ai/leaderboard", "https://lmarena.ai/leaderboard")),
      {
        type: "bulletList",
        content: [
          listItem(
            text("Text — лидеры среди нейросетей для генерации текста. На первом месте "),
            anchor("Gemini 2.5 Pro", "https://deepmind.google/models/gemini/pro/"),
          ),
          listItem(
            text("WebDev — лучшие модели для написания кода и вёрстки сайтов, в лидерах "),
            anchor("Claude Opus 4", "https://www.anthropic.com/claude/opus"),
          ),
          listItem(text("Vision — модели, которые лучше всего понимают изображения и скриншоты")),
          listItem(
            text("Text-to-Image — рейтинг генераторов картинок, где лидирует "),
            anchor("Imagen 4", "https://deepmind.google/models/imagen/"),
          ),
        ],
      },
    ]),
    note("typo-note-en", 920, TOP_ROW_Y, 300, 110, [
      paragraph(text("Ship the typography pass first.")),
      paragraph(text("Compare it against Milanote side by side.")),
    ]),
    link(
      "typo-link-iva",
      40,
      BOTTOM_ROW_Y,
      "https://github.com/smixs/iva-agent",
      "GitHub",
      "iva-agent/docs/ru/use-cases.md at main · smixs/iva-agent",
      "Self-hosted assistant agent with long-term memory, tools and scheduled jobs. Contribute to smixs/iva-agent development by creating an account on GitHub.",
      "site",
    ),
    link(
      "typo-link-flow2api",
      400,
      BOTTOM_ROW_Y,
      "https://github.com/TheSmallHanCat/flow2api",
      "GitHub",
      "GitHub - TheSmallHanCat/flow2api: 一个功能完整的 OpenAI 兼容 API 服务",
      "一个功能完整的 OpenAI 兼容 API 服务，为 Flow 提供统一的接口。 A full-featured OpenAI-compatible API service that wraps Flow behind a single endpoint.",
      "site",
    ),
    link(
      "typo-link-business2api",
      760,
      BOTTOM_ROW_Y,
      "https://github.com/chanhanzhan/business2api",
      "GitHub",
      "GitHub - chanhanzhan/business2api: Demo站点",
      "Demo站点. Contribute to chanhanzhan/business2api development by creating an account on GitHub.",
      "site",
    ),
    link(
      "typo-link-comment",
      1120,
      BOTTOM_ROW_Y,
      "https://lmarena.ai/leaderboard",
      "LMArena",
      "LMArena Leaderboard",
      "Смотреть вкладку Text: там актуальный рейтинг моделей, обновляется каждую неделю.",
      "user",
    ),
  ];
}

export function typographyBoardSnapshot(): BoardSnapshot {
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
    cards: typographyCards(),
    unsortedCards: [],
    connectors: [],
  };
}
