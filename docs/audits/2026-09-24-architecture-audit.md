# MySpace — архитектурный аудит (масштабируемость, устойчивость, расширяемость)

Дата: 2026-09-24. HEAD: `55232c1` (`main`). Файлы не менялись.

Объём прочитанного: README, `.continue-here.md`, `tasks/*`, ADR-0001/0005/0007/0009/0010, `docs/specs/search.md`,
все 18 миграций, весь `src-tauri/src` (≈10.4k строк), `src-tauri/bin/myspace-mcp.rs`, конфиги (Cargo, tauri.conf,
capabilities, CI, vite/vitest/playwright), ключевые фронтовые модули (`services/*`, `persistence/*`, `state/*`,
`commands/*`, `canvas/*`, `navigation/*`, `search/*`, `editor/use-document-draft.ts`, выборочно `App.tsx` и
`CanvasAdapter.tsx`), тестовая инфраструктура.

---

## 0. Резюме для техлида

Проект в хорошей форме для V1 одного пользователя: SQLite как единственный источник истины, транзакции на
каждой мутации, оптимистичные ревизии, soft-delete с батчами, валидируемые бэкапы, 201 Rust-тест + 62 файла vitest +
20 e2e-спек. Слои разделены осознанно (commands → domain/repositories → SQLite; UI → gateway → commands).

Но архитектура «одной доски в памяти» упирается в четыре структурных ограничения, которые проявятся уже при 10×:

1. **Все команды выполняются на главном потоке под одним `Mutex<Connection>`**. Синхронные `#[tauri::command]` в
   Tauri 2 исполняются на main thread. Любая тяжёлая операция (бэкап перед Empty Trash, `qlmanage` до 5 с,
   копирование файла, поиск, загрузка большой доски) замораживает UI.
2. **Бэкап на каждом запуске копирует все ассеты целиком, хранит 10 копий**. Линейный рост диска ×10 и время старта,
   пропорциональное объёму ассетов.
3. **Поиск и трэш — полное сканирование в Rust без индексов/FTS**, кинды карточек зашиты в `CHECK`-констрейнт и в
   ~15 списках-литералах: каждый новый тип = пересборка таблицы `cards` и правки по всему коду.
4. **Целостность Trash**: `trash_board` переписывает `trash_batch_id` уже удалённых карточек в поддереве;
   `restore_trash_batch` восстанавливает карточку/доску в удалённого родителя; `list_trash` обрезает список до сортировки.

Ни одно из этого не блокирует текущую эксплуатацию. Всё это блокирует переход к «100× + новые типы».

---

## 1. Карта архитектуры

```
React 19 (App.tsx 2522 строки — оркестрация) ── WorkspaceGateway (интерфейс, 45 методов)
   │  CommandDispatcher (undo/redo, очередь)      ├─ TauriWorkspaceGateway → invoke()
   │  MutationQueue (FIFO записей)                 └─ MockWorkspaceGateway (1355 строк, для тестов)
   │  current-board-store (reducer, одна доска)
   │  CanvasAdapter (React Flow за фасадом)
   ▼
Tauri 2 commands (sync, main thread) ── State<Mutex<Connection>> (одно соединение)
   │                                  └─ enrich_embed_metadata: async + отдельное соединение
   ▼
domain/* (board_service, trash_service, move_selection, duplicate_board, asset_service, link_metadata)
repositories/* (cards 1551 строк, boards, search, assets, receipts, quick_boards, board_shortcuts)
   ▼
SQLite (WAL, synchronous=FULL, busy_timeout=5s, FK ON) + assets/<uuid>.<ext> + backups/<ts>/
   ▲
myspace-mcp (stdio JSON-RPC, отдельный процесс, своё соединение, сам гоняет миграции)
```

### Модель данных (class-table inheritance)

- `workspaces` (1 строка) → `boards` (дерево через `parent_board_id`) → `cards` (общие поля + `kind`)
  → 7 detail-таблиц по `card_id`: `note_cards`, `board_portal_cards` (UNIQUE target), `image_cards`, `embed_cards`,
  `filesystem_aliases`, `file_cards`, `board_shortcut_cards`.
- `assets` — метаданные файлов; владельцы: `image_cards.asset_id`, `embed_cards.asset_id/favicon_asset_id`,
  `boards.cover_asset_id`, `file_cards.asset_id/preview_asset_id`. Ни один из этих FK-столбцов не проиндексирован.
- Служебные: `board_view_states`, `quick_boards`, `favicon_cache`, `mutation_receipts` (legacy, только для MCP
  `add_links`), `operation_receipts` (ADR-0007), `schema_migrations`.
- Soft-delete: `deleted_at` + `trash_batch_id` на `boards` и `cards`.

### Индексы

`boards(parent_board_id, deleted_at)`, `boards(trash_batch_id)`, `cards(board_id, deleted_at, z_index)`,
`cards(trash_batch_id)`, `board_shortcut_cards(target_board_id)`, `quick_boards(sort_order, board_id)`,
`operation_receipts(kind, idempotency_key)` UNIQUE, `board_portal_cards.target_board_id` UNIQUE.

Отсутствуют: `cards(deleted_at)` для трэша, все `*_asset_id` (GC, бэкап, дедуп фавиконов), `mutation_receipts(batch_id)`,
`favicon_cache(asset_id)`, любые FTS.

---

## 2. Находки по разделам

### 2.1 Хранение данных и модель

