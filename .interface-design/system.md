# MySpace Interface System

## Product intent

MySpace is a Mac-first spatial workspace for one power user. It must feel like a quiet working surface where notes, images, boards, links, and later real filesystem objects can be recognized by position and appearance.

The canvas is the product. Application chrome must support the canvas without competing with it.

The primary daily loop is:

1. Capture an object with one direct action.
2. Place it spatially with minimal ceremony.
3. Return days later and recognize the project from its arrangement.
4. Enter a nested Board without losing orientation.

## Domain language

- **Desk** — the infinite canvas surface.
- **Paper** — a Note card.
- **Portal** — the visual doorway to a nested Board.
- **Trail** — breadcrumbs showing the current Board ancestry.
- **Rail** — the narrow left tool strip.
- **Quick Board** — a future browser-bookmark-like Board link in the top bar.
- **Neighborhood** — a meaningful spatial cluster of related objects.
- **Context tools** — tools for the currently hovered or selected object.

## Desired character

Quiet, spatial, precise, lightweight, and personal. The interface may borrow Milanote's successful spatial grammar, but it should feel more native to macOS and less like a hosted SaaS product.

**Direction accepted:** 2026-09-05. Preserve Milanote's density and ease of
spatial recognition, while making MySpace quieter, more compact, and more native
to macOS. Copy the visual principles, not Milanote's branding or SaaS chrome.

Use the macOS system font stack intentionally. Do not introduce a web font for V1.

## Signature element

The Board Portal is the product signature. It is a compact colored or image-covered doorway into another complete spatial surface. Portal identity should be recognizable before its label is read.

Board Portals may later use custom covers, but the fallback must remain attractive: a muted color tile, a short symbol, a title, and compact content counts.

## Rejected defaults

- No permanent folder tree. Use Board Portals and breadcrumbs.
- No full-width action toolbar filled with buttons. Use a narrow left tool rail.
- No dashboard grid. Home is also a free spatial Board.
- No identical rounded SaaS card treatment for every object type. Each card type has its own material grammar.
- No emoji as production tool icons. Use one coherent outline icon set.
- No always-visible inspector. Context controls appear only when relevant.
- No visible placeholders for unimplemented future features.

## Layout anatomy

The application shell has three regions:

```text
┌──────────────────────────────────────────────────────────────┐
│ Trail / breadcrumbs   Quick Boards (future)   Search  ↶  ↷ │
├─────┬────────────────────────────────────────────────────────┤
│     │                                                        │
│Rail │                 Infinite canvas                        │
│     │                                                        │
└─────┴────────────────────────────────────────────────────────┘
```

### Top navigation bar

- Height: `44px` inside the web content area.
- Background: `--chrome-surface` at 96% opacity; no decorative blur in V1.
- Bottom edge: one `--edge-subtle` hairline.
- Left: full breadcrumb trail, including the current Board.
- Immediately after breadcrumbs: reserved Quick Boards region. It occupies no width when empty.
- Right: Search, Undo, Redo.
- Do not repeat the current Board title in the center when it is already the final breadcrumb.
- Buttons are icon-only at rest with macOS-style tooltips and keyboard hints.

### Left tool rail

- Width: `56px`.
- Starts below the top navigation bar and spans the canvas height.
- Background: `--chrome-surface`.
- Right edge: one `--edge-subtle` hairline.
- Default tools, top to bottom: Note, Link, Board, Image.
- Each tool occupies a `48px` row with a `20px` icon and an optional 10px label.
- Tooltips state the action and shortcut, for example `New note  N`.
- The rail never represents Board hierarchy.
- The rail may change mode, but its width and physical position never move.

### Canvas

- Fills all space right of the rail and below the top bar.
- Background: `--desk` with low-contrast dots using `--desk-dot`.
- Dot gap: `20px` at zoom 1; React Flow dot size: `3px` (rendered radius `1.5px`). The light Desk calibration is
  sampled from the accepted Milanote reference: `#ebedee` surface with `#dfe1e2`
  dots. Do not reduce the dot to a subpixel treatment on Retina displays.
