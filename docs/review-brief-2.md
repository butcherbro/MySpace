# Review Brief — Visual Workspace V1 (Slides 4–5 check)

> Для модели-архитектора. Повторная проверка после закрытия инженерного долга и
> реализации Slice 4 (доски-в-досках) и Slice 5 (undo/trash/ошибки).
> Прошлый вердикт: `docs/review-brief.md`. План: `docs/plans/2026-08-28-visual-workspace-v1.md`.

## Что сделано с прошлого ревью

- **Slice 4**: `board_service.rs` (`create_child_board` атомарно board+view_state+portal,
  идемпотентный replay, deterministic color; `rename_board`), `BoardPortalCard`,
  `card-registry.tsx`, `BoardHistory`/`BoardBreadcrumbs` + Cmd+[/], порталы переживают
  рестарт.
- **Slice 5**: `CommandDispatcher` + команды (`MoveCardsCommand`, `CreateNoteCommand`,
  `CreateChildBoardCommand`, `RenameBoardCommand`, `TrashSelectionCommand`),
  `trash_service.rs` (рекурсивная корзина + restore), `CanvasErrorBanner`/`SaveStatus`.
- Фиксы: белый экран (`crypto` fallback), бесконечный re-render (selection guard),
  click-vs-drag edit, portal double-click open.
- Inline-переименование портала (двойной клик по title), контекстное меню удаления (правый клик), Home-кнопка.

## Где смотреть (ключевые файлы)

- `src-tauri/src/domain/board_service.rs`, `trash_service.rs`
- `src-tauri/src/repositories/workspace_repository.rs` (особенно `load_cards` и `count_child_*`)
- `src/commands/{command-dispatcher,workspace-command,card-commands,board-commands,trash-commands}.ts`
- `src/canvas/CanvasAdapter.tsx`, `src/state/current-board-store.ts`
- `src/App.tsx`, `src/cards/{board,note}/`, `src/services/*`

## Открытые вопросы / техдолг (прошу оценить критичность и приоритет)

1. **`rename_board` не подключён к диспетчеру.** `RenameBoardCommand` написан, но
   `App.handleRenameBoard` вызывает `gateway.renameBoard` напрямую (см. `App.tsx`)
   → переименование НЕ отменяется (`Cmd+Z`). Один из действий выпал из undo.

2. **N+1 в portal counts.** `repository::load_cards` для каждого портала вызывает
   два отдельных `SELECT COUNT(*)` (`count_child_boards`, `count_child_cards`) внутри
   цикла. При N порталов — 2N дополнительных запросов. Прошлый вердикт это тоже
   отмечал и просил «без N+1». Не закрыто.

3. **Selection guard vs. React Flow.** `App.handleCardsSelected` сравнивает массивы
   id и не dispatch'ит при равенстве — это затычка против бесконечного re-render.
   Правильнее ли полагаться на это, или вынести selection целиком в store/adapter?

4. **NoteCard sync при rollback/reload.** `NoteCard` синхронизирует локальный буфер
   текста через паттерн `prevPlainText` только когда НЕ editing. Undo удаления →
   restore → snapshot reload может не откатить грязный текст заметки.

5. **`contextMenu` state поверх useReducer.** Контекстное меню живёт отдельным
   `useState` в `App`, а не в store. Мелкое, но ломает единообразие.

## Что уже закрыто (для полноты)

- №1 documentJson + UUIDv7; viewport durable; store; controlled adapter; transactional
  move_cards; write queue; e2e smoke — всё из прошлого вердикта закрыто.

## Вопросы рецензенту

1. Какие из 5 пунктов критичны ДО Slice 3 (rich-text) / Slice 6 (бэкапы)?
2. Затычка selection guard (п.3) — приемлема или требует правильного рефактора?
3. Есть ли скрытый долг, который аукнется на rich-text (Tiptap меняет модель
   содержимого заметки)?

Ограничение: кратко, файл+строка, без пересказа плана.
