# Link Card and Clipboard Interaction Specification

## Status

This document is the product and interaction source of truth for automatic Link Card creation, editable link previews, and clipboard image replacement.

## Product intent

A pasted URL should become visually recognizable with almost no effort. A URL that is part of a larger thought remains ordinary rich text. The system must never destroy user text or repeatedly guess a card type while the user is typing.

## Terminology

- **Candidate Note** — a Note being edited whose semantic content may qualify for conversion.
- **Link Card** — the user-facing name for the dedicated `embed` card kind, with a source URL, cached metadata, editable title/body, favicon, and replaceable preview image.
- **Semantic content** — editor content after ignoring empty paragraphs and leading/trailing whitespace.
- **Finalize intent** — pressing Enter on a single-URL Candidate Note or moving focus away from it.

## Exact conversion predicate

A Note qualifies for automatic conversion only when all conditions are true at finalize intent:

1. Its semantic content contains exactly one text value.
2. That value is exactly one valid absolute `http://` or `https://` URL after trimming outer whitespace.
3. There are no other characters, words, list markers, embedded images, or non-empty blocks.
4. There is exactly one URL. Two or more URLs never auto-convert.

Whitespace-only paragraphs, spaces, and a trailing newline do not disqualify the candidate.

Examples:

| Note content | Result at Enter/blur |
|---|---|
| `https://example.com` | Convert to Link Card |
| `  https://example.com  ` | Convert to Link Card |
| `https://example.com` plus an empty trailing paragraph | Convert to Link Card |
| `Read https://example.com` | Remain Note; URL is an inline link |
| `https://a.com` followed by `https://b.com` | Remain Note; two inline links |
| `https://example.com hello` | Remain Note; inline link plus text |
| malformed or partial URL | Remain Note as text |
| URL plus an image or list item | Remain Note |

Do not treat email addresses, `file://`, workspace asset URLs, or local filesystem paths as automatic web Link Cards.

## Conversion trigger

1. Pasting a URL into an otherwise empty Note marks it as a candidate but does not immediately replace the editor.
2. If the user types any additional semantic content, the candidate is cancelled and the URL remains an inline link.
3. Pressing Enter while the predicate is true finalizes conversion instead of inserting another empty paragraph.
4. Blurring the Note while the predicate is true also finalizes conversion.
5. If metadata loading fails, conversion still succeeds: the Link Card retains the source URL and shows a retryable fallback state.

There is no idle timer that converts a Note while the user is still typing.

## State transition model

```text
Note(editing)
  ├─ paste/type mixed content ───────────────> Note(with inline links)
  ├─ paste two or more URLs ─────────────────> Note(with inline links)
  └─ one valid URL + Enter/blur ─────────────> LinkCard(fetching)
                                                  ├─ metadata success -> LinkCard(ready)
                                                  └─ metadata failure -> LinkCard(fallback)
```

Once conversion succeeds, the card kind is stable. Ordinary title or body edits never convert the Link Card back into a Note, and there is no content-driven reverse conversion.

The Link Card may grow into a note-like object by accumulating rich-text body content beneath its preview. It still remains a Link Card with a source URL and preview identity.

## Answers to the boundary questions

1. **One URL plus spaces or empty line:** preview, because outer whitespace and empty blocks are ignored.
2. **Two URLs:** one Note containing two clickable inline links; never one or two automatic previews.
3. **Text added before finalization:** remain a Note. Text edited after conversion changes Link Card title/description and does not destroy the preview.
4. **Part of the URL deleted before finalization:** remain a Note as text. After conversion, source URL editing is an explicit validated action; an invalid source cannot be committed.

## Transaction and data safety

Automatic conversion is one backend transaction that preserves:

- card id;
- Board id;
- frame and z-index;
- Trash/undo identity;
- creation timestamp.

The transaction changes the card kind and moves the content from Note storage to Link Card storage. A crash must not leave both a Note and a Link Card or neither.

The original source URL is authoritative. Metadata and images are cached decorations and must not be required to open the link.

## Link Card data contract

Application-level shape:

```ts
type LinkMetadataStatus = "pending" | "ready" | "failed";

interface EmbedCardDto {
  kind: "embed";
  id: string;
  boardId: string;
  frame: CardFrame;
  zIndex: number;
  revision: number;
  sourceUrl: string;
  displayUrl: string;
  siteName: string | null;
  title: string;
  descriptionJson: NoteDocument;
  descriptionPlainText: string;
  faviconAsset: AssetDto | null;
  previewAsset: AssetDto | null;
  previewOrigin: "fetched" | "custom" | null;
  metadataStatus: LinkMetadataStatus;
  metadataError: string | null;
}
```

Use the existing `embed_cards` table and Rust `EmbedCardDto`. Do not introduce a competing `link_cards` table or a second `link` card kind. `LinkCard` may remain the React presentation component name because that is the user-facing concept.

Keep two independent asset references: the existing `asset_id` is the current preview image, and a new nullable `favicon_asset_id` stores the favicon. Add `preview_origin` (`fetched` or `custom`) so a later metadata refresh never overwrites a user-selected preview. V1 does not retain both the fetched and custom previews simultaneously.

Persist values, not remote rendering dependencies. Favicon and preview images should be copied into managed asset storage after fetch so existing cards remain recognizable offline.

Do not store Link Card title and description inside Note `documentJson`. The title is an Embed Card field. The body uses the same versioned rich-text document format as Notes, but lives in `embed_cards` and has its own revision-safe update command. Fetched plain metadata description seeds `descriptionJson` and `descriptionPlainText`.

## Metadata acquisition

Metadata acquisition runs behind the Tauri/Rust boundary to avoid WebView CORS behavior and to centralize limits.

