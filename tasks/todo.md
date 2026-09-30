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
6. `fixed` — **Rust-тест виснет**: `src-tauri/tests/asset_service.rs::
   a_failed_thumbnail_leaves_no_orphan_and_still_creates_the_card` не завершается
   (0% CPU, даже при `--test-threads=1`). Блокирует `cargo test` целиком — каждая
   проверка ждёт вечно. Найдено 2026-09-18 при прогоне после фикса №1.
   Корень: продуктовый дефект — `qlmanage` в `stage_thumbnail`
   (`src-tauri/src/domain/asset_service.rs:412`) звался через `Command::status()`
   без таймаута; в этом окружении `qlmanage` зависает в NSRunLoop навсегда
   (нет сессии WindowServer). Тот же путь используется при живом импорте файла
   (`src-tauri/src/commands/filesystem_aliases.rs:281`), поэтому импорт мог
   зависнуть и в приложении. Исправлено 2026-09-18: `qlmanage` теперь запускается
   через `spawn()` + опрос `try_wait()` с дедлайном 5с и `kill()` по истечении
   (`run_qlmanage_bounded`, `src-tauri/src/domain/asset_service.rs`).
7. `fixed` — **При resize старая рамка остаётся до отпускания.** Тянешь уголок
   картинки/заметки внутрь — содержимое сужается сразу, а рамка прежнего размера
   остаётся видимой, пока не отпустишь. После отпускания рамка пропадает. Найдено
   при проверке №2/№3. Причина: рамку рисует `.canvas-card-frame`
   (`src/canvas/CanvasAdapter.tsx`), которую держали на `width/height: 100%` от
   React Flow узла — а узел берёт размер из `card.frame` (persisted, обновляется
   только по коммиту resize на pointerup). Каждая resizable-карточка уже ведёт
   свой live-размер на собственном корне (inline style от локального draft во
   время drag) — рамка навязывала свой конкурирующий размер вместо того, чтобы
   брать его у контента. Фикс: `.canvas-card-frame` → `width/height: fit-content`
   (CSS) + убран инлайн `style={{width:"100%",height:"100%"}}` в `nodeTypes.card`
   — единственный источник размера теперь контент карточки. См.
   `tasks/lessons.md` 2026-09-18.
8. `fixed` — **Undo переноса на другую доску не работает.** Корень: одиночный
   drop заметки на портал (`handleCardDroppedOnPortal` → leaf-ветка,
   `src/App.tsx`) звал `gateway.moveCardsToBoardUnsorted` напрямую, минуя
   `CommandDispatcher` — перенос никогда не попадал в undo-стек, и `Cmd+Z`
   откатывал случайную более старую команду сверху стека, которая к тому
   моменту уже устарела. Побочно нашли и починили реальный, но
   маскирующий баг: `undo_move_selection` (`src-tauri/src/domain/move_selection.rs`)
   при отказе дублировал `expected` в поле `actual` вместо чтения настоящей
   ревизии из БД — тост всегда показывал равные числа, что и сбивало с толку.
   Обе гипотезы из постановки не подтвердились буквально; см. tasks/lessons.md
   2026-09-18.
9. `fixed` — **Иконка Board в левом рейле не выделяется.** Сделать её заметной хотя
   бы цветом (сейчас сливается с остальными).
10. `fixed` — **Создать board прямо на доске из меню под курсором.** Сейчас портал
    доски добавляется только перетаскиванием из левого рейла — далеко тянуться.
    Нужно: двойной клик левой кнопкой по пустому месту доски → выпадающее меню
    → «Добавить board» (и логично туда же «Добавить заметку»); новый портал
    появляется в точке курсора. Проверить, что не конфликтует с текущим
    поведением клика/двойного клика по пустой доске (подсказка «Click New Note»).
11. `fixed` — **Зачёркивание в редакторе заметки.** Выделить текст → сделать
    зачёркнутым (Tiptap Strike, `Cmd+Shift+X`) + кнопка в контекстном рейле заметки
    рядом с Bold.
12. `fixed` — **Курсив в редакторе заметки.** Выделить текст → курсив (Tiptap
    Italic, `Cmd+I`) + кнопка в рейле. Итого набор форматирования выделенного текста:
    Bold (есть), Italic, Strike — три кнопки рядом в контекстном рейле заметки.
13. `fixed` — **Вставка форматированного текста из буфера с сохранением
    форматирования.** Скопированный из Telegram/браузера/другого приложения текст
    (жирный, курсив, отступы, абзацы, списки) при вставке в заметку — и при вставке
    на пустое место доски (создаётся новая заметка) — должен сохранять форматирование.
    Технически: читать `text/html` из clipboard, а не только `text/plain`; Tiptap
    умеет парсить HTML. Проверить оба пути: paste в открытый редактор и paste на канвас.
14. `fixed` — **Перетаскивание вкладок досок (board tabs) для смены порядка**, как в
    браузере: зажал вкладку, тянешь влево/вправо, остальные раздвигаются, отпустил —
    новый порядок. Не путать с drag карточки на вкладку (это уже есть и должно
    продолжать работать).