- No permanent minimap, zoom widget, tips panel, or inspector.
- Empty-state copy is quiet and placed near the initial working area, not centered like an onboarding page.

### Dense-board calibration

Dense Boards are the primary design test, not an edge case. A crowded Desk remains
readable because hierarchy comes from object silhouette and spatial grouping rather
than large gaps or heavy containers.

- Chrome recedes behind content; it must never be the strongest contrast on screen.
- Notes, Images, Links, and Portals remain recognizable by shape/material when text
  is too small to read at the current zoom.
- Cards may sit close together without merging visually; use quiet depth and material
  changes instead of permanent borders.
- Keep surrounding card chrome minimal so screenshots and long notes can occupy most
  of their footprint.
- Validate every visual slice with a fixture containing at least twelve Portals and a
  mixed set of long Notes, Images, and Link Cards at once.

## Rail modes

The rail is a stable container with context-dependent contents.

### `create`

The default mode. Shows Note, Link, Board, and Image creation tools.

### `note-context`

Shown when a Note is deliberately hovered, selected, or edited. Initial tools:

- Bold while editable text owns focus.
- Note background color.
- Text color, only while the rich-text editor owns focus or a text selection exists.
- Marker/highlight color is a later text-selection tool and is distinct from text color.
- Return to creation tools.

Tags are a future note-context tool. Do not render a disabled Tags button before tag persistence and filtering exist.

### Future modes

- `image-context`: replace image, fit mode, caption, reveal original.
- `portal-context`: color/cover, rename, add to Quick Boards.
- `multi-selection`: align, distribute, group actions when those behaviors exist.

### Hover handoff contract

A naive CSS hover cannot control the rail because the rail would revert while the pointer travels from the card to the rail.

- Entering an eligible card starts a `120ms` intent delay.
- After the delay, the rail shows that card's contextual tools.
- The context remains active while the pointer is over either the source card or the rail.
- Leaving both begins a `400ms` grace period before returning to `create`.
- Entering the rail during the grace period cancels the reset.
- A selected or actively edited card pins its context; it does not depend on hover.
- `Escape` exits the pinned context and returns focus to the canvas.
- Rapidly crossing cards must not animate or swap the rail repeatedly.
- Use an opacity/translate transition of at most `100ms`; never resize the rail.

This behavior should be implemented as application state, not pure CSS selectors.

## Icon language

Use one outline family with rounded line caps, optical size near 20px, and stroke weight around 1.7px. Suitable semantic shapes:

- Note: `StickyNote` or a simple lined sheet.
- Link: `Link2`.
- Board: `LayoutGrid` without graph handles.
- Image: `ImagePlus`.
- Search: `Search`.
- Undo/Redo: `Undo2` / `Redo2`.
- Return from context: `ArrowLeft`.
- Quick Board: `Bookmark`.

Do not mix filled glyphs, emoji, platform-dependent Unicode symbols, and outline icons in the same rail. Create a local `Icon` boundary so the source library can be replaced later.

## Color tokens

```css
:root {
  color-scheme: light dark;

  --desk: #ebedee;
  --desk-dot: #dfe1e2;
  --chrome-surface: rgba(255, 255, 255, 0.96);
  --paper: #fffefa;
  --paper-raised: #ffffff;

  --ink: #252927;
  --ink-secondary: #5f6763;
  --ink-tertiary: #929995;
  --ink-muted: #bdc2bf;

  --edge-subtle: rgba(54, 63, 58, 0.10);
  --edge-strong: rgba(54, 63, 58, 0.20);
  --edge-focus: #527a6a;
  --focus-halo: rgba(82, 122, 106, 0.18);

  --portal-terracotta: #c77b55;
  --portal-moss: #899b71;
  --portal-sky: #72a9c7;
  --portal-sand: #c3a66d;
  --portal-ink: #657482;

  --link: #cf4f2f;
  --link-hover: #a83e27;

  --note-yellow: #fff2b8;
  --note-rose: #f7d7d3;
  --note-blue: #dcecf2;
  --note-green: #dfead9;
  --note-lilac: #e8dff0;

  --danger: #b42318;
  --danger-surface: #fef3f2;

  --shadow-paper: 0 1px 2px rgba(31, 37, 33, 0.08),
                  0 5px 16px rgba(31, 37, 33, 0.05);
  --shadow-hover: 0 2px 4px rgba(31, 37, 33, 0.10),
                  0 8px 22px rgba(31, 37, 33, 0.07);
  --shadow-menu: 0 8px 28px rgba(20, 24, 22, 0.18);
}
```