V1 extraction order:

1. Open Graph image/title/description/site name.
2. Standard HTML title and meta description.
3. Page favicon from declared icon links.
4. Origin `/favicon.ico` as a fallback.
5. Source host and URL as the final no-network fallback.

For known providers such as YouTube, an official public oEmbed endpoint may be used before generic HTML parsing when it materially improves title/channel/thumbnail quality.

Network requirements:

- only `http` and `https` input schemes;
- bounded redirects;
- connection and total timeout;
- bounded response size;
- accepted image MIME types only;
- metadata errors never delete or block the source URL;
- retry is explicit and safe.

## Visual anatomy

The provided Milanote reference establishes this hierarchy:

1. Large edge-to-edge preview image.
2. Small favicon plus muted, truncated source URL.
3. Prominent clickable title.
4. Editable description.

MySpace treatment:

- Default width: `320px`; minimum `240px`; maximum manual width before free resize: `520px`.
- Preview ratio: prefer extracted image ratio within a maximum visual height; default crop is `16:9` using `object-fit: cover`.
- Preview image is flush with the top and side edges.
- Content padding: `14px 16px 16px`.
- Favicon: `16×16px`, 3px radius, followed by one-line `--ink-tertiary` display URL.
- Title: 15px medium, two lines maximum at rest, `--link` color, underline only on hover/focus.
- Description/body: the shared rich-text editor at 14px and line-height 1.48, `--ink-secondary`, unrestricted height up to the card frame.
- Card: `--paper-raised`, 5px radius, quiet border and `--shadow-paper`.
- Loading: preserve the final card silhouette with subtle neutral skeleton fields; do not use a spinner over the canvas.
- Failure: show URL, a short `Preview unavailable` label, and a contextual Retry action.

## Editing and navigation

- Single click the outer card selects it.
- Click-hold-drag moves it.
- Clicking the title or source row opens the source URL using the native opener.
- Clicking the description/body enters inline rich-text editing.
- Title editing is available from the Link contextual rail or context menu so the navigation target is not ambiguous.
- `Enter` on a selected card opens the source URL unless a text editor owns focus.
- Editing title or body never triggers a metadata refetch or card-kind change.
- `Edit source URL` is a separate validated action; committing a new source starts a new metadata fetch while retaining existing display values until replacement succeeds.

## Replaceable preview image

The preview image supports:

- `Replace from Clipboard`;
- `Choose Image…`;
- `Remove Preview`.

Fast clipboard path:

1. Copy or capture an image to the macOS clipboard.
2. Right-click the Link Card preview, or select the preview replacement tool in the contextual rail.
3. Choose `Replace from Clipboard`.
4. Validate the clipboard contains a supported image.
5. Import it as a managed asset and atomically replace `previewAsset`.

Replacing or removing a preview makes the previous asset eligible for normal orphan-asset cleanup only after the card update commits. A future `Refetch Preview` action may download the source image again; V1 does not keep a hidden second preview asset solely for restoration.

## Minimum rich-text formatting

The shared editor used by Notes and the Link Card body must support Bold in the first interface slice:

- `Command-B` toggles Bold while an editor owns focus.
- A Bold button contextual control appears in the left rail while editable text is active.
- The control reflects active/mixed state from the current selection.
- Bold is stored in the existing versioned Tiptap JSON; no parallel HTML or Markdown field is introduced.

Later formatting layers:

- text color;
- marker/highlight color behind selected text;
- whole-Note paper/background color.

Text color and marker highlight are rich-text marks. Whole-Note color is card appearance metadata. They must not share one ambiguous `color` field.

## Board Portal cover from clipboard

Board Portal cover replacement follows the same vocabulary:

- `Set Cover from Clipboard`;
- `Choose Cover…`;
- `Remove Cover` and return to its color/symbol fallback.

The action lives in the Portal contextual rail and the tile context menu. Clipboard image paste must import a managed asset; do not persist raw clipboard bytes in SQLite.

## Global clipboard ownership

Clipboard behavior is resolved by focused context, in this order:

1. Active rich-text editor owns paste and keeps text/inline links inside the Note.
2. An explicit Link preview or Board cover replacement command reads the clipboard image and replaces that target.
3. Canvas focus plus clipboard image creates a new Image Card at the visible working area.
4. Canvas focus plus one valid URL creates a Link Card candidate at the visible working area.
5. Unsupported clipboard content produces no destructive change and a small actionable message.

Selecting a Link Card or Board Portal alone does not silently redirect every `Command-V` to its cover. Replacement requires the explicit contextual/context-menu action, preventing accidental loss when the user intended to create a new Image Card.

## Future double-click creation

Double-clicking empty canvas may create and immediately edit a Note, matching the reference application. It is a desirable low-friction shortcut but does not block the first Link Card slice.

## Acceptance scenarios

1. Paste one URL into an empty Note, press Enter, and receive a Link Card in the exact same frame.
2. Paste one URL, type one additional word, press Enter, and keep a Note with one inline link.
3. Paste two URLs on separate lines and keep a Note with two inline links.
4. Paste one URL and click empty canvas; conversion occurs on blur.
5. Disable network, convert a URL, and retain an openable fallback Link Card.
6. Add paragraphs and Bold text to the Link Card body and verify it remains a Link Card.
7. Replace preview from clipboard, restart the app, and verify the custom image remains.
8. Set a Board Portal cover from clipboard, restart, enter the Board, return, and verify the cover remains.
9. Paste an image while canvas owns focus and verify a new Image Card is created rather than overwriting a selected Portal.
10. Undo Note-to-Link conversion and restore the original Note with its URL text and frame.