15. `fixed` — **Копировать/вставить карточки внутри приложения.** Выделил заметку
    (или несколько карточек) → `Cmd+C`; на этой или другой доске `Cmd+V` → копия
    появляется в точке курсора. Для заметок — с форматированием и цветом; для
    картинок/файлов — с тем же asset. Подтверждено: заметки и картинки как минимум — суть «дубликат карточки».
    Связано с бэклогом «Clipboard copy of selection» и «Duplicate board/card».
16. `fixed` — **Дубликат доски (board portal) вместе со всем содержимым.** Сценарий:
    доска-шаблон с заготовками файлов/заметок; `Cmd+C` на портале → `Cmd+V` рядом →
    появляется копия доски со всеми карточками (включая вложенные доски — уточнить
    глубину: рекурсивно?). Карточки копируются с тем же содержимым; assets можно
    переиспользовать (copy-in модель: один asset — несколько карточек, GC это уже
    учитывает по владельцам). Имя копии: «<имя> copy» или как в Finder.
    Backend: атомарная команда duplicate_board (транзакция), undo — в Trash пакетом.
17. `fixed` — **Ярлыки досок (board shortcut / alias), как в Milanote.** Доска живёт
    в одном месте (родитель, хлебные крошки), а ярлык на неё можно положить на любую
    другую доску: правая кнопка по порталу → «Создать ярлык доски» → рядом появляется
    карточка-ярлык с отличительным значком (стрелочка в углу). Клик по ярлыку
    открывает саму доску. Удаление ярлыка не удаляет доску; удаление доски —
    ярлыки становятся «битыми» или удаляются (решить). Ярлыков на одну доску может
    быть много. Технически: новый вид карточки `board_shortcut` (target_board_id) —
    не путать с портальным board_portal, который владеет доской. Поиск/Unsorted/
    Trash должны его понимать. Существующий `filesystem_aliases` — про папки Finder,
    другая сущность.
18. `fixed` — **Вставка карточек (№15) идёт в левый верхний угол, а не под курсор**
    (на живом приложении). Трекер позиции курсора `lastCanvasPointRef` в App.tsx
    не даёт актуальную точку в момент Cmd+V — fallback на дефолт. Найдено при
    проверке №15.
19. `fixed` — **Двойной клик по пустому месту доски → сразу пустая заметка** под
    курсором (как в Milanote), без меню. Меню «Add Note / Add Board / Copy Link»
    остаётся только на правой кнопке. Корректирует №10 (там двойной клик открывал
    меню).
20. `fixed` — **Ярлык папки / файловая карточка пропадает при переносе на другую
    доску** (drag на портал) — тот же симптом, что был у №1 для заметок. По копии
    живой БД: сама карточка `PIPELINE_MAP.md` (file) не потеряна — она сегодня
    успешно переехала через тот же код (`operation_receipts` содержит её
    `move_selection_to_board`-квитанцию, revision 3→4, на доску «Посты из тг»),
    т.е. симптом воспроизводился ДО фиксов b9dc2bd/d751077 и общий путь
    (`moveSelectionOntoBoard` → `MoveSelectionCommand` → backend
    `move_selection_to_board`) уже не различает `kind` нигде — ни во фронтенде
    (`LeafRef` в `src/canvas/move-selection-onto-board.ts` не несёт `kind`), ни в
    бэкенде (`read_selection_pre_state` и `UPDATE cards` в
    `src-tauri/src/domain/move_selection.rs` читают/пишут общие колонки `cards`
    без JOIN на kind-таблицу). Добавлена матрица регрессионных тестов на все 6
    видов карточек (note/image/embed/file/filesystem_alias/board_portal), чтобы
    будущая kind-специфичная ветка не могла тихо вернуть баг только для одного
    вида: `src-tauri/tests/move_selection_contract.rs`
    (`every_leaf_kind_moves_into_the_destination_unsorted_panel`) и
    `src/canvas/move-selection-onto-board.test.ts` (`it.each` по image/embed/
    file/filesystem_alias). Никакого нового production-фикса не потребовалось.
21. `fixed см. git log` — **MD-файлы (file card) показывать отрендеренным markdown**, а не
    сырым текстом: заголовки, таблицы, списки, код — в превью карточки и в
    полноразмерном просмотре. Скриншот: `PIPELINE_MAP.md` с таблицами выглядит как
    сплошной текст с `|`.
    Факт-проверка показала, что отдельного "полноразмерного просмотра" для
    file card (html/pdf/txt) в коде нет — единственное место рендера это сама
    карточка (resizable, со скроллом внутри). `.md` теперь рендерится в HTML на
    лету тем же протокол-хендлером `myspace-asset://`, что уже отдаёт `.html`
    "как есть" (`src-tauri/src/lib.rs`), и показывается в том же
    `sandbox=""` iframe — карточка сама по себе и есть "полный" просмотр при
    ресайзе. Rust: `pulldown-cmark` (GFM-таблицы), новый модуль
    `src-tauri/src/domain/markdown_preview.rs`.
