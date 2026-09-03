# Review Brief — Visual Workspace V1 (Slice 3: rich-text Tiptap)

> Для модели-архитектора. Проверка первого рабочего среза Slice 3 — заметки
> переведены с `textarea` на Tiptap (documentJson-authoritative). Прошлые вердикты:
> `docs/review-brief.md`, `docs/review-brief-2.md`. План: `docs/plans/2026-08-28-visual-workspace-v1.md`
> (секции M/N/O, D2 rich-text scope, Task 3.1–3.3).

## Что сделано (новое в этом срезе)

- **Tiptap подключён** (`@tiptap/react` + `@tiptap/starter-kit` v3.31.2), изолирован за
  `src/editor/NoteEditor.tsx` — типов Tiptap наружу нет, контракт `document` + `onChange` + `onBlur`.
- **`document_json` авторитетен.** `src/cards/note/NoteCard.tsx` шлёт полный ProseMirror JSON
  в `onUpdate`; `plainText` вычисляется как derived через `documentToPlainText`
  (`src/App.tsx:156`). Старая механика `plainTextToDocument` на каждый `onUpdate` убрана.
- **`src/editor/document-codec.ts`**: `documentToPlainText` читает полный ProseMirror
  (heading/списки/blockquote/codeBlock/marks/hardBreak). `plainTextToDocument` остался
  только для создания новой пустой заметки.
- **Debounce 250мс + flush-on-blur** в NoteCard через `onBlur` от NoteEditor (НЕ setState-in-effect).
- **`NoteEditor` синхронизирует `editable`** через `editor.setEditable(editable)` + автофокус
  при входе в editing (`src/editor/NoteEditor.tsx:51-58`). До этого `contenteditable` не менялся
  после mount (регрессия, ломавшая click-to-edit).
- jsdom-полифиллы ProseMirror (`src/test/prosemirror-mocks.ts`); `NoteCard.test.tsx` переписан
  под мок `NoteEditor`; новый `NoteEditor.test.tsx` (toggle editable); `canvas-smoke.spec.ts`
  обновлён на `.note-card [contenteditable="true"]`.

## Статус проверки

`npm run check` — 62 теста; `npm run test:e2e` — 1/1; `cargo test` — 30/30; `npm run build` — ok.

## Где смотреть (ключевые файлы)

- `src/editor/{NoteEditor.tsx, editor-extensions.ts, document-codec.ts}`
- `src/cards/note/NoteCard.tsx`
- `src/App.tsx` (`handleUpdateNote:148`, `handleCardActivated:289`)
- `src/test/prosemirror-mocks.ts`, `src/cards/note/NoteCard.test.tsx`, `src/editor/NoteEditor.test.tsx`

## Открытые вопросы / техдолг (прошу оценить критичность и приоритет ДО Slice 6)

1. **NoteCard не синхронизирует `draftDocument`/`draftDocumentRef` при смене `note.documentJson`.**
   `useState(note.documentJson)` + `useRef` задаются один раз при mount
   (`NoteCard.tsx:35-36`). При snapshot-reload или undo-restore (trash restore) заметка может
   перерисоваться с новым `note.documentJson`, но локальный буфер останется старым →
   blur отправит устаревший документ. Это прошлый п.4, так и не закрыт — критичен ли он уже
   сейчас, когда Tiptap стал авторитетным источником контента?

2. **Сравнение документов по ссылке в `handleBlur`.**
   `NoteCard.tsx:91` — `latest !== note.documentJson`, где `latest` это `draftDocumentRef.current`
   (объект). Сравнение по ссылке: после ввода текста буфер всегда «новый объект», а после
   `NoteEditor.setContent` (внешняя синхронизация) ссылка `note.documentJson` может расходиться
   с реальным JSON editor'а. При blur без реальных изменений может уйти лишний `onUpdate`
   (пишет тот же документ, но бьёт по revision и очереди). Оценить, нужен ли deep-equal
   документов вместо `draftDocumentRef !== note.documentJson`.

3. **`documentToPlainText` теряет нумерацию и структуру.** `blockToText` для `orderedList`
   рендерит маркер `•` так же, как `bulletList` (`document-codec.ts:52-61`) — порядковые номера
   теряются. `horizontalRule` даёт `---`, но `codeBlock` без учёта переносов (multiline).
   `plain_text` считается derived/search-friendly — критично ли точное соответствие, или
   plainText остаётся «для поиска» и сойдёт?

4. **Типобезопасность документа.** `NoteCard` и `NoteEditor` гоняют документ как `unknown`
   (`NoteCardProps.onUpdate: (id, document: unknown)`). `document-codec` вводит локальный
   `PMNode`, но он не совпадает с `JSONContent` Tiptap. При росте схемы (link/table/embed)
   риск рассинхрона между декодером и реальным PM-деревом растёт. Нужен ли единый
   shared-тип документа на границе card ↔ editor ↔ gateway?

5. **Rich-text toolbar отсутствует.** StarterKit подключён (heading 1-3, bold, italic, списки,
   blockquote — `editor-extensions.ts`), но пользовательского UI для вставки этих форматов
   нет. Следующий кусок Slice 3 — bubble-menu/toolbar. Согласуется ли это с планом (Task 3.3)
   или форматирование должно быть доступно раньше?

## Что уже закрыто (для полноты)

- documentJson authoritative + derived plainText (прошлый «главный скрытый долг под Tiptap»).
- flush-on-blur без setState-in-effect (прошлый lint-блокер).
- автофокус editor при входе в editing (прошлый регресс «заметки не редактируются»).
- e2e smoke переведён на Tiptap-DOM, click-versus-drag работает в реальном браузере.

## Вопросы рецензенту

1. Какие из п.1–5 критичны ДО того, как пользователь накопит реальные заметки (потеря данных)?
2. Сравнение документов по ссылке (п.2) — принять как есть или заменить deep-equal/JSON-stringify?
3. Достаточно ли текущей изоляции Tiptap за `NoteEditor` для последующего Slice 3
   (toolbar/bubble-menu) и будущих карточек-изображений с подписью, или контракт надо расширить?

Ограничение: кратко, файл+строка, без пересказа плана.