| # | Что | Где | Оценка |
|---|---|---|---|
| S1 | `cards.kind` ограничен `CHECK(kind IN (...))`. Добавление kind = `CREATE TABLE cards_new … INSERT … DROP … RENAME` (уже 4 раза: 0002, 0012, 0013, 0018). Каждый раз пересоздаются индексы, FK выключены на время миграции, `foreign_key_check` после не выполняется. | `migrations/00{02,12,13,18}` | Средняя сейчас, критическая при 100× |
| S2 | Размерные ограничения UI зашиты в схему: `width BETWEEN 120 AND 1600`, `height BETWEEN 48 AND 10000`, `zoom BETWEEN 0.1 AND 4`, `color_token IN (7 значений)`. Изменение дизайн-параметра = пересборка таблицы. | `0001`, `0011` | Низкая-средняя |
| S3 | `plain_text` / `caption_plain_text` / `description_plain_text` — производные от JSON, но считаются **на фронте** (`documentToPlainText`) и отдельно в Rust (`plain_text_document`, MCP). Два кодека → рассинхрон поиска и содержимого. Бэкенд доверяет пришедшему `plain_text`. | `cards.rs::update_note`, `App.tsx::handleUpdateNote`, `link_metadata.rs` | Средняя |
| S4 | Две таблицы квитанций (`mutation_receipts` для `add_links`, `operation_receipts` для move_selection) с разной семантикой; `load_batch_card_ids` ищет по `batch_id` без индекса. | `0005/0006/0017`, `cards.rs` | Низкая |
| S5 | `board_portal_cards.target_board_id UNIQUE` — инвариант «один портал на доску» хорош, но `move_board`/`move_selection` ищут портал по `target_board_id AND deleted_at IS NULL`, при этом уникальность не учитывает удалённые порталы. Если портал в трэше, а доска жива (возможно после частичного restore, см. T2), доску нельзя переместить («has no active portal card»). | `board_service.rs`, `repositories/move_selection.rs` | Низкая |
| S6 | Ассеты шарятся между копиями (duplicate_board, paste). GC считает владельцев `NOT EXISTS × 6` по всем таблицам без индексов на `*_asset_id` → O(assets × cards) при каждом старте. | `asset_service.rs::collect_orphaned_assets` | Средняя, при 100× — критическая |
| S7 | Единственный workspace «зарезервирован» — правильно; но `workspace_id` не индексирован, а `get_home_board` делает `LIMIT 1` без ORDER — терпимо ровно до второго workspace. | `commands/boards.rs` | Допустимо |

### 2.2 Запросы и узкие места

| # | Что | Где | Сценарий |
|---|---|---|---|
| Q1 | `load_board_snapshot` = 7 запросов (по одному на kind) × 2 (canvas + unsorted) = 14 подготовленных запросов на каждую навигацию/reload. Каждый портальный запрос содержит два коррелированных подзапроса `GROUP BY` по **всем** `boards` и **всем** `cards` (не по целевым). | `repositories/cards.rs::load_cards` | При 100k карточек — полный скан `cards` на каждое открытие доски и на каждый `reloadCurrentBoard` (undo, rename, data_version). |
| Q2 | Все `document_json` всех заметок доски грузятся целиком, без пагинации и без виртуализации на канвасе. | `load_cards`, `CanvasAdapter` | Доска на 500+ заметок: JSON-сериализация через IPC + 500 инстансов Tiptap (см. F3). |
| Q3 | Поиск: 5 полных сканов таблиц, `to_lowercase()` каждой строки в Rust, потом `truncate(50)`. На каждый запрос (150 мс debounce). Далее до 50 рекурсивных CTE для breadcrumbs. | `repositories/search.rs` | 100k заметок × 500 символов = ~50 MB аллокаций на каждое нажатие клавиши, на главном потоке. |
| Q4 | `list_trash` грузит **все** удалённые строки (без LIMIT в SQL), группирует O(batches × rows) двумя `filter` на каждый batch, и делает `truncate(100)` **до** `sort_by(newest first)`. | `trash_service.rs::list_trash` | При >100 батчей самые новые батчи могут пропасть из списка (баг уже сейчас, проявится с ростом). |
| Q5 | `list_boards` (MCP) — без пагинации; ADR-0005 обещал «paginated Card summaries», нет. | `boards.rs`, `myspace-mcp.rs` | Агент на 5k досок получает мегабайты JSON. |
| Q6 | `next_card_y`/`free_position_slots`: `MAX(y+height)` по доске — с индексом `(board_id, deleted_at, z_index)` требует чтения всех карточек доски, но это норма. | — | Допустимо |

### 2.3 Дублирование и рассинхронизация

| # | Что | Где |
|---|---|---|
| D1 | Правило «ревизия = revision + 1» продублировано на фронте в 5 местах (`handleUpdateNote`, `MoveCardsCommand`, `MoveCardToBoardCommand`, `MoveBoardCommand`, reducer `cardMovedToUnsorted`). Бэкенд возвращает `()`, а не новую ревизию. Любое изменение правила (например, не бампать ревизию на move) — тихий stale_revision. | `commands/*.ts`, `current-board-store.ts` |
| D2 | Списки допустимых kind продублированы литералами в SQL ~8 раз (`kind IN ('note','image',…)`) в `trash_service`, `cards.rs` (4 функции), `empty_trash` (7 DELETE), плюс TS-юнионы в 4 файлах. Компилятор не проверяет. | см. S1 |
| D3 | Сериализация DTO ↔ схема 1:1 в трёх местах: `models.rs`, `workspace-gateway.ts`, `mock-workspace-gateway.ts`. Mock реализует бизнес-логику заново (каскады, ревизии) и признан в отчёте стабилизации как неспособный воспроизвести stale-revision баги. | `services/*` |
| D4 | `favicon_cache` — ускоряющий индекс по URL, а `collapse_favicon_duplicates` на **каждом старте** читает байты всех фавиконов (до 64 MB) и группирует по содержимому. Дедуп по контенту должен быть одноразовой миграцией + хеш при записи. | `link_metadata.rs` |
| D5 | Портальный `childCardCount`/`childBoardCount` считаются при чтении — корректно, дублирования нет. Хорошо. | — |
| D6 | `board_shortcut` читает identity JOIN'ом — корректно (ADR-0010). Хорошо. | — |