22. `fixed` — **Перенос на портал попадает в соседнюю доску.** Цель броска
    определяется по перекрытию рамки перетаскиваемой карточки с порталом
    (`portalAtPoint` по frame overlap, см. lessons 2026-09-08), поэтому большая
    карточка краем задевает соседний портал и уезжает туда. Нужно: цель = портал,
    внутри которого находится курсор в момент отпускания; перекрытие — только если
    курсор ни в одном портале. Уточнение к «№20», которого как бага переноса нет.
    Фикс: `portalAtPoint` (`src/canvas/CanvasAdapter.tsx:257`) теперь сначала
    проверяет курсор (board-space точка отпускания через `screenToFlowPosition`)
    против рамки каждого портала (верхний по zIndex при пересечении порталов), и
    только если курсор ни в одном портале — откатывается к прежнему overlap.
    `handleNodeDrag` (hover-подсветка) и `handleNodeDragStop` (drop) используют
    одну и ту же резолюцию, так что подсветка во время перетаскивания больше не
    врёт о цели. Тесты: `src/canvas/CanvasAdapter.test.tsx` (`describe("portal
    drop target (todo.md №22)")`) — курсор над A с большим overlap у B → A;
    курсор над B → B; курсор ни над одним → overlap-фолбэк (B); групповой
    перенос — по курсору, а не по рамке отдельного узла; hover-подсветка
    совпадает с drop-целью. `npm run check` и `npm run test:e2e` зелёные
    (419/419 и 48/48 соответственно).
23. `fixed` — **Ярлык папки/файла из текстового пути.** Сейчас folder shortcut /
    file card создаются только drag-drop из Finder. Нужно: если в буфере обмена
    текст — абсолютный путь к существующей папке (`/Users/bro/Projects/…`), то
    `Cmd+V` на пустом месте доски создаёт ярлык папки под курсором, как при
    drag-drop (тот же backend-путь: bookmark, превью). Если путь ведёт на файл —
    file card (copy-in, как при drop). Также в меню правой кнопки «Add folder
    shortcut…» с полем ввода пути (или системный диалог выбора папки через Tauri
    dialog). Приоритет в paste-хуке: внутренний буфер карточек → путь к папке/файлу
    → изображение → html/plain. Путь распознавать строго: начинается с `/` или `~/`,
    одна строка, существует на диске (проверка на backend).
24. `fixed` — **Подпись под картинкой и под ссылкой (caption) теряет форматирование
    вне редактирования.** Bold/italic/strike видны, пока курсор в подписи; после
    blur подпись рендерится обычным текстом (видимо, read-only режим показывает
    `caption_plain_text`, а не `caption_json`). Нужно: подпись всегда рендерится из
    JSON с форматированием (bold/italic/strike, абзацы, списки), и вставка
    форматированного текста (№13) в подпись сохраняет форматирование. Касается
    image_cards.caption_json и embed (link) card caption.
25. `fixed 2026-09-19` — **Вставка из буфера в открытую заметку создаёт вторую
    заметку в левом верхнем углу** (живое приложение, сборка с №13–№19). Корень:
    ОДИН путь вставки (`src/app/use-canvas-paste.ts`, window `paste` listener) —
    гипотеза про второй keydown-обработчик не подтвердилась, его нет. Реальный
    баг — guard `e.target instanceof Element && target.closest(...)` доверял
    только `e.target`, а в живом Tauri WKWebView Cmd+V через нативный Edit-меню
    accelerator может дать `e.target === document`, даже когда контентредактируемый
    элемент реально в фокусе (`document.activeElement`). Guard пропускал такое
    событие как "не в редакторе" → падал в canvas-level paste → создавал
    дубль-заметку с тем же текстом. Фикс: guard теперь проверяет ещё и
    `document.activeElement`, доверяя любому из двух, если он указывает на
    `[contenteditable="true"]`/`.ProseMirror`/`textarea`/`input`. Второй симптом
    (пустая доска → заметка в углу) — отдельный, но связанный баг:
    `lastCanvasPointRef` (flow-координаты) не сбрасывался при смене доски, и
    вставка сразу после открытия новой доски без движения мыши переиспользовала
    координату ПРЕДЫДУЩЕЙ доски; исправлено сбросом ref на `boardOpenRevision`.
    Тесты: `src/app/use-canvas-paste.test.ts` (новый юнит-кейс — activeElement
    ≠ target), `tests/e2e/paste-cursor.spec.ts` (два новых e2e: дубль внутри
    редактора, застарелый курсор при смене доски). См. `tasks/lessons.md`
    2026-09-19 — синтетический `paste` на `window` не мог поймать этот класс
    багов в принципе (target всегда совпадал).
