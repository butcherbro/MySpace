# Todo — backlog

> Status is **not** tracked here. The single source of truth is
> `tasks/current-state.md`; evidence is in
> `docs/testing/v1-stabilization-report.md`. This file is the backlog: what is
> planned, why, and what it depends on. Keep wishlist work separate from
> correctness debt — the latter lives in the report.

## Open items carried over from the stabilization plan

- [ ] **Packaged macOS acceptance** (Task 20): run every checklist in
  `docs/testing/`, including the CSP, close-flush and folder-shortcut ones.
  `tauri dev` is not evidence for bookmark durability or for the CSP.
- [ ] **Architect confirmations still open**: the exact `connect-src` requirement
  for macOS WKWebView, and whether the favicon source URL should be stored
  durably (ADR-0008).
- [ ] **Verify live Link Card auto-fit and YouTube channel Retry** outside hot
  reload.
- [ ] **(optional) expose a manual restore command** in the UI or CLI, wrapping
  `scripts/recover-missing-asset.py`.
- [ ] **Explicit clipboard replacement** for Link previews and Board Portal
  covers.

## Delivered since this list was written

Recorded so the backlog does not re-request them: mandatory Search (global scope,
grouped results, on-board highlight), the contextual note rail, group and mixed
moves (now one atomic command, ADR-0007), the Quiet Desk visual shell, board
tabs, real filesystem shortcuts (folder and file cards), the Unsorted panel, Board
cover editing, "Copy MySpace Link", Empty Trash with asset garbage collection,
favicon deduplication, the atomic mixed-selection move, and the stabilization
plan itself. Board icon and color editing did **not** ship — see backlog 3.

## Backlog — user-requested features (not yet scheduled)

Status key: `next` = scheduled after its listed prerequisites; `discuss` = needs another
architecture pass before sizing; `blocked` = depends on another item.

### 1. Agent surface — address a Board / pass it to an agent

- `next` — A Board is addressed by stable `myspace://board/<id>`, not a filesystem
  path. A concrete Rust `WorkspaceService` owns typed queries/commands; Tauri and a
  local MCP-over-stdio server are adapters. Full decision and safety gates are in
  `docs/decisions/0005-provider-agnostic-agent-surface.md`.
- User intent (verbatim intent): an agent should be able to *add* 10 YouTube links
  into a Board (they become Link Cards with previews), and conversely the user
  builds a Board of screenshots/notes/links and hands it to an agent to read.
- Sub-request: "copy path to object" (right-click) — a real file path exists per
  asset (`assets/<asset_id>.*`), so per-object path is straightforward; per-board
  path is NOT (no folder).
- Related: `tasks/lessons.md` north-star already records "agent acts through the
  same typed domain commands as the UI, not direct SQLite".
- Safety gate: agent writes remain disabled until validated backup restore,
  idempotency, durable batch identity, and cross-process UI refresh exist.

### 2. Clipboard copy of selection

- `next` — Minimal slice: select several images/notes, `Cmd+C` / right-click → copy
  the selected **images** into the system clipboard (macOS image data), paste into
  any app/agent/folder. Uses the existing selection contract.
- `discuss` — Rich form: copy "note text + N images" as one clipboard payload
  (text + attachments). macOS clipboard multipart has limits; likely to be resolved
  via item 1 (give the agent the board instead). Defer until item 1 is decided.




### 3. Board icon and color editing (cover is done)

- `later` — Setting and removing a Board **cover** shipped (`setBoardCover` /
  `removeBoardCover`, wired in `App.tsx`). A Board's **icon and color** are still
  only derived: the portal renders a deterministic color token and a symbol taken
  from the title, with no way to choose either.
- `later` — Keep the action in the portal context rail and the tile context menu,
  falling back to the color/symbol tile whenever no cover is set.
- `later` — Clipboard image paste as a cover input belongs to the clipboard slice
  (`docs/specs/link-card-and-clipboard.md`). Not started.

### 4. Card connections (arrows between cards)

- `wishlist` — Milanote-style arrows: single-click a card to show a handle in its
  top-right corner; drag the handle onto another card to draw an arrow from the
  source center to the target center, clipped to each card's outline (the line is
  hidden outside both card bounds) and pointing at the target center, re-routing
  as either card moves. A dashed line from the source center only shows while the
  source card is selected. This is a large separate slice: a `connections`
  migration + backend commands, gateway/state, an SVG overlay above React Flow,
  and the drag-to-connect interaction.

### 5. Grouping (combine cards into a fixed group)

- `wishlist` — select several cards, then combine them into a persistent group
  (give it a name + color), like Obsidian/Milanote. The group moves/translates as
  one unit, can be resized, and accepts new members; its members keep their
  relative layout. A marquee-style selection frame already exists; a small
  context menu on selection would offer "Group". Needs a `groups` entity
  (migration), backend commands, and group rendering/interaction.


## Ordering

The stabilization plan (`docs/plans/2026-09-11-v1-stabilization-and-debt-paydown.md`)
is the current ordering authority. Its last step is packaged macOS acceptance;
nothing below starts until that passes, because a green automated suite has never
been evidence about the packaged app.

After acceptance, in this order:

1. **Clipboard image copy and paste** (backlog 2) — the last fragment of the note
   rail that was promised with the contextual rail.
2. **Board icon and color editing** (backlog 3) — cover already shipped; icon and
   color are the remaining half.
3. **Card connections and grouping** (backlog 4 and 5) — both need an architecture
   pass first; they change how the canvas is read, not just what it draws.
4. **Agent surface** (backlog 1) — the protocol slice exists (ADR-0005); what is
   left is the write-confirmation UX and durable batch identity, and it is worth
   doing after the UI stops moving.