### 2.4 Миграции и эволюция схемы

| # | Что | Оценка |
|---|---|---|
| M1 | Runner: `schema_migrations(version)`, append-only, каждая миграция в транзакции. Нет защиты от **более новой** схемы: приложение старой версии откроет БД версии 19 и молча проигнорирует неизвестные kind в `load_cards` (карточки «исчезнут» на экране), а `load_card` вернёт ошибку. MCP-бинарь тоже гоняет миграции (`db::open`) → рассинхрон версий app/MCP может мигрировать БД «из-под» приложения. | Средняя сейчас, критическая при отдельной поставке MCP |
| M2 | Во время миграции `PRAGMA foreign_keys=OFF`; после — нет `PRAGMA foreign_key_check`. Миграция-пересборка `cards` могла бы потерять строки/сироты незаметно. Валидация есть только в бэкапе. | Средняя |
| M3 | Миграции — SQL-only (`include_str!`), нет data-миграций на Rust; для 100k+ строк пересборка `cards` — секунды-минуты на главном потоке при старте без индикации. | Средняя при 100× |
| M4 | `0001` содержит `PRAGMA foreign_keys = ON` внутри транзакции — no-op, безвредно. `0016` использует `CREATE TABLE IF NOT EXISTS` — единственная неидемпотентная-по-стилю аномалия. | Низкая |
| M5 | Нет `PRAGMA user_version`, нет down-миграций, нет dry-run на копии перед применением (бэкап делается, но восстановление не подключено к UI). | Средняя |

### 2.5 Устойчивость к сбоям и повреждённым данным

| # | Что | Где | Оценка |
|---|---|---|---|
| R1 | `serde_json::from_str(document_json).unwrap_or(Null)` — повреждённый JSON заметки превращается в `null` DTO. Фронт-редактор получит `null`, `useDocumentDraft` сохранит… и `handleUpdateNote` отбросит по `type !== "doc"`. Заметка «пустая» без индикации и без возможности починить. | `cards.rs::load_cards` | Средняя |
| R2 | Старт: `db::open_and_bootstrap(...).expect(...)`, `app_data_dir().expect(...)` — при повреждённой БД приложение падает без сообщения и без предложения восстановить из бэкапа. `restore_from_backup` есть, покрыт тестом, но не подключён ни к команде, ни к CLI. | `lib.rs`, `db/backup.rs` | Средняя |
| R3 | Отравленный `Mutex` (panic внутри команды) = «db lock poisoned» на все последующие команды до рестарта. Паник в командном пути мало (17 unwrap/expect в non-test коде, в основном startup), но защиты нет. | `commands/*` | Низкая |
| R4 | Отсутствующий файл ассета: `myspace-asset://` → 404, карточка показывает битую картинку; бэкап **отказывается** публиковаться (`asset missing`) → пока хотя бы один файл потерян, новых валидных бэкапов нет вообще. Один пропавший файл лишает всего механизма резервирования. | `backup.rs::copy_referenced_assets` | Средняя-высокая |
| R5 | `snapshot_on_startup` синхронно копирует все ассеты до открытия окна. При 5 GB ассетов — десятки секунд «ничего не происходит» на каждом запуске (rate limit 60 с не спасает при обычном использовании раз в день). | `lib.rs::setup` | Критическая при 10× |
| R6 | Trash: `trash_board` помечает **всё** поддерево без `deleted_at IS NULL`, перезаписывая `trash_batch_id` ранее удалённых карточек/досок; старый батч «исчезает» из Trash, restore нового батча воскрешает то, что пользователь удалял отдельно. | `trash_service.rs::trash_board`, `trash_board_in_tx` | Средняя (data-integrity) |
| R7 | `restore_trash_batch` не проверяет, что родительская доска карточки/доски жива → карточка «внутри» удалённой доски (невидима, считается в `childCardCount`), доска с удалённым предком доступна через Quick Boards/tabs с «мёртвыми» breadcrumbs. | `trash_service.rs::restore_trash_batch` | Средняя |
| R8 | `move_card_to_board` и `rename_board` не фильтруют `deleted_at IS NULL` → можно переместить/переименовать удалённую сущность через MCP или гонку. | `cards.rs`, `board_service.rs` | Низкая |
| R9 | Фронт: `useDocumentDraft` flush-on-unmount вызывает `onUpdate` **после** того, как навигация уже сделала `drainPendingWrites` и заменила `cardsRef`; `handleUpdateNote` делает `if (!note) return;` → последние ≤250 мс ввода перед клавиатурной навигацией могут молча пропасть. Требует проверки тестом. | `use-document-draft.ts`, `App.tsx:834` | Средняя (подозрение) |

### 2.6 Конкурентность, гонки, транзакционность

