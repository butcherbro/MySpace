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

Инженерный долг, Slice 4 и Slice 5 закрыты. **Slice 3 (Tiptap) в работе** —
редактор подключён (documentJson-authoritative + derived plainText), заметки
уже редактируются через Tiptap; осталось добить rich-text toolbar/контракт и
перепроверить поведение на живом приложении.

### Сделано в рамках Slice 3 (на текущий момент)

- `src/editor/NoteEditor.tsx` — изоляция Tiptap (StarterKit subset: heading 1-3,
  bold/italic, lists, blockquote). `editable` синхронизируется через
  `setEditable` + автофокус при входе в editing; классы `nodrag nopan nowheel`
  на EditorContent; caret не принуждается к концу (`focus()` без позиции).
- `src/editor/editor-extensions.ts` — всё вне V1 явно отключено (`codeBlock`,
  `code`, `link`, `strike`, `underline`, `horizontalRule` = false), чтобы paste/
  shortcuts не протащили чужие структуры в БД.
- `src/editor/note-document.ts` — собственный `NoteDocument` + `isNoteDocument`
  runtime validation (граница сохранения в `App.handleUpdateNote`).
- `src/editor/document-codec.ts` — `documentToPlainText` читает полный ProseMirror.
- `src/cards/note/NoteCard.tsx` — draft lifecycle: `dirtyRef` + `persistedDocumentRef`,
  синхронизация входящего `note.documentJson` только при clean; ошибка сохранения
  оставляет редактор открытым (не `onDeactivate`); flush при blur + при `editing`→false
  (навигация/trash).
- `src/App.tsx` — `handleUpdateNote` больше НЕ проглатывает ошибку (reject + banner);
  валидация документа перед `gateway.updateNote`.
- `src/test/prosemirror-mocks.ts` — jsdom-полифиллы ProseMirror/Tiptap.
- Тесты: `NoteCard.test.tsx` (буфер/дебаунс/флаш/ошибка-сохранения/синхронизация),
  `NoteEditor.test.tsx` (toggle editable), `note-document.test.ts` (схема), второй
  e2e `typing persists and survives blur`.

### Открыто по вердикту ревью (rework-задачи, не блокеры данных)

- **Bubble menu / toolbar** для rich-text (обязателен до объявления Slice 3
  завершённым). Держать внутри `NoteEditor`.
- **plainText-точность** (нумерация списков, codeBlock-переносы) — отложить до
  поиска/export; documentJson авторитетен, данные не теряются.
- **Закрытие окна + последний flush** — сейчас flush покрывает blur и навигацию,
  но не `window/tauri close` с pending draft. Нужен отдельный close-flush хук.
- **Bundle 783KB** — разбиение на чанки/ленивый mount редактора (Slice 6).

## Порядок будущих работ (по приоритету)

1. **Slice 3** — rich-text заметки (Tiptap: заголовки/bold/italic/списки/blockquote).
   Фундамент готов (documentJson-authoritative + derived plainText), редактор
   подключён. Осталось: rich-text toolbar/bubble-menu, полный Tiptap focus-handoff
   (если нужно сверх автофокуса), перепроверка на живом `tauri dev`.
2. **P2 долг** — selection refactor (убрать затычку-грухад, централизовать selection),
   contextMenu → store (сейчас локальный useState).
3. **Изображения** — карточка-изображение: фото + подпись-текст под ним (та же механика,
   что заметка). НЕ входит в V1-план (non-goal), добавить после rich-text. Требует решения
   про хранение файлов (локально в `Application Support/myspace/assets/`).
4. **Slice 6** — бэкапы (SQLite online backup, retention 10) + производительность (fixtures
   100/500/1000 карточек, бюджеты).

## Крупные открытые фичи

- Slice 3: Tiptap rich-text.
- Slice 6: бэкапы + производительность (V1.1).
- Изображения (после Slice 3).
- Вид: палитра порталов реализована в `BoardPortalCard`.
