# Review Brief — Visual Workspace V1 (Slice: images / assets)

> Для модели-архитектора. Проверка среза «картинки и assets» — первый новый тип
> карточки после V1-ядра (`note`, `board_portal`). Прошлые вердикты: `docs/review-brief.md`,
> `docs/review-brief-2.md`, `docs/review-brief-3.md`. План: `docs/plans/2026-08-28-visual-workspace-v1.md`.

## Что сделано (новое в этом срезе)

- **Хранение файлов**: copy-in модель — файл копируется в `Application Support/com.bro.myspace/assets/<uuid-v7>.<ext>`,
  SQLite хранит только метаданные в таблице `assets` (id, file_path, mime, name, размер), НЕ байты.
- **`asset_service::import_asset`** (Rust) — копирует файл + пишет метаданные, идемпотентен.
- **`create_image_card` / `update_image_caption`** (repo + команды) — карточка-изображение
  с редактируемой rich-text подписью (зеркало `note` pipeline: optimistic revision guard).
- **Миграция `0002_assets`** — `assets` + `image_cards` + `embed_cards` + расширение `cards.kind`
  (ре-создание таблицы `cards` с новым CHECK, т.к. SQLite не поддерживает ALTER CHECK).
- **Custom URI protocol** `myspace-asset://localhost/<file_path>` — отдаёт файл из asset-дир;
  путь строится из относительного `file_path` в `assets/`.
- **`tauri-plugin-dialog`** (Rust + JS) для выбора файла; изолирован в `src/services/asset-picker.ts`.
- **Фронт**: `ImageCard` (картинка + подпись через переиспользованный `NoteEditor`), ветка в
  `card-registry`, кнопка «Add image», типы `ImageCardDto`/`AssetDto` в gateway+mock.
- `trash_note` расширен до leaf-карточек (`note`/`image`/`embed`).

## Статус проверки

`cargo test` — 37 тестов; `npm run check` — 69; `npm run test:e2e` — 4/4; clippy+fmt чистые; build ok.

## Где смотреть

- `src-tauri/src/domain/asset_service.rs`, `src-tauri/src/db/migrations.rs`, `src-tauri/migrations/0002_assets.sql`
- `src-tauri/src/repositories/workspace_repository.rs` (`load_cards` image block, `create_image_card`, `update_image_caption`)
- `src-tauri/src/lib.rs` (URI protocol `myspace-asset`, dialog plugin)
- `src/cards/image/ImageCard.tsx`, `src/services/asset-picker.ts`, `src/services/workspace-gateway.ts`

## Открытые вопросы / риски (прошу оценить)

1. **Миграция 0002 пересоздаёт `cards`.** SQLite не умеет ALTER CHECK, поэтому DROP+recreate.
   Я починил FK (`run_migrations` отключает `foreign_keys` на connection вне транзакции),
   есть регрессионный тест. Но в проде уже есть БД с данными — оцени, насколько это
   безопасно/масштабируемо, и не лучше ли вместо пересоздания вовсе убрать CHECK и
   валидировать `kind` на уровне приложения (Rust), чтобы избегать table-rebuild в будущих миграциях.

2. **Custom URI protocol + безопасность.** `myspace-asset://localhost/<file_path>` отдаёт любой
   относительный путь внутри `assets/`. Фронт сам собирает URL из `file_path` (он приходит из БД).
   Есть ли вектор path-traversal (`../`) и нужно ли дополнительно канонизировать путь в Rust
   (сейчас просто `asset_dir.join(relative)`)? Оцени.

3. **GC файлов НЕ реализован.** При удалении карточки в корзину файл остаётся на диске.
   План — очистка корзины запускает GC: удалить asset, на который больше не ссылается ни одна
   карточка (`image_cards.asset_id`, `embed_cards.asset_id`). Сейчас связи уже есть, но GC-функции
   и «очистить корзину» в UI нет. Нужен ли refcount/отдельная операция, или достаточно запроса
   по ссылкам при GC? Это блокирует удаление, но не потерю данных — приоритет?

4. **Подпись = переиспользованный NoteEditor.** `ImageCard` держит ЛОКАЛЬНОЕ `editing` state
   (двойной клик → edit), в отличие от `NoteCard`, где editing контролит App через
   `editingCardId` (click-vs-drag на canvas). Для image-caption локальное editing допустимо
   (двойной клик ≠ drag), но порождает два разных паттерна «кто владеет editing». Согласовать
   или это ок для V1?

5. **Тот же draft-sync долг из прошлого брифа** (NoteCard не синхронизирует `draftDocument`/ref
   при snapshot-reload/undo-restore; и сравнение документа по ссылке в `handleBlur`) — теперь этот
   же паттерн скопирован в `ImageCard`. Остаётся un-fixed. Критично ли перед накоплением данных?

## Что уже закрыто (для полноты)

- documentJson-authoritative + derived plainText; note draft lifecycle; автофокус editor;
  клавиатурный/selection-фиксы из прошлых срезов.

## Вопросы рецензенту

1. П.1 (миграция) и п.2 (URI protocol path) — есть ли реальный риск, или текущий вариант приемлем?
2. П.3 (GC) — какое решение выбрать для удаления файлов при очистке корзины?
3. П.4 + п.5 — редакториальная согласованность (владелец editing) и draft-sync долг — насколько срочно?

Ограничение: кратко, файл+строка, без пересказа плана.