| # | Что | Оценка |
|---|---|---|
| C1 | **Синхронные Tauri-команды исполняются на main thread** (документация Tauri 2: non-async commands run on the main thread). Все 50 команд, кроме `enrich_embed_metadata`, — sync. Значит: каждый `load_board_snapshot`, `search_workspace`, `empty_trash` (с полным бэкапом!), `create_file_card` (qlmanage до 5 с + копирование), `import_asset`, `open_folder_in_finder` (`Command::status()`) блокируют UI-поток. Комментарии в коде («без удержания лока») защищают от блокировки *других команд*, но не UI. | Критическая (архитектурная) |
| C2 | Три писателя в одну БД: главное соединение, соединение `enrich_embed_metadata` (открывается на каждый вызов), процесс MCP. Большинство транзакций — `DEFERRED` (`conn.transaction()`), проверки «существует ли доска/ассет» делаются **до** транзакции (`create_child_board`, `move_card_to_board`, `add_quick_board`, `create_link_batch` replay-check, `create_image_card`). В WAL режиме DEFERRED-транзакция, прочитавшая до чужого коммита, при попытке записи получает `SQLITE_BUSY_SNAPSHOT` немедленно (busy_timeout не помогает) → «database error» пользователю. Только `move_selection` и `duplicate_board` используют `IMMEDIATE`. | Средняя сейчас (MCP редко пишет), высокая при активном агенте |
| C3 | `PRAGMA data_version` опрашивается каждые 3 с; любая чужая фиксация (в т.ч. **своя** enrichment через второе соединение) вызывает полный `navigateTo(board.id)` + `refreshTrash()`: сбрасывает `editingCardId` и выделение. Пользователь, печатающий заметку, пока подгружается превью ссылки, теряет режим редактирования (не текст). При активном агенте UI будет «моргать» каждые 3 с. | Средняя |
| C4 | Оптимистичные ревизии есть на card/board/viewport; для viewport это уже приводило к ложным «stale revision» баннерам (история в lessons). Ревизия на viewport — лишняя (см. §4). | Низкая |
| C5 | Фронт-очереди: `MutationQueue` (записи), `CommandDispatcher.enqueue` (команды), `navigationToken`, `viewportPersistence.inFlight`, `useWorkspaceSearch.token` — пять независимых механизмов сериализации. Работает, но взаимодействие между ними (например, dispatcher-команда и queue-запись одной карточки) не сериализовано между собой; защищает только то, что backend отвергает stale. | Допустимо |
| C6 | `synchronous=FULL` + WAL — каждая фиксация fsync. Для 250-мс автосейва заметки нормально; при батч-импорте агентом 1000 ссылок — заметно медленнее `NORMAL`. | Допустимо |

### 2.7 Кэширование

- Единственный кэш — in-memory проекция текущей доски (`current-board-store`). Инвалидация: полный reload после undo/redo/rename/data_version. Простая и корректная стратегия, но каждый reload — Q1.
- `favicon_cache` (см. D4) и `collapse_favicon_duplicates` на старте.
- Нет кэша списка досок/breadcrumbs; поиск делает до 50 рекурсивных CTE per запрос.
- Рассинхрон-риск один: оптимистичное `revision + 1` (D1).

### 2.8 Связь backend ↔ storage ↔ API ↔ UI; связанность UI со схемой

- `WorkspaceService` (ADR-0005) реализован частично: Tauri-команды в основном зовут `workspace_repository::*` напрямую, сервис используется только Quick Boards и MCP. Единого слоя бизнес-правил нет; правила размазаны по `domain/*`, `repositories/cards.rs` (1551 строка с транзакциями и валидацией — это уже не репозиторий) и командам.
- DTO — прямое отражение таблиц: UI знает `assets.filePath` и сам строит `myspace-asset://…` URL, знает `plainText`, `zIndex`, `revision`. Для desktop-приложения допустимо, но те же DTO — контракт MCP (внешний). Изменение таблицы = изменение внешнего API.
- Фронт назначает `zIndex: notes.length` / `cardsRef.current.length` — это не управление z-порядком (коллизии, нет «поднять наверх»), а способ «не 0».
- `App.tsx` — 2522 строки: оркестрация 45 методов gateway, контекстные меню, буфер обмена, drop, paste. Контроллеры уже выделены (`use-*`), но точка сборки остаётся god-component: любая новая фича проходит через него.
- MCP-бинарь хардкодит путь `~/Library/Application Support/com.bro.myspace/workspace.sqlite3` и сам запускает миграции (M1).

### 2.9 Пагинация, сортировка, поиск, агрегации

- Пагинации нет нигде (snapshot, search — лимит 50 после полного скана, trash — 100 после полного скана и до сортировки, list_boards — без лимита).
- Сортировка snapshot: по kind, затем `z_index, id` внутри kind — то есть глобальный порядок карточек по z определяет React Flow, не backend.
- Агрегации (child counts) — коррелированные GROUP BY по всей таблице (Q1).
- FTS5 доступен в бандле rusqlite (`bundled`), не используется; спецификация поиска явно откладывает («no FTS at current scale») — правильно для V1, неправильно для 100×.

### 2.10 Расширяемость: новые типы сущностей и поля

Добавить новый kind сегодня = ~15 точек:
1) миграция с пересборкой `cards` (S1); 2) новая detail-таблица; 3) `load_cards` блок; 4) `load_card` arm; 5) `models.rs` DTO + enum;
6) `trash_service` — 3 списка `kind IN` + `empty_trash` DELETE + `list_trash` JOIN/arm; 7) `cards.rs` — 4 списка `kind IN`
(move_card_to_board, move_cards_to_board_unsorted, place_unsorted_card, trash_note); 8) `search.rs`; 9) `duplicate_board`;
10) `asset_service::collect_orphaned_assets` (если владеет ассетом); 11) `backup` (если ассеты); 12) TS DTO-юнион + `TrashItemInput` + `CanvasCardKind`;
13) `card-registry`; 14) mock gateway; 15) `card-clipboard`/paste specs. Плюс MCP `read_card` match.

