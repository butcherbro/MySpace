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