26. `fixed 2026-09-19` — **«Пружина» при скролле доски.** Периодически на разных
    досках нельзя прокрутить вниз (иногда и вправо): при скролле вниз viewport
    выталкивает обратно наверх. Корень (`src/canvas/CanvasAdapter.tsx` +
    `src/state/use-viewport-controller.ts`): `translateExtent`/`nodeExtent` ни при
    чём (уже бесконечны вправо/вниз) — не подтвердилось. Реальная причина: одно и
    то же значение обслуживало два разных назначения. `handleViewportChanged`
    нарочно приравнивает сохраняемый viewport к `{x:0,y:0}` на каждом устаканивании
    пан-жеста (ADR-0003 — пан не персистится, только zoom) и кладёт это же
    обнулённое значение в `state.viewport`. А `CanvasAdapter` брал ИМЕННО его же
    для `defaultViewport`/`onInit`'s `setViewport` при любом remount `<ReactFlow
    key={interactionResetRevision}>` — а этот remount существует для НЕсвязанной
    причины: WKWebView может потерять `pointerup` посреди marquee-выделения,
    оставляя `.react-flow__selection` висящим в DOM; `resetInterruptedMarquee`
    форс-ремонтирует канвas на blur окна/Escape/visibilitychange, чтобы это
    убрать. Стоило пользователю один раз прокрутить (viewport обнулился для
    персистентности) и потом словить любой такой remount (алт-таб, Escape,
    залипший pointerup) — живой пан молча откатывался к (0,0). Интермиттентность
    объясняется именно совпадением: нужен и скролл, и remount-триггер рядом.
    Фикс: `CanvasAdapter` теперь ведёт собственный `liveViewport` (state,
    безопасно читать при рендере — в отличие от ref, см. `react-hooks/refs`) +
    зеркальный `liveViewportRef` (для `onInit`, вне рендера), обновляемые из
    реальных координат `onMoveEnd`, и обнуляются только на настоящей смене доски
    (`viewportResetToken`). Тест: `tests/e2e/canvas-viewport-spring.spec.ts` —
    скролл вниз → зависшее marquee-выделение → `window.dispatchEvent(new
    Event("blur"))` → pan не откатывается. Подтверждено red на до-фикс коде через
    `git stash`, green после. См. `tasks/lessons.md` 2026-09-19.
    **2026-09-24, вторая причина (пользователь: пружина осталась).** Remount при
    зависшей рамке был не единственным путём к сбросу. `snapshotLoaded` в
    `src/state/current-board-store.ts` обнулял viewport и увеличивал
    `boardOpenRevision` при ЛЮБОЙ перезагрузке той же доски, а `CanvasAdapter`
    по `viewportResetToken={boardOpenRevision}` императивно ставил (0,0). Такие
    перезагрузки происходят без участия пользователя: undo/redo, rename, и
    главное — poll `PRAGMA data_version` каждые 3 с в `App.tsx`, который
    срабатывает после enrichment ссылки (оно пишет через второе соединение) и
    после любой записи MCP. Отсюда «то есть, то нет»: совпадение скролла с
    фоновой перезагрузкой. Фикс: перезагрузка той же доски сохраняет pan,
    редактируемую заметку и выделение (фильтруя исчезнувшие карточки); токен
    сброса растёт только при смене доски. Тесты в
    `src/state/current-board-store.test.ts`.

## Архитектурный аудит 2026-09-24

Отчёт: `docs/audits/2026-09-24-architecture-audit.md` (риски, три режима нагрузки,
roadmap P0/P1/P2). Направление синхронизации между устройствами: ADR-0011.

P0 — закрыто в этой сессии (ветка `claude/awesome-goodall-4tfsko`):
- [x] Trash-целостность: чужие батчи не перезаписываются, restore в удалённого
      родителя отклоняется, сортировка до обрезки (`trash_integrity.rs`).
- [x] Защита версии схемы + `foreign_key_check`/`quick_check` после миграций;
      MCP не мигрирует БД.
- [x] Миграция 0019: индексы на `*_asset_id`, `deleted_at`, `batch_id`;
      портальные счётчики без полного скана.
- [x] Бэкап публикуется при пропавшем файле ассета (список в манифесте).
- [x] Потеря последних ~250 мс ввода при навигации без blur — подтверждена и
      закрыта (`draft-flush-registry.ts`).
- [x] `tracing`: `<data dir>/logs/myspace.log`, `MYSPACE_LOG`, `slow=true` > 250 мс.
- [x] «Пружина» №26, вторая причина: перезагрузка той же доски больше не
      сбрасывает viewport/редактирование.

P1 (до серьёзного роста), в порядке выполнения:
- [x] P1.1 БД и диск с main thread: `app::Workspace` (writer-поток + пул из 2
      читателей), все команды `async`, единая воронка `domain::Mutation`
      (Tauri, MCP и стартовое обслуживание), `BEGIN IMMEDIATE` везде,
      check-then-act внутри транзакций, bounded retry на BUSY, `queue_ms`/`exec_ms`
      в логе. Тесты: `workspace_actor.rs`, `write_transactions.rs`.
      Хвосты (не блокируют): enrichment больше не держит pooled-соединение на
      время сетевого запроса (закрыто 2026-09-30, лимит 4 одновременных
      enrichment, дедуп по sha256 внутри транзакции коммита); `import_asset` при повторном
      использовании одного UUID из двух процессов может удалить чужой файл
      (только при коллизии id — практически невозможно).
- [x] P1.2 Бэкап 2.0: `assets.sha256` (миграция 0020), хэш при импорте, дедуп по
      содержимому (импорт, буфер, файлы, enrichment), фоновый backfill, снапшоты
      с hard-link'ами и лимитом 2 GiB, `list_backups`/`request_restore` +
      диалог «Backups…» в корзине (restore через маркер и перезапуск).
      Проверить на Mac: снапшот 2 GB ассетов < 2 с; `CollapseFaviconDuplicates`
      удалить в следующем релизе.
- [x] P1.3 Реестр kind: `domain/card_kind.rs` + `domain/kinds/*` (один handler на
      kind, `to_payload`/`from_payload` — кодеки журнала), миграция 0021 сняла
      `CHECK(kind IN …)` и размеры (теперь `Frame::validate`). На фронте один
      список `CARD_KINDS` (`src/cards/card-kinds.ts`).
- [x] P1.4 FTS5: `search_index` + триггеры (миграция 0022), prefix-поиск, 50k заметок
      ≈ 5–20 мс. Файловые карточки ищутся. Спека `docs/specs/search.md` обновлена.
- [x] P1.5 Receipts: `CardReceipt`/`TextReceipt`/`CardsReceipt`/`ViewportReceipt`,
      ревизия читается из БД; `plain_text` считается в Rust (`domain/plain_text.rs`,
      фикстуры синхронизированы с TS-тестом); на фронте нет `revision + 1`.
- [x] P1.6 `boards.change_seq` + триггеры (миграция 0023), команда `get_board_change_seq`
      (`dataVersion` + `changeSeq` с writer-соединения); фронт перезагружает доску
      только если писал другой процесс и именно в открытую доску
      (`src/state/external-change-detector.ts`).
- [x] P1.7 Повреждённые данные: `corrupt` в DTO заметки/картинки/ссылки (пустой doc +
      сохранённый plain text, `warn` `corrupt_document`), запись поверх — только с
      `acknowledgeCorrupt`; карточка «Damaged … — showing recovered text» без автосейва,
      Repair → редактор; сбой открытия БД при старте → recovery mode
      (`get_startup_failure`, `StartupGate` + `RecoveryDialog`, restore из последнего снапшота / Quit).
- [x] P1.8 Стоимость карточки на канвасе: `onlyRenderVisibleElements`; простаивающие
      заметки/подписи/описания — статический HTML (`editor/static-document.ts`,
      `StaticDocument`), Tiptap только у редактируемой карточки (каретка ставится
      в точку клика); вместо O(N) `cardsKey` — пересборка только изменившихся
      узлов (`staleNodeIds`), карточки в `memo`, стабильные колбэки в `App`.
      1 000 карточек: обновление одной = 1 рендер карточки
      (`CanvasAdapter.render-cost.test.tsx`); e2e `dense-board.spec.ts`: первая
      отрисовка ≈ 0.6–0.75 с в контейнере (было ≈ 3.5 с), пан ≈ 10–25 мс.
      Проверить на Mac: бюджет 500 мс (`DENSE_BOARD_PAINT_BUDGET_MS=500`).
- [x] `cargo audit`/Dependabot в CI (джоб `security-audit`, коммит e207757).

P2 / platform:
- [x] Windows: build + CI + path locator + opener + clipboard (done 2026-09-24);
      thumbnails on Windows pending. Подробности: README → «Platforms».
      Проверить на живом Windows: см. список «Needs a human on Windows» там же.
- [x] Device identity + device-scoped shortcut locators (ADR-0012), migration 0024
      (done 2026-09-24). Проверить на Mac: старые ярлыки папок открываются после
      миграции; на Windows: ярлык с Mac показан «On <Mac>», «Point to a folder on
      this computer…» делает его рабочим. UI для имени устройства нет (только
      команды `get_device_identity` / `rename_device`). Скопированная на другую
      машину база получает новый device_id (отпечаток машины в `local_meta`).

Известные флейки e2e (не регрессия, воспроизводится на `f819aee`):
- [x] (закрыто 2026-09-30: тест ждёт `data-flow-ready` перед «New board»,
      `selectNotesOnly` выделяет полосой по левым краям заметок)
      `group-tab-drop.spec.ts:40` — на медленном кадре рамка выделения захватывает
      портал (3 узла вместо 2), ~25 % прогонов при `--workers 1`. Починить
      гест (`selectNotesOnly`: выделять по клику с Shift или ждать стабилизации).

## Осталось после сессии 2026-09-18

- [ ] Ручная проверка на живом приложении: paste пути папки, диалог «Add Folder
      Shortcut…», `.md` под CSP, вставка из Telegram, ярлыки досок (каскад/restore),
      дубликат доски.
- [ ] Переписать `tasks/current-state.md` под `main`/`acf2b57` (сейчас описывает
      ветку `codex/v1-stabilization` от 13.09).
- [ ] Пройти `docs/testing/v1-acceptance-runbook.md` целиком.
- [ ] Резервная копия: приватный git remote — по решению пользователя.
- [ ] Опционально: подогнать frame старых image cards под пропорции; полноэкранный
      просмотр `.md`.
- [x] (закрыто 2026-09-30: `src/state/card-writes.ts`, защита в reducer,
      слияние same-board снимка по меткам записей)
      Узкая гонка ответов (найдено 2026-09-26 при починке метаданных ссылок):
      запись из очереди (drag/resize/описание) может прочитать `cardsRef` в те
      миллисекунды, когда бэкенд уже записал метаданные, а ответ ещё не обработан,
      и упасть с `stale_revision`. Общее свойство: ответы двух записей могут прийти
      в обратном порядке и откатить локальную ревизию. Начать с того, чтобы
      `cardReplaced`/receipt-обновления в reducer не откатывали ревизию назад.
- [ ] Показывать версию приложения в интерфейсе (About / будущий экран настроек):
      сейчас её видно только в Finder → Cmd+I (запрос пользователя 2026-09-26).
- [x] (закрыто 2026-09-30: портал не пропадал, но оставался на старом месте
      со старой ревизией; теперь `portalMoved` из receipt)
      Проверить (найдено при разбиении App.tsx, 2026-09-26): групповой дроп в
      `handleCardsDroppedOnBoard` (`src/app/use-card-drop.ts`) показывает листовые
      карточки, пришедшие в открытую доску, но для портала, который пришёл в открытую
      доску, ничего не диспатчит (есть только `cardsRemoved` для ушедших). Путь
      возможен при дропе на крошку текущей доски. Воспроизвести; если портал не
      появляется до перезагрузки — добавить его из receipt.

## Следующие фичи — зафиксировано 2026-09-25

Порядок: отчёты об ошибках (решено 2026-09-26, делать первыми), затем связи
(дешевле, почти всё есть в React Flow), потом группы.

- [x] **Отчёты об ошибках** (сделано, коммит f385ba0). Каждый показанный баннер ошибки автоматически
      пишется файлом в `<data dir>/error-reports/` (время, версия, ОС, текст и код,
      открытая доска, последние ~30 записей лога). На Mac пользователь ничего не
      делает — Claude читает папку сам. На баннере кнопка «Copy report»; после
      нажатия надпись «Report copied — send it to the developer». На Windows баннер
      сразу подсказывает нажать её (файлы там Claude не видит). Буфер обмена
      автоматически НЕ перезаписывать: это стёрло бы то, что пользователь
      скопировал сам. Отправка по сети — позже, когда появятся другие пользователи.

- [ ] **Связи между карточками (connectors).** Кружок-ручка в углу карточки
      при наведении; тянешь на другую карточку, отпускаешь над ней — связь.
      Плавающая стрелка: целится в центр цели, заканчивается на её границе,
      пересчитывается при движении любой из карточек. Отдельная сущность
      `connector(from_card, to_card, board_id, color, arrow_ends, label?)`,
      своя таблица + тип в журнале синхронизации, удаляется вместе с любой из
      карточек. Выделение кликом, Delete, цвет и направление в контекстном меню.
      Отпустил в пустоту — ничего не создаётся.
- [ ] **Группы (подложка с названием), как в Obsidian Canvas.** Новый тип
      карточки `group`: рамка, плашка с названием сверху, цвет из палитры
      досок, лежит под остальными по z-порядку. Членство геометрическое:
      карточка в группе, если внутри её рамки; тянешь подложку — едет всё
      внутри; вытащил за край — вышла из группы. Создание: выделить несколько
      карточек → «Group» в контекстном меню и плавающей панели, рамка по
      охватывающему прямоугольнику с отступом. «Ungroup» удаляет подложку.
      Ресайз за углы; авто-расширение не в первой версии. Перед началом — ADR.

## Sync

- [x] **S1 — change journal** (ADR-0011, migration 0025): `changes` (wire
      format), HLC in `local_meta.hlc_last`, per-register `entity_clocks`,
      `purged` tombstones, `pending_changes`, `sync_cursors`. Every journaled
      mutation writes its rows in the same `BEGIN IMMEDIATE` as the write
      (`sync::funnel`), from the app and the MCP server alike. One-time backfill
      of pre-journal data at startup (`local_meta.journal_snapshot_done`).
- [x] **S2 — replay engine** (`sync::replay::apply_remote`): idempotent,
      LWW per register, park/retry of rows whose dependency is missing, purge
      never resurrects, conflict copy for concurrent note edits, forwarding
      (star and mesh). Commands `sync_export_changes`, `sync_apply_changes`,
      `sync_status`; event `sync-applied` with the touched board ids.
      Tests: `src-tauri/tests/sync_replay.rs`.
- [x] **S3 — LAN transport** (ADR-0011 status): self-signed certs pinned by
      fingerprint, mutual TLS 1.3, pairing with a 6-digit code + HMAC proofs,
      mDNS discovery (`mdns-sd`) with pairing by `host:port` as fallback,
      pull loop (start, 5 s tick, 500 ms after a local write + poke, sync now),
      blobs by `sha256`. Migration 0026 `sync_peers`. Commands `get_sync_state`,
      `sync_list_peers`, `sync_list_discovered`, `sync_begin_pairing`,
      `sync_cancel_pairing`, `sync_pair_with`, `sync_unpair`, `sync_now`;
      events `sync-state`, `sync-applied`. UI: Devices dialog (Trash drawer
      "Devices…", top-bar pill). Tests: `src-tauri/tests/sync_lan.rs`,
      `src/sync/*.test.tsx`, `tests/e2e/sync-devices.spec.ts`.
- [x] Frontend: `sync-applied` reloads the open board (and the trash).
- [ ] **Human check on the desk (Mac + Windows):** pair both ways, Windows
      firewall prompt (Private network), edit on one → appears on the other
      within ~1 s, image/file card blobs arrive, unplug Wi-Fi on one → error
      shown, reconnect → catches up, rename a device → the other shows the new
      name after the next contact.
- [ ] Pairing is not resistant to an active man-in-the-middle during the
      pairing minute (the 6-digit code can be brute-forced offline from the
      HMAC proof). Replace the HMAC exchange with a PAKE (SPAKE2 / CPace) before
      the relay, or show a short fingerprint on both screens to compare.
- [ ] Private key is stored in the workspace database (`local_meta`), hence
      in backups. Consider the OS keychain / DPAPI.
- [x] Blobs are streamed from disk in 64 KiB chunks with an exact
      `Content-Length`; a write that makes no progress for 30 s drops the
      connection (done 2026-09-30).
- [ ] The mDNS advert shows the device name to the whole network; offer an
      option to hide it.
- [ ] IPv6 link-local addresses are skipped (no scope id in the advert); a
      network with IPv6 only needs "Add by address" with a global address.
- [ ] A device whose IP changes and that mDNS cannot see is unreachable until
      re-added by address (the port is random per start); consider a fixed
      preferred port.
- [ ] Render image/file cards whose blob is missing as "waiting for file"
      instead of a broken image (the board reloads when the blob arrives).
- [x] Writes by the MCP server (other process) reach peers in about 0.5 s:
      while a peer is paired, a pooled reader polls this device's journal
      cursor every 500 ms (done 2026-09-30, ADR-0011).
- [ ] Journal compaction (all peers' cursors past a row → it can be folded
      into a snapshot) and a policy for devices that stay offline for months.

## Масштабирование — замеры 2026-09-30

M3 Max, release-сборка, код `main` (f443eb4). В норме: снапшот 2 GB ассетов
(2 048 файлов) 0,6–0,9 с; FTS по 50 000 заметок 0,9–4,7 мс; доска на 5 000
карточек 17,6 мс (48,8 мс в базе на 50 000 карточек); писатель p95 до 0,84 мс,
около 5 100 мутаций/с; обычный старт 2,3 мс.

Долги по масштабу (замер на журнале в 100 000 изменений), делать ДО связей и
групп, в этом порядке:

- [x] (закрыто 2026-09-30: поиск по индексу на каждый origin, пустой опрос
      42 мс → 0,013 мс, обход 201 страницы 3,83 с → 0,12–0,19 с; `missing_blobs`
      98 мс → 21,5 мс, остаётся линейной — нужен локальный маркер «блоб ждём»)
      **Опрос журнала читает его целиком.** `changes_since`
      (`src-tauri/src/sync/journal.rs:96`) из-за `NOT IN … OR` идёт как
      `SCAN changes USING INDEX idx_changes_hlc`: 36 мс на пустой опрос, раз в
      5 с на каждого пира; страницы 0,45 мс → 46 мс (квадратично).
      `missing_blobs` (`journal.rs:213`) — 123 мс на 20 000 ассетов.
- [x] (закрыто 2026-09-30: причина — online backup шагами по 100 страниц с
      паузой 10 мс, не `integrity_check`; теперь один шаг и ссылки в 4 потока:
      214 MiB 7,8–12,1 с → 0,85–1,8 с, 20 000 файлов 6,6 с → 4,1 с)
      **Снапшот бэкапа зависит от размера базы.** База 214 MiB без ассетов —
      7,9 с, блокирующе перед Empty Trash и перед миграцией. Предположительно
      `PRAGMA integrity_check` + online backup (`db/backup.rs:248`), по
      отдельности не замерено. 20 000 мелких файлов — 6,8 с (0,33 мс на файл).
- [ ] **Компакция журнала.** Каждое автосохранение пишет полный образ сущности,
      около 1,6 KiB на изменение; 100 000 изменений ≈ 160 MB, 75 % базы.
      Нужна поправка к ADR-0011 до кода.
- [ ] **Replay замедляется.** 2 030 строк/с, 100 000 строк — 49,5 с, страница
      110 мс → 205 мс. Причина найдена 2026-09-30: не код replay, а рост числа
      грязных страниц на строку (5 таблиц). Лечится компакцией журнала. Варианты
      без неё: `temp_store=MEMORY` на писателе (−17 %), пересмотр обновления
      поискового индекса построчно (−36 % в замере без триггеров).
- [ ] Разовый backfill журнала держит все образы в памяти
      (`tracking.rs:282–300`): 2,6 с и 330 MiB на 50 000 карточек.
- [ ] Поиск по запросу ≤ 3 символов без префиксного совпадения — полный скан
      (`search.rs:222`): 98 мс на 50 000 карточек.
- [ ] Не измерено: миграции со старой схемы на большой базе, холодный кэш,
      LAN-транспорт, рост undo-истории и таблицы receipts, очередь писателя
      без предела (`workspace.rs:197`).

Найдено на ревью 2026-09-30 и сознательно оставлено:

- [ ] `set_note_color` и обложка доски не поднимают ревизию: два разных
      состояния карточки могут иметь одну ревизию, устаревший DTO той же
      ревизии молча перезаписывает цвет.
- [ ] `cardReplaced` при равной ревизии (no-op ответ метаданных) завершает
      редактирование описания, пока пользователь печатает.
- [ ] Дедуп фавикона при коммите может выбрать строку ассета, чей файл ещё не
      пришёл с другого устройства; свежая локальная копия удаляется как лишняя.
- [ ] Preview-ассет для карточки с `preview_origin = custom` вставляется
      строкой, но карточка на него не ссылается (сирота до GC).
- [ ] Стартовый `CollectOrphanedAssets` может удалить staged-файлы enrichment,
      который в этот момент ещё в работе.
- [ ] «New board», нажатый до `onInit` React Flow, ставит портал на запасную
      позицию `{x: 200, y: 120}`, а не в центр видимой области.
- [ ] Бэкенд позволяет «перенести» доску в её текущего родителя: портал
      прыгает на новое место с поднятыми ревизиями. Возможно, сделать no-op.
- [ ] Внешняя запись запускает проход sync с `force = true` в обход backoff
      (как и локальная запись): при пачке записей MCP недоступные пиры
      опрашиваются каждые ~500 мс.
- [ ] Перезагружать открытую доску при ответе `stale_revision`: сейчас после
      него ничего не перечитывается, и разошедшаяся карточка остаётся такой до
      следующей перезагрузки. Закрывает и остаточный случай слияния снимка
      (локальная запись rev 8, затем sync replay понизил карточку до rev 3 в
      окне одной перезагрузки — локальная копия побеждает).
- [ ] Реестр записей (`src/state/card-writes.ts`) должен владеть `cardsRef`
      целиком: `useLatestRef`-эффекты в `src/App.tsx` всё ещё пишут в ref на
      каждом коммите и могут на кадр вернуть его назад; `noteColorChanged`,
      `boardRenamed`, `boardCoverChanged`, `filesystemAliasUpdated` доходят до
      ref только через этот эффект.
- [ ] Поздний `cardAdded` для предыдущей доски (создал заметку и сразу ушёл на
      другую доску) попадает на новую доску до следующей перезагрузки:
      игнорировать, если `card.boardId` не совпадает с открытой доской.
- [ ] Undo/redo создания и удаления не ставит метку в реестре записей и
      полагается на следующую за ним перезагрузку; снимок фонового опроса,
      пришедший во время `dispatcher.undo()`, может на мгновение вернуть карточку.
- [ ] **Проверить первым: судьба правки пользователя после `stale_revision`.**
      Перезагрузка доски после устаревшей записи (cc6da1a) заменяет карточку
      сохранённой версией; e2e `tests/e2e/stale-revision.spec.ts` это и
      утверждает. Для заметки, в которую печатают, это может быть тихая потеря
      набранного. Выяснить, что остаётся в редакторе; если текст теряется —
      сохранять отклонённый документ как черновик или «Conflict copy».
- [ ] Баннер ошибки теперь переживает любую перезагрузку той же доски. Ошибка
      самой загрузки («load failed») после успешной следующей перезагрузки
      остаётся висеть до закрытия: помечать `failed` источником и снимать
      ошибки загрузки при успешной загрузке.
- [ ] Перезагрузка, отброшенная рядом с пользовательской навигацией на ТУ ЖЕ
      доску (клик по крошке открытой доски), не запоминается: если эта
      навигация не удалась, изменение из sync не показано до следующего события.

Найдено 2026-09-30 при работе над бэкапом и релизом:

- [ ] **Временные файлы sync лежат в `assets/` под именами, допустимыми для
      рядов `assets`** (`sync-<sha>.part`, `<name>.sync-part`;
      `src-tauri/src/sync/lan.rs:875`, `:925`, `peer_client.rs:204`, запись с
      truncate). Подделанный ряд от сопряжённого пира может заставить блоб
      качаться бесконечно или переписать копию внутри опубликованного снапшота.
      Перенести временные файлы в подкаталог и открывать через `create_new`.
- [ ] Реплей sync принимает ряд ассета с `file_path`, совпадающим с чужим
      существующим ассетом (`src-tauri/src/sync/image.rs:546–565`); UNIQUE на
      `assets.file_path` нет. Бэкап от этого больше не теряет данные, но сам
      ряд стоит отклонять.
- [ ] **Release workflow, шаг «Verify latest.json»**: `gh api -H "Accept:
      application/octet-stream" …/releases/assets/<id>` в CI трижды подряд
      вернул `BlobNotFound` (404) на релизе 0.2.3, хотя та же команда локально
      отдаёт файл. 0.2.3 опубликован вручную после тех же проверок. Выяснить
      причину (токен `RELEASES_TOKEN`, версия `gh` на раннере) или заменить
      шаг на `gh release download`.
- [ ] `list_backups` запускает `integrity_check` на каждом снапшоте: около
      10 × 0,4 с на базе 214 MiB при открытии диалога «Backups…».
- [ ] Prune бэкапов: 0,9 с на снапшот при 20 000 файлов × 10 снапшотов.