Компилятор ловит только Rust `match CardDto` и TS-юнионы; SQL-литералы и миграции — нет. Это главный источник
«массовой переделки» при добавлении типов. Добавление **поля** к существующему kind — дёшево (ALTER ADD COLUMN + DTO), это хорошо.

### 2.11 Конфигурация, секреты, зависимости

- Секретов нет; `env` используется только для `HOME`. CSP строгий, `capabilities/default.json` минимален. SSRF-защита в `link_metadata` (private IP, DNS-проверка, лимиты размеров) — качественная.
- Cargo.lock: 546 крейтов; `npm audit` = 0; `cargo audit`/`cargo deny` в CI нет (признано в debt). Нет Dependabot/Renovate.
- CI только на macOS-раннере (оправдано bookmarks), но из-за этого Linux-разработчик не может прогнать `cargo test` полностью локально.
- Tauri `window-state` плагин + собственная персистенция viewport — два механизма положения окна/вида; норм.
- `release.sh` — rsync в `/Applications` без подписи/нотаризации; для одного пользователя ок.

### 2.12 Тестируемость

Сильно: репозитории/домены тестируются на in-memory SQLite (201 тест), gateway-абстракция, e2e с fail-on-console-error.
Слабо: (а) mock gateway — второй бэкенд на 1355 строк, дрейфует (D3); (б) e2e никогда не бьёт в настоящий Tauri/SQLite;
(в) нет тестов производительности/бюджетов (ADR-0001 обещал «measured large-board budgets»); (г) нет тестов на «схема
новее приложения», «повреждённый document_json», «restore в удалённого родителя», «trash поверх trash».

### 2.13 Бэкап, экспорт/импорт, восстановление

- Бэкап: валидируемый, атомарный, с манифестом — хорошая инженерия. Проблемы: полное копирование ассетов при каждом снимке (R5), отказ при одном пропавшем файле (R4), ретеншн 10 × полный объём, синхронно на старте.
- Восстановление: функция есть, UI/CLI нет (todo «опционально»). `scripts/recover-missing-asset.py` — ручной инструмент.
- Экспорт/импорт workspace: отсутствуют полностью. `workspaces` зарезервирован под staging-импорт — задел есть, реализации нет.

### 2.14 Observability

Практически отсутствует: 4 `eprintln!` (favicon-dedup, asset-gc). Нет `tracing`/`log`, нет файла логов, нет тайминга
команд, нет счётчиков, нет crash-репорта. Фронт показывает баннер с текстом ошибки и всё. Диагностика инцидента «карточка
пропала» (уже был, см. handoff) возможна только по `operation_receipts` и только для move_selection.

---

## 3. Реестр рисков

Формат: Файл · Причина · Сценарий · Вероятность · Тяжесть · Рекомендация · Когда.

### 3.1 Критические архитектурные риски

**K1. Вся работа с БД и диском на главном потоке.**
`src-tauri/src/commands/*` (все `fn`, кроме `link_metadata.rs`), `lib.rs::setup`.
Причина: sync `#[tauri::command]` исполняются на main thread; один `Mutex<Connection>`.
Сценарий: Empty Trash на 2 GB ассетов → бэкап 30 с → окно «не отвечает»; drop PDF → qlmanage 5 с фриз; поиск на 50k
заметок → фриз на каждую букву. Вероятность: высокая уже при 10×. Тяжесть: высокая (UX, риск «убить» приложение → потеря
черновиков). Рекомендация: пометить все команды `#[tauri::command(async)]` (или `async fn` + `spawn_blocking`), вынести
DB в выделенный поток/actor с очередью (один writer thread, N read connections через `r2d2`-подобный пул или просто
2 соединения: read/write), бэкап — в фоновый поток с прогрессом. Когда: **сейчас** (это фундамент для всего ниже).

**K2. Бэкап копирует все ассеты каждый раз и хранит 10 полных копий; один пропавший файл отключает бэкапы.**
`src-tauri/src/db/backup.rs`. Сценарий: 3 GB ассетов → 30 GB бэкапов, старт +20–40 с; после случайно удалённого
файла — ни одного валидного снимка. Вероятность: высокая при 10×. Тяжесть: высокая (диск, старт, отсутствие бэкапа
в момент, когда он нужен). Рекомендация: снимок БД — всегда (дёшево); ассеты — инкрементально (hardlink/`clonefile` на
APFS, или content-addressed store с дедупом по хешу), пропавший файл → предупреждение в манифесте, а не отказ; ретеншн по
объёму; выполнение в фоне после старта. Когда: **сейчас/до 10×**.

**K3. Kind карточек зашит в CHECK и в ~15 литеральных списках.**
`migrations/*`, `repositories/cards.rs`, `domain/trash_service.rs`, `search.rs`, `duplicate_board.rs`, фронт.
Сценарий: «добавить тип Task/Table/Video» = пересборка `cards` (минуты на 1M строк, без FK-проверки) + правки в 15
местах, часть из которых компилятор не проверяет → тип забыт в `empty_trash` → FK-ошибка при очистке, или забыт в
`trash_note` → «не удаляется». Вероятность: неизбежна при расширении. Тяжесть: средняя-высокая. Рекомендация:
(1) убрать `CHECK(kind IN …)` из `cards`, валидировать kind в Rust (`enum CardKind` + `FromStr`), (2) единый
`CardKind::LEAF_KINDS`/`ALL` и генерация SQL-списков из него, (3) trait/реестр «kind-handler» на бэкенде: `load`,
`copy`, `delete_detail`, `search_fields`, `asset_owners` — одна точка регистрации на kind, (4) на фронте — `card-registry`
уже есть, дополнить `kind → clipboard/paste/trash` там же. Когда: **до появления второго нового типа** (P1).

