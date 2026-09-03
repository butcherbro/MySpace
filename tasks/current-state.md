# Current State — Visual Workspace V1

> Актуальное состояние, принятые решения и следующий шаг. Держать в актуальном виде.

## Принятые решения (не менять без необходимости)

- Стек: Tauri 2 + React 19 + TS + Vite 8, React Flow за `CanvasAdapter`, SQLite (`rusqlite`).
- **ID генерирует фронт** через `UuidV7Generator` (UUIDv7), а НЕ backend; ID остаётся входным параметром `create_*`. Причины — в `tasks/lessons.md`.
- **`document_json` авторитетен** для текста заметки; plain text кодируется через `src/editor/document-codec.ts` (ProseMirror-совместимо), чтобы быть готовым к Tiptap.
- Store текущей доски — **`useReducer` + Context** (без новых зависимостей).
- Optimistic `revision` + stale-write rejection — на всех мутациях.

## Статус задач (по вердикту рецензента + слайсам)

- [x] №1 — documentJson + IdGenerator (UUIDv7)
- [x] №3 — viewport durable (`board_view_states` + `save_viewport` + debounce 400мс)
- [x] №2 — вынести store текущей доски из `App.tsx` (snapshot/selection/revisions/rollback)
- [x] №2b — сделать `CanvasAdapter` controlled, убрать `dependencyKey`
- [x] №5 — transactional `move_cards` (multi-card drag = одна транзакция) + selection-контракт
- [x] write queue — сериализация мутаций (`MutationQueue`) против revision-гонок
- [x] e2e — smoke-тест против MockWorkspaceGateway (click-versus-drag)
- [x] Slice 4 — доски-в-досках: `create_child_board`/`rename_board` (Rust), `BoardPortalCard`,
  `card-registry`, `BoardHistory`/`BoardBreadcrumbs` + Cmd+[/], порталы переживают рестарт.

## Следующий шаг

Инженерный долг и Slice 4 закрыты. На очереди — **Slice 3 (rich-text заметки, Tiptap)**
либо **Slice 5 (undo + Trash)**.

## Крупные открытые фичи

- Slice 3: Tiptap rich-text (находки/заголовки/списки).
- Slice 5: undo/redo, рекурсивный Trash, наблюдаемые ошибки сохранения.
- Slice 6: бэкапы + производительность.
- Вид: палитра порталов (terracotta/moss/sky/sand/ink) реализована в `BoardPortalCard`.
