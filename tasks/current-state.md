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
- [x] №2 — вынести store текущей доски из `App.tsx` (snapshot/selection/revisions/rollback)
- [x] №2b — сделать `CanvasAdapter` controlled, убрать `dependencyKey`
- [x] №5 — transactional `move_cards` (multi-card drag = одна транзакция) + selection-контракт
- [x] write queue — сериализация мутаций (`MutationQueue`) против revision-гонок
- [x] e2e — smoke-тест против MockWorkspaceGateway (click-versus-drag)

## Следующий шаг

Инженерный долг закрыт. Следующий крупный шаг — **Slice 4: доски-в-досках (порталы)**.
Перед ним — ручной focus gate в `npm run tauri dev` + повторное ревью среза.

## Ручной focus gate (до порталов)

1. Одинарный клик по Note — сразу ввод текста.
2. Набрать длинный текст без потери фокуса.
3. Выделить часть текста мышью.
4. Cmd+A внутри textarea выделяет текст, не карточки.
5. Click-hold + движение перетаскивает Note без случайного редактирования.
6. После drag следующий обычный клик снова включает редактор.

## Крупные открытые фичи (после закрытия долга)

- Slice 4: доски-в-досках (порталы-квадратики, breadcrumbs, back/forward, Trash).
- Slice 5: undo/trash. Slice 6: бэкапы + производительность.
- Вердикт рецензента: `docs/review-brief.md` (P1/P2 + порядок работ).