**K4. Целостность Trash.**
`domain/trash_service.rs`. (a) `trash_board` перебатчивает уже удалённые элементы поддерева; (b) `restore_trash_batch`
восстанавливает в удалённого родителя; (c) `list_trash` обрезает до сортировки. Сценарий: удалил заметку A (батч 1),
потом её доску (батч 2), восстановил доску → A вернулась, батч 1 пуст; или восстановил заметку из удалённой доски →
невидимая карточка, счётчик портала врёт. Вероятность: средняя (обычный паттерн работы). Тяжесть: средняя (тихая
порча дерева). Рекомендация: `AND deleted_at IS NULL` в subtree-UPDATE; в restore — либо каскадно восстанавливать
предков, либо отказывать с понятной ошибкой и предлагать «восстановить вместе с родителем»; сортировать до truncate;
запрос trash с LIMIT в SQL. Когда: **сейчас** (мелкие правки, покрыть тестами).

**K5. Нет защиты от «схема новее приложения» и MCP-бинарь сам мигрирует БД.**
`db/migrations.rs`, `bin/myspace-mcp.rs`. Сценарий: пользователь откатился на старый `.app` после обновления, или
агент-хост запускает старый `myspace-mcp` → тихая потеря карточек на экране / мигрирование из-под приложения.
Вероятность: низкая сегодня (сборка одной командой), высокая при любой раздельной поставке. Тяжесть: высокая (тихая).
Рекомендация: при старте — если `MAX(version) > MIGRATIONS.len()` → отказ с сообщением; MCP открывает БД в режиме
«только проверить версию, не мигрировать»; после каждой миграции `PRAGMA foreign_key_check` + `integrity_check`
(quick). Когда: сейчас (10 строк).

### 3.2 Проблемы средней важности

**M-1. Полные сканы в `load_cards` (портальные подзапросы) и отсутствие индексов на `*_asset_id`, `cards(deleted_at)`.**
Файлы: `cards.rs`, `asset_service.rs`, `trash_service.rs`. Проявится при 10–100× как секунды на открытие доски/старт.
Рекомендация: подзапросы `WHERE parent_board_id IN (SELECT target_board_id … WHERE c.board_id=?1)`; индексы
`image_cards(asset_id)`, `embed_cards(asset_id)`, `embed_cards(favicon_asset_id)`, `file_cards(asset_id)`,
`file_cards(preview_asset_id)`, `boards(cover_asset_id)`, `cards(deleted_at) WHERE deleted_at IS NOT NULL` (partial).
Одна additive-миграция. Когда: P1, дёшево — можно сделать сейчас.

**M-2. Поиск без FTS.** `search.rs`. При 100× — сотни мс на клавишу, на main thread (K1). Рекомендация: FTS5 внешняя
таблица `search_index(entity_id, kind, board_id, text)` с триггерами или обновлением из тех же транзакций; ранжирование
оставить в Rust на top-N. Когда: P1 (до серьёзного роста), после K1.

**M-3. Три писателя + DEFERRED-транзакции + проверки вне транзакции.** `cards.rs`, `board_service.rs`, `quick_boards.rs`,
`commands/link_metadata.rs`. При активном агенте — `SQLITE_BUSY_SNAPSHOT`/«database is locked» в UI. Рекомендация:
все write-транзакции `IMMEDIATE`, проверки внутри транзакции, retry на BUSY в одном месте (обёртка `with_write_tx`),
enrichment — через тот же writer (после K1 это естественно). Когда: P1.

**M-4. Полный reload доски по `data_version` и после каждого undo/rename.** `App.tsx`. Сбрасывает editing/selection,
при агенте «моргает». Рекомендация: reload только если изменилась текущая доска (backend может отдавать `board.updated_at`
или счётчик изменений на доску — например, триггер/`max(updated_at)` по `cards WHERE board_id`), и точечное применение
результата команд (backend возвращает новую ревизию/DTO, а не `()`). Когда: P1.

**M-5. Дублирование `revision + 1` и `plain_text` на фронте (D1, S3).** Рекомендация: мутирующие команды возвращают
`{ revision }` или обновлённый DTO; `plain_text` считать на бэкенде из `document_json` (один кодек в Rust; TS-версия
только для мгновенного UI). Когда: P1, можно постепенно.

**M-6. Повреждённый `document_json` → `Null` без индикации (R1); краш на старте без диалога восстановления (R2);
restore не подключён.** Рекомендация: `document_json` парсить в `Result`, отдавать `{ documentJson: null, corrupt: true }`
и показывать карточку «повреждена, показать сырой текст `plain_text`»; при ошибке открытия — диалог «восстановить из
бэкапа от …» с вызовом `restore_from_backup`. Когда: P1.

**M-7. Observability = 0.** Рекомендация: `tracing` + `tracing-appender` в `<data_dir>/logs/`, span на каждую команду
с длительностью и результатом (без пользовательского контента), счётчик BUSY/stale/GC, фронт — `console.error` → команда
`log_client_error`. Без этого любые инциденты при росте — гадание. Когда: P1 (дёшево, высокий выигрыш).