Deferred without a slot: bundle splitting, duplicate board/card, plain-text
precision for lists and code blocks. Reasons and owners are in
`docs/testing/v1-stabilization-report.md`.

## Проблемы от пользователя — сессия 2026-09-18

Порядок = порядок поступления. Статус: `open` / `in progress` / `fixed <hash>`.

1. `fixed 2026-09-18` — **Заметка пропадает при переносе на портал доски.** Перетаскивание
   note card на board portal: карточка исчезает с исходной доски и не появляется в
   Unsorted целевой. Не всегда; чаще большие многострочные заметки; с Home внутрь
   другой доски — стабильно. Причина: `readCard`-рефреш ревизии (фикс от 2026-09-08)
   не закрывает гонку с draft-flush на blur — окно между чтением и самим вызовом
   move всё ещё есть, и тем шире, чем больше заметка (медленнее запись). Backend
   корректно и атомарно отклоняет весь перенос (ADR-0007), но без повтора это
   выглядело как потеря карточки. Фикс: `src/canvas/move-selection-onto-board.ts`
   (общий для обоих путей cross-board drop) + `src/services/error-message.ts`
   (сообщение `stale_revision` было нечитаемым). См. `tasks/lessons.md` 2026-09-18.
2. `fixed ea8ec1c` — **Заметка не растёт под большой текст.** Вставка большого текста
   в новую заметку: карточка не увеличивается, текст рисуется за рамкой, уголок
   resize остаётся у старой границы и недоступен — заметку нельзя увеличить руками.
   Пример: `myspace://card/01a09eb0-83a9-7235-bdbb-131349d4f430` (картинка + подпись).
   Причина: `note.frame.height` — фиксированная persisted высота, менявшаяся только
   ручным resize; `overflow: hidden` молча клипал контент, а не рос под него.
   Фикс: `src/cards/note/NoteCard.tsx` — авторост высоты во время редактирования
   (без верхнего предела, min-height как раньше; ручное уменьшение ниже контента
   не переигрывается, только скроллится — `overflow-y: auto` в
   `src/cards/note/note-card.css`), запись нового `frame.height` — той же командой
   resize, дебаунс 250мс как у автосохранения текста. По пути найдена и закрыта
   гонка: два дебаунса (текст + рост) от одного и того же ввода могли уйти в очередь
   почти одновременно и второй читал устаревшую revision из `cardsRef` (эффект
   синхронизации — макротаск, очередь мутаций — микротаски); см.
   `tasks/lessons.md` 2026-09-18.
3. `fixed 77bbe83` — **Картинка должна быть видна целиком в любом масштабе.** Сейчас image
   card обрезает изображение под рамку: после добавления скриншота виден фрагмент,
   чтобы увидеть всё — приходится сильно тянуть уголок. Нужно: при добавлении
   карточка берёт пропорции картинки и показывает её целиком (миниатюра, но вся);
   при resize пропорции сохраняются, картинка только крупнее. Скриншот: обрезанная
   заметка-скриншот, видна одна строка из середины.
   Причина: `assets.width`/`height` в БД всегда NULL — `import_asset` в
   `src-tauri/src/domain/asset_service.rs:44-56` их не читает; фронт создавал
   image card с фиксированным `frame: {width: 320, height: 240}`
   (`src/App.tsx`, `importImageCard`), а `.image-card__image img` рисовался
   с `object-fit: cover` (`src/cards/image/image-card.css:19-24`), поэтому
   несовпадающая рамка обрезала картинку.
   Фикс (без миграции БД): `src/cards/image/image-card-geometry.ts` — новый
   модуль, читает natural size через браузерный `Image()` и считает frame по
   пропорциям картинки (`computeInitialImageFrameSize`) и aspect-locked resize
   (`computeResizedImageFrameSize`, высота подписи меряется через DOM-ref, не
   константой). `src/App.tsx` (`importImageCard`) использует его при создании
   карточки (общий путь для кнопки и drag-drop). `src/cards/image/ImageCard.tsx`
   — resize держит пропорции, как только известен natural aspect ratio картинки
   (`<img onLoad>`), иначе старое свободное поведение. CSS: `object-fit: cover`
   → `contain` — старые карточки с уже неправильным frame теперь показывают
   картинку целиком (с letterbox-полями), без обрезки, без изменения данных.
4. `fixed см. git log` — **Подсказка «Click New Note» посреди доски не пропадает.** Сейчас
   исчезает только после появления текстовой заметки. Должна пропадать при любом
   содержимом/активности на доске (картинка, ссылка, файл, портал, папка) и вести
   себя одинаково на всех досках, не только на Home.
   Дополнение: подсказка торчит постоянно и часто перекрывает другие карточки —
   значит, она рисуется поверх содержимого. Должна быть только на пустой доске и
   ниже слоя карточек (не перехватывать клики).
5. `fixed см. git log` — **Просмотр картинки (клик по миниатюре) уходит за край экрана.**
   Увеличенное изображение раскрывается от позиции миниатюры: если она в левом
   верхнем углу, границы увеличенной картинки уходят влево и вверх за видимую
   область. Нужно: увеличенный просмотр всегда целиком в видимой части экрана
   (центрирован по viewport, вписан по размеру), независимо от того, где стоит
   миниатюра на доске.
6. `open` — **Rust-тест виснет**: `src-tauri/tests/asset_service.rs::
   a_failed_thumbnail_leaves_no_orphan_and_still_creates_the_card` не завершается
   (0% CPU, даже при `--test-threads=1`). Блокирует `cargo test` целиком — каждая
   проверка ждёт вечно. Найдено 2026-09-18 при прогоне после фикса №1.