Dark mode should be token-driven, not implemented with card-specific overrides scattered through component CSS.

## Typography

```css
--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
--font-content: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
```

Use `-webkit-font-smoothing: antialiased` and
`-moz-osx-font-smoothing: grayscale` at the application root. Do not force a web
font or use ultra-light weights that become fragile on a Retina canvas.

- UI labels: 12–13px, regular or medium.
- Note body: 14px, line-height 1.48.
- Portal title: 12px medium, one line by default.
- Metadata/counts: 10–11px, `--ink-tertiary`.
- Avoid heavy bold text in chrome.

## Geometry and spacing

- Base spacing unit: `4px`.
- Note radius: `5px`.
- Image radius: `4px` only where a caption surface creates an outer card.
- Portal tile radius: `11px`.
- Control radius: `6px`.
- Menu radius: `8px`.
- Standard note padding: `12px 14px`.
- Small interactive target: never below `32px`; rail targets are `40–48px`.

## Card grammar

### Note

- Paper rectangle with a small radius and quiet shadow.
- No permanent title bar, border controls, or drag handle.
- A normal click-release enters editing immediately.
- Click-hold plus movement drags the Note.
- While editing, text gestures select text; the outer card frame remains the move surface.
- Selection: `1px` focus edge plus a subtle halo. Do not use React Flow's default bright blue rectangle.
- Resize handle is invisible until hover or selection, then appears in the lower-right corner.
- Background color applies to the whole paper surface.
- Text color is a rich-text mark and is available only in editor context.

### Image

- The image is the dominant surface; avoid an unnecessary white frame.
- A caption adds a compact paper strip below the image.
- Preserve aspect ratio by default during resize. Holding a modifier may enable free resize later.
- Double click image opens preview; caption editing uses the same draft system as Notes.

### Board Portal

- Compact, centered, and more saturated than content cards.
- Default tile: `60px` square inside a `112–124px` footprint.
- Title and counts sit below the tile; the outer footprint itself has no white card background.
- Single click selects; click-hold-drag moves; double click or Enter opens.
- Hover slightly lifts the tile and strengthens its color; selection outlines the whole footprint.
- A custom cover replaces the color field but preserves the same silhouette.

### Link card

- V1 card: replaceable preview image, favicon/source row, title, and editable description.
- The preview image is edge-to-edge at the top; content below uses compact paper padding.
- Raw URLs are fallback content, not the primary presentation.
- A Note containing exactly one valid URL converts once at Enter or blur. Mixed text or multiple URLs remain rich-text Notes with inline links.
- After conversion, the type is stable. The editable body may grow like a Note without implicitly converting the Link Card back into a Note.
- The Link body reuses the versioned rich-text document format and supports Bold in the first interface slice.
- Preview replacement and Board cover replacement accept images from the macOS clipboard through explicit contextual actions.
- Exact behavior and data rules are defined in `docs/specs/link-card-and-clipboard.md`.
- Link creation belongs in the default rail even before provider-specific previews exist.

## Creation behavior

- Clicking a rail tool creates an object near the visible viewport center, not at a fixed board coordinate.
- Repeated creations cascade by `24px` and search for nearby free space to avoid exact overlap.
- Dragging a rail tool onto the canvas may later provide exact placement; the component API should not prevent it.
- Newly created Notes immediately enter editing.
- Newly created Boards immediately enter inline title rename.
- Newly created Links open a compact URL input anchored at the intended card position.
- Image opens the native picker; drag-and-drop from Finder remains the fastest exact-placement path.