**M-8. Возможная потеря последних 250 мс ввода при клавиатурной навигации (R9).** Рекомендация: воспроизвести тестом;
если подтвердится — flush в `useDocumentDraft` должен идти до `drainPendingWrites` (например, навигация сначала
сигналит `editingStopped`/blur, затем drain). Когда: сейчас, проверить.

**M-9. `list_trash` и `list_boards` без пагинации; MCP `read_board` отдаёт всё.** Когда: P2, но перед публичным MCP.

**M-10. `App.tsx` 2.5k строк.** Тесты есть, контроллеры выделены; риск — скорость изменений и регрессии. Рекомендация:
продолжить извлечение по фичам (clipboard/paste, context menus, drops) в хуки с собственными тестами; целевой размер <800.
Когда: P2, инкрементально.

**M-11. Mock gateway как второй бэкенд.** Рекомендация: e2e через реальный Rust (Tauri `tauri-driver`/WebDriver или
запуск `myspace_lib` за HTTP-шимом в тестовом режиме), mock свести к «тонкому» in-memory с общими фикстурами. Когда: P2.

### 3.3 Допустимо сейчас, переделка не нужна

- SQLite + WAL + FK + один файл БД + управляемая директория ассетов — правильный выбор для локального desktop, масштабируется до сотен тысяч карточек при нормальных индексах.
- Class-table inheritance (`cards` + detail-таблицы) — правильно; проблема не в модели, а в CHECK и литералах (K3).
- Soft-delete через `deleted_at + trash_batch_id` — правильно.
- Оптимистичные ревизии на карточках/досках — правильно (агентная запись).
- UUIDv7 с фронта + idempotent replay — правильно.
- `move_selection`/`duplicate_board` с IMMEDIATE-транзакцией и квитанциями — образец для остальных.
- `synchronous=FULL` — ок для V1.
- Одна доска в памяти, полный reload как инвалидация — ок до ~1–2k карточек на доске.
- Отсутствие пагинации внутри доски — ок: пространственная доска обычно не растёт до тысяч карточек.
- CSP/SSRF/path-boundary — хорошо, не трогать.
- `MutationQueue`/`CommandDispatcher` — достаточно; не заменять на глобальный стейт-менеджер.

### 3.4 Возможный overengineering (усложнение сейчас не оправдано)

- **Ревизия на `board_view_states`** — viewport одного пользователя; конфликты не имеют смысла, а баги «stale viewport» уже были. Достаточно last-write-wins.
- **`collapse_favicon_duplicates` на каждом старте** с чтением байтов: должно быть одноразовой миграцией + хеш (`sha256`) в `assets` при записи; тогда дедуп — просто UNIQUE-индекс/поиск по хешу.
- **Две таблицы квитанций** (`mutation_receipts` + `operation_receipts`) — объединить в одну (`operation_receipts` с `operation_kind='add_links'`), `mutation_receipts` — удалить.
- **`WorkspaceService` как полупустой passthrough** — либо довести до «единственная точка входа для команд и MCP» (стоит делать вместе с K1/K3), либо не поддерживать иллюзию слоя.
- **Mock gateway 1355 строк** — переизбыток логики в тестовом дубле (см. M-11).
- **Пять слоёв сериализации на фронте** (C5) — не добавлять шестой; при K1/M-4 часть из них (навигационный токен, viewport in-flight) можно упростить.
- **Не нужно**: ORM, отдельный core-crate, generic repository trait, event sourcing, CRDT — ADR-0005 это уже правильно отвергает.

---

## 4. Модель эксплуатации по трём режимам

Предположения о «текущем» объёме (один пользователь, несколько недель): ~30 досок, ~500 карточек, ~200 ассетов
(~200 MB), ~20 батчей в трэше.

### Режим A — текущий объём
Первое узкое место: **UI-фризы на main thread** (K1) в редких операциях — drop PDF (до 5 с), Empty Trash (полный
бэкап), импорт большого изображения. Всё остальное — миллисекунды. Trash/Search/Backup — незаметны. Главный
эксплуатационный риск — не производительность, а тихие баги целостности трэша (K4) и отсутствие логов (M-7).

### Режим B — ×10 (~300 досок, ~5k карточек, ~2k ассетов ≈ 2 GB, ~200 батчей трэша)
Первым ломается **бэкап** (K2): каждый запуск копирует 2 GB, 10 снимков = 20 GB, старт 10–30 с синхронно.
Вторым — **`list_trash`** (Q4): >100 батчей → самые новые пропадают из списка; загрузка всех удалённых строк.
Третьим — **startup GC + favicon-collapse** без индексов (S6, D4): O(assets × cards) = 2k × 5k сканов подзапросами
(SQLite оптимизирует NOT EXISTS по PK, но без индексов на `asset_id` это полные сканы detail-таблиц на каждый ассет).
Доски: если одна доска дойдёт до ~300+ заметок — 300 инстансов Tiptap без виртуализации, ощутимо на слабом Mac.
Поиск: ~5k строк — ещё десятки мс, приемлемо, но на main thread.

### Режим C — ×100 + новые типы (~3k досок, ~50k карточек, ~20k ассетов ≈ 20 GB, 3–4 новых kind)
Первым ломается **сама возможность добавить типы** (K3 + M3): пересборка `cards` на 50k+ строк при старте, без
прогресса и без FK-проверки, ×4 типа; 15 точек правок на каждый. Одновременно:
- **поиск** (Q3): полный скан 50k заметок с Unicode-lowercase на каждую букву → 200–500 мс фриза (K1);
- **`load_board_snapshot`** (Q1): два GROUP BY по 50k карточек на каждое открытие/undo/data_version-reload;
- **бэкап** невозможен в текущем виде;
- **три писателя** (M-3): агент, импортирующий сотни ссылок, конфликтует с UI-записями;
- **`data_version`-reload** каждые 3 с при активном агенте делает приложение неработоспособным во время импорта;
- MCP `list_boards`/`read_board` без пагинации — мегабайты JSON агенту.

