# Current State — Visual Workspace V1

> Актуальное состояние, принятые решения и следующий шаг. Держать в актуальном виде.

## Принятые решения (не менять без необходимости)

- Стек: Tauri 2 + React 19 + TS + Vite 8, React Flow за `CanvasAdapter`, SQLite (`rusqlite`).
- **ID генерирует фронт** через `UuidV7Generator` (UUIDv7), а НЕ backend; ID остаётся входным параметром `create_*`. Причины — в `tasks/lessons.md`.
- **`document_json` авторитетен** для текста заметки; plain text кодируется через `src/editor/document-codec.ts` (ProseMirror-совместимо), чтобы быть готовым к Tiptap.
- Store текущей доски — **`useReducer` + Context** (без новых зависимостей).
- Optimistic `revision` + stale-write rejection — на всех мутациях.

## Статус задач (по вердикту рецензента)

- [x] №1 — documentJson + IdGenerator (UUIDv7)
- [x] №3 — viewport durable (`board_view_states` + `save_viewport` + debounce 400мс)
- [ ] №2 — вынести store текущей доски из `App.tsx` (snapshot/selection/revisions/rollback)
- [ ] №2b — сделать `CanvasAdapter` controlled, убрать `dependencyKey`
- [ ] №5 — transactional `move_cards` (multi-card drag = одна транзакция) + selection-контракт
- [ ] e2e — smoke-тест против MockWorkspaceGateway (Вариант A)

## Следующий шаг

№2: store. Подход — `useReducer` + Context (план допускает Zustand только если reducer
окажется неадекватным; пока принято reducer ради отсутствия новых зависимостей).

## Крупные открытые фичи (после закрытия долга)

- Slice 4: доски-в-досках (порталы-квадратики, breadcrumbs, back/forward, Trash).
- Slice 5: undo/trash. Slice 6: бэкапы + производительность.
- Вердикт рецензента: `docs/review-brief.md` (P1/P2 + порядок работ).