## Top navigation behavior

### Breadcrumbs

- Always begin with Home and end with the current Board.
- Home is the single navigation control for returning to the root workspace. It is always clickable, including while Home is current; activating it navigates to the Home Board and restores its saved viewport.
- Do not render a separate Home button anywhere in the top bar, rail, or application header.
- Use chevrons or restrained slashes consistently.
- At deep levels, preserve Home and the final two Boards; collapse the middle into an accessible menu.
- Breadcrumb clicks navigate without altering the canvas layout.

### Quick Boards — future

Quick Boards are browser-bookmark-like navigation links, not Board Shortcut cards and not hierarchy.

- The region follows breadcrumbs on the same line.
- It is hidden when empty.
- Dragging a Board Portal toward the top bar reveals a highlighted drop zone.
- Dropping creates a Quick Board reference; it never moves or duplicates the Board.
- A Quick Board uses a compact color/cover favicon plus a short title.
- Overflow collapses into a menu instead of wrapping the top bar.
- Reordering is drag-based.

The shell should reserve a component slot now, but persistence and visible UI are deferred.

### Search

Search is mandatory.

- Trigger: top-right Search icon or `Command-K`.
- Opens a centered palette below the top bar, approximately `560px` wide.
- Searches Board titles and Note plain text first; future card types join through a shared result contract.
- Results are grouped by Boards and content.
- Each result shows its Board trail so identical note text remains orientable.
- Opening a result navigates to its Board, centers the card, selects it, and briefly pulses the focus edge.
- Search must not become a permanent sidebar or replace the visual Home Board.

### Undo and redo

- Top-right icon buttons with tooltips and keyboard hints.
- Disabled state is visibly quiet and non-interactive.
- The editor keeps ownership of text undo while it has focus; otherwise the controls act on canvas/workspace commands.

## Menus and contextual surfaces

- Context menus use `--paper-raised`, `--shadow-menu`, 8px radius, and 4px outer padding.
- Standard context-menu width is `220–260px`; rows are `32–34px` high with a
  left-aligned label and a right-aligned shortcut column.
- Separate semantic groups with `--edge-subtle` hairlines. Do not render a separator
  before or after an empty group.
- Menu content is type-aware. A Board Portal exposes Board actions; a Note, Image, or
  Link exposes Card actions. Existing `Copy MySpace Link` and Image-only
  `Copy File Path` actions remain available after visual refactoring.
- Destructive actions are separated and use `--danger`, not a fully red menu.
- Color selection uses a compact popover attached to the rail button.
- Popovers must remain inside the window and close on Escape or outside click.

## Motion

- Hover/selection transitions: 80–120ms.
- Rail mode transition: maximum 100ms.
- Menu enter: 120ms opacity and 4px translation.
- No springy card movement, decorative page transitions, or animated background.
- Respect `prefers-reduced-motion`.

## Accessibility and Mac behavior

- All rail and top-bar commands must be keyboard reachable.
- Every icon-only control needs an accessible name and tooltip.
- Focus rings must be visible without resembling a browser default outline.
- Hit targets should remain usable on a trackpad.
- `Command-K`: search.
- `Command-Z` / `Command-Shift-Z`: undo/redo according to focus ownership.
- `N`: new Note when the canvas owns focus.
- `B`: new Board when the canvas owns focus.
- `Escape`: exit contextual mode or editor, then return focus to canvas.

## Visual acceptance checks

At 1512×982 CSS pixels and Retina scale:

- The canvas occupies at least 92% of the non-titlebar window area.
- The top bar and rail read as one quiet L-shaped chrome frame.
- Creation buttons are absent from the top bar.
- Notes visually read as paper, images as images, and Board Portals as doorways.
- At least twelve Portals can be visible without the chrome dominating the screen.
- Hover, selected, editing, dragging, saving, and error states are distinguishable without large labels.
- No default React Flow blue selection treatment leaks into the product.
- No three-column layouts, large empty-state hero, gradients, decorative blobs, emoji tool icons, or excessive 12–16px card rounding appear.