Вывод: до ×10 достаточно P0 (+ дешёвые индексы). Переход к ×100 требует P1 целиком, и начинать нужно с K1, потому что
все остальные меры (FTS, фоновой бэкап, инкрементальные reload) опираются на «БД не на UI-потоке».

---

## 5. Roadmap

### P0 — исправить обязательно (малый объём, высокая цена ошибки)

1. **Trash-целостность** (K4): `deleted_at IS NULL` в subtree-UPDATE (`trash_board`, `trash_board_in_tx`); restore с
   проверкой живого родителя (отказ или каскад — решение за тобой, я рекомендую отказ с понятным сообщением на первом шаге);
   `sort_by` до `truncate`; LIMIT в SQL. Тесты: trash-поверх-trash, restore-в-удалённого-родителя, >100 батчей.
2. **Защита версии схемы** (K5): отказ открывать БД новее приложения; `foreign_key_check` + `quick_check` после
   миграций; MCP — без миграций (только проверка версии).
3. **Индексы** (M-1): additive-миграция 0019 с индексами на `*_asset_id`, partial-индекс `cards(deleted_at)`,
   `mutation_receipts(batch_id)`, `favicon_cache(asset_id)`. Переписать портальные подзапросы на фильтр по целевым доскам.
4. **Бэкап не должен отказывать из-за одного пропавшего файла** (R4): фиксировать `missing_assets` в манифесте,
   снимок БД публиковать всегда. (Полный редизайн бэкапа — в P1.)
5. **Проверить R9** (потеря ввода при навигации) тестом; починить, если подтвердится.
6. **Минимальный `tracing`** (M-7): файл логов, span на команду с длительностью и кодом ошибки. Это дёшево и
   даёт данные для приоритизации P1.

Ориентир: 2–4 рабочих дня, все правки локальны, миграция одна и additive.

### P1 — до серьёзного роста (структурные изменения)

1. **Снять БД с main thread** (K1): все команды `async` + `spawn_blocking`; один writer-поток с очередью (actor) и
   1–2 read-соединения; `IMMEDIATE` для всех write-транзакций, проверки внутри транзакции, единый retry на BUSY
   (`with_write_tx`); enrichment/MCP-запись — через тот же writer или с корректным retry (M-3).
2. **Бэкап 2.0** (K2): фон после старта с прогрессом; ассеты — hardlink/clonefile или content-addressed с хешем в
   `assets.sha256`; ретеншн по объёму; кнопка «Restore from backup» в UI (M-6).
3. **Реестр kind на бэкенде** (K3): `enum CardKind`, снятие `CHECK` с `cards` (последняя пересборка), trait
   `CardKindHandler { load, copy, delete_details, search_text, asset_refs }`, генерация `kind IN` из одного источника;
   на фронте — расширить `card-registry` полями clipboard/trash/paste.
4. **FTS5** (M-2) для notes/embeds/images/boards/aliases; ранжирование на top-N.
5. **Возврат ревизий/DTO из мутаций и `plain_text` на бэкенде** (M-5); убрать `+1` с фронта.
6. **Точечная инвалидация вместо полного reload** (M-4): per-board change counter; reload только своей доски; не
   сбрасывать editing при внешнем изменении другой карточки.
7. **Повреждённые данные как first-class** (M-6): `corrupt`-состояние карточки, диалог восстановления при старте.
8. **Объединить квитанции, снять ревизию с viewport, favicon-дедуп → хеш при записи** (§4 overengineering).
9. **Виртуализация/lazy-editor на канвасе**: `onlyRenderVisibleElements` в React Flow, Tiptap монтировать только в
   режиме редактирования (read-only — статический рендер HTML), убрать O(N)-строковый `cardsKey` на каждый рендер.
10. **CI**: `cargo audit`/`cargo deny`, Dependabot; тест-бюджет производительности (доска 1k карточек, поиск 50k).

### P2 — позже

1. Пагинация `list_trash`, `list_boards`, MCP `read_board` (курсоры).
2. E2E против реального Rust; mock gateway — тонкий.
3. Экспорт/импорт workspace (zip: sqlite + assets + manifest) через staging-workspace, как задумано в схеме.
4. Декомпозиция `App.tsx` по фичам (<800 строк).
5. Настоящий z-order (bring to front/back) вместо `zIndex = length`.
6. Вынести UI-лимиты из CHECK (`width/height/zoom/color_token`) в Rust-валидацию (можно совместить с последней
   пересборкой `cards` в P1.3).
7. Разделить DTO для UI и для MCP (versioned API), когда MCP станет публичным.

---

## 6. Что я бы сделал первым, если бы решал сам

P0.1 (trash) + P0.2 (версия схемы) + P0.3 (индексы) — один PR, один день. Затем P1.1 (main thread + writer actor):
это единственное изменение, после которого остальные пункты P1 становятся локальными, а не «ещё один рефакторинг
через всё приложение».

Жду подтверждения, с чего начинать, и решения по двум развилкам: (а) restore в удалённого родителя — отказ или каскад;
(б) бэкап ассетов — hardlink/clonefile (проще, привязано к APFS) или content-addressed store (универсальнее, больше кода).
