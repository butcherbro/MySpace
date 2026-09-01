# Review Brief — Visual Workspace V1 (progress vs. plan)

> Для модели-рецензента. Проект — десктопное приложение «MySpace» (Milanote-подобное
> визуальное пространство: бесконечный канвас, заметки, вложенные доски через
> порталы). План: `docs/plans/2026-08-28-visual-workspace-v1.md`.
>
> Задача: оценить, (1) соответствует ли реализация плану и ADR, (2) какие
> упрощения критичны и должны быть переделаны ДО расширения, (3) куда реализация
> свернула не туда. Не пересказывать план. Смотреть на код.

## Точка отсчёта: что уже реализовано

> Актуализация (после ревью): закрыты пункты №1 (documentJson + UUIDv7) и №3
> (viewport durable). Оставшиеся — №2 store, №2b controlled adapter, №5
> transactional move_cards, e2e smoke. См. `tasks/current-state.md`.

Стек зафиксирован: Tauri 2 + React 19 + TypeScript + Vite 8, React Flow 12 (`@xyflow/react`)
за адаптером, SQLite (`rusqlite` bundled), тесты Vitest + Playwright + `cargo test`.
Точные версии — в `package.json` / `src-tauri/Cargo.toml` (совпадают с «Ecosystem
snapshot» плана, кроме Tiptap — он ещё НЕ подключён).

Готово по слайсам плана:

- **Slice 0** — репозиторий, scaffold, quality gates (`npm run check`, `cargo test`, clippy). ✅
- **Slice 1** — SQLite-схема + миграции, bootstrap (1 workspace + Home root board),
  репозиторий `load_board_snapshot`/`create_note`, typed gateway (Tauri + mock),
  `NoteCard`, заметка переживает перезапуск. ✅
- **Slice 2 (частично)** — `canvas-types.ts`, `canvas-mapping.ts`, `CanvasAdapter.tsx`
  (React Flow за границей), перетаскивание карточек, персист геометрии (`move_card` +
  optimistic revision). ✅
- **Ещё НЕ сделано:** Tiptap (Slice 3), вложенные доски/порталы (Slice 4), undo/trash
  (Slice 5), бэкапы (Slice 6). Store текущей доски (Task 2.2) — сделано упрощённо.
  Персист вьюпорта (половина Task 2.3) — не сделан.

## Что смотреть (конкретные файлы)

### Rust (авторитетный слой)
- `src-tauri/migrations/0001_workspace.sql` — схема (сверка с планом «Section C Data Model»).
- `src-tauri/src/db/{mod,migrations,bootstrap}.rs` — соединение, PRAGMA, версионированные миграции, первичный bootstrap.
- `src-tauri/src/domain/{models,errors}.rs` — DTO (camelCase), ошибки.
- `src-tauri/src/repositories/workspace_repository.rs` — `load_board_snapshot`, `create_note`, `update_note`, `update_card_frame` (все с optimistic `expected_revision`).
- `src-tauri/src/commands/{boards,cards}.rs` — Tauri-команды (обёртки).

### Frontend (проекция)
- `src/services/workspace-gateway.ts` — контракт gateway + DTO.
- `src/services/{tauri,mock}-workspace-gateway.ts`, `create-gateway.ts`.
- `src/canvas/{canvas-types,canvas-mapping,CanvasAdapter}.tsx` — изоляция React Flow (ADR-002).
- `src/cards/note/NoteCard.tsx` — минимальная заметка (textarea, без rich-text).
- `src/App.tsx` — КЛЮЧЕВОЙ: здесь живёт состояние текущей доски (упрощение, см. ниже).

## Мои честные «известные упрощения» (прошу оценить критичность)

1. **Store текущей доски (Task 2.2) не вынесен.** Состояние (`notes`, `board`,
   `viewport`) лежит прямо в `src/App.tsx` через `useState`. План требует отдельный
   reducer/context store. Это станет больно при порталах/навигации/undo.

2. **`dependencyKey` в `CanvasAdapter.tsx`.** Чтобы текст заметки перерисовывался после
   правки, я передаю в адаптер строку-хеш контента и пересоздаю nodes при её смене.
   Работает, но это не «честный» controlled-паттерн React Flow — полумера. Стоит ли
   заменить на корректную синхронизацию `nodes` через `useNodesState` + эффект/данные?

3. **Персист вьюпорта не сделан** (вторая половина Task 2.3). Позиция/зум канваса не
   пишутся в `board_view_states`. Требует trailing debounce 400 мс (по плану).

4. **Write queue нет** (`src/persistence/entity-write-queue.ts` из плана). Записи
   заметок идут прямо из обработчиков. Per-note сериализованная очередь с
   `expectedRevision` ещё не сделана.

5. **Selection/marquee/Shift-click**, описанные в Task 2.1, подключены в `CanvasAdapter`
   на уровне пропсов React Flow, но полноценный селекшн-контракт (редактор-фокус
   handoff, смешанное перемещение) ещё не проверен/не покрыт.

## Куда движемся дальше (для контекста риска)

Ближайшая крупная фича — **Slice 4: доски-в-досках** (порталы-квадратики со скруглением,
breadcrumbs, back/forward, рекурсивный Trash). Это сильно зависит от чистого store и
навигации, поэтому хочу закрыть инженерный долг ДО неё.

## Что прошу от рецензента (конкретно)

1. Где реализация **расходится с планом/ADR** (особенно ADR-002, ADR-003, Section C/E/G/H)?
2. Какие из 5 упрощений **критичны к переделке сейчас** vs «допустимо отложить»?
3. Есть ли **скрытый технический долг**, которого я не назвал, но который аукнется при
   масштабировании (порталы, undo, рост числа карточек)?
4. Порядок следующих шагов: что чинить первым, чтобы не переписывать потом.

Ограничение объёма: краткие пункты с указанием файла/строки, без пересказа плана.
