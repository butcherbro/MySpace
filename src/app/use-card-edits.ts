import { useCallback, useRef, type Dispatch, type RefObject } from "react";
import { documentToPlainText, normalizeDocument, plainTextToDocument } from "../editor/document-codec";
import type { DocumentSaveConflict, DocumentSaveOptions, DraftLineage } from "../editor/corrupt-document";
import { classifyLinkConversion } from "../cards/link/link-conversion";
import {
  CreateNoteCommand,
  EditCardTextCommand,
  ResizeCardCommand,
  sameDocument,
  sameFrame,
  type TextCardKind,
} from "../commands/card-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { IdGenerator } from "../services/id-generator";
import type { ResizeOptions } from "../cards/resize-options";
import { errorMessage } from "../services/error-message";
import type {
  CardDto,
  EmbedCardDto,
  ImageCardDto,
  NoteCardDto,
  TextReceipt,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { BoardViewAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";
import type { MutationQueue } from "../persistence/entity-write-queue";
import { isStaleRevisionError, markStaleRevisionHandled } from "./stale-revision-reload";
import { conflictCopyDocument, conflictCopyFrame } from "./note-conflict-copy";
import { endDraftHandoff, offerDraftHandoff } from "../editor/draft-handoff";
import type { ErrorReportDetails } from "./error-reports";

/**
 * Card content edits: persisting a note/caption/embed-description save to its
 * card, note->embed finalize conversion, and frame resize — one card at a
 * time, serialized through the shared mutation queue.
 *
 * Undo history: every save goes straight to the gateway as before, and the
 * finished edit is recorded afterwards with `dispatcher.record` — one entry per
 * text edit session (first save → finalize) and one per resize gesture.
 * Automatic fit-to-content resizes (`{ auto: true }`) are not recorded.
 *
 * Note text conflicts: a note save carries the draft's `base`. If the stored
 * text is no longer the base (the held copy already shows another writer's
 * text, or the save is refused as stale and the stored card has it), the save
 * does not overwrite it: the user's text becomes a new "Conflict copy" note
 * next to the original, created as an undoable note creation, and the save
 * resolves with a `DocumentSaveConflict`. A refused save whose stored text is
 * still the base (someone changed only the frame or color) is written again at
 * the stored revision.
 *
 * Extracted from `App.tsx` (docs/plans/2026-09-26-app-tsx-split.md, step 7).
 */

export interface CardEditsOptions {
  gateway: WorkspaceGateway;
  dispatch: Dispatch<BoardViewAction>;
  /** Applies every write answer to `cardsRef` and the store together. */
  cardWrites: CardWrites;
  queueRef: RefObject<MutationQueue>;
  cardsRef: RefObject<CardDto[]>;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  /** Saves an error report with details the banner does not show. */
  recordErrorReport?: (details: ErrorReportDetails) => void;
}

export interface CardEditsController {
  handleUpdateNote: (
    id: string,
    document: unknown,
    options?: DocumentSaveOptions,
  ) => Promise<void | DocumentSaveConflict>;
  handleFinalizeNote: (
    id: string,
    document: unknown,
    options?: DocumentSaveOptions,
  ) => Promise<void | DocumentSaveConflict>;
  handleUpdateImageCaption: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleFinalizeImageCaption: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleUpdateEmbedDescription: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleFinalizeEmbedDescription: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleResizeNote: (id: string, width: number, height: number, options?: ResizeOptions) => void;
}

/** A text edit session: the card's document before its first save. */
interface TextSession {
  kind: TextCardKind;
  before: unknown;
  /** False when the session repairs a corrupt document: its undo would restore the damage. */
  recordable: boolean;
}

/** The `acknowledgeCorrupt` flag of a text write, present only when set (P1.7). */
function acknowledgeCorrupt(options?: DocumentSaveOptions): { acknowledgeCorrupt?: true } {
  return options?.acknowledgeCorrupt ? { acknowledgeCorrupt: true } : {};
}

/** The banner after a note's text went to a conflict copy. */
const NOTE_CONFLICT_MESSAGE =
  "This note was changed elsewhere while you were editing it. Your text was saved next to it as a \"Conflict copy\" note.";

/** The banner when the conflict copy could not be created; the text itself goes to the error report. */
const CONFLICT_COPY_FAILED_MESSAGE =
  "This note was changed elsewhere and your text could not be saved as a \"Conflict copy\" note. It is in the saved error report (\"Copy report\"), and in the note's editor while it stays open.";

/** The banner when keys typed while editing moved to a conflict copy never reached its editor. */
const HANDOFF_INPUT_LOST_MESSAGE =
  "Some text typed while editing moved to the \"Conflict copy\" note did not reach it. It is in the saved error report (\"Copy report\").";

/** How long an autosave waits before trying a failed conflict copy again; doubles up to the cap. */
export const COPY_RETRY_MS = 2_000;
const COPY_RETRY_MAX_MS = 30_000;

/** Failed attempts to create one draft's conflict copy. */
interface CopyFailure {
  /** An autosave does not try again before this time. */
  retryAt: number;
  delay: number;
  /** The text the last error report carries. */
  reported: unknown;
}

/** What `createConflictCopy` needs. */
interface CopyRequest {
  /** The copy goes right of this card, on its board. */
  beside: NoteCardDto;
  colorToken: string;
  /** The text the copy holds. */
  mine: unknown;
  /** The newest text, for an error report. */
  latest: () => unknown;
  /** One series of failures: the draft's lineage. */
  key: object;
  finalize: boolean;
}

/** The conflict copy could not be created. */
class ConflictCopyFailedError extends Error {}

/** A conflict settled by a copy, and what was last written into the copy. */
interface SettledConflict {
  conflict: DocumentSaveConflict;
  copyId: string;
  written: unknown;
  revision: number;
}

/** The banner action for a failed card write; a lost conflict copy stays on screen through a board switch. */
function failedAction(e: unknown): BoardViewAction {
  const message = errorMessage(e);
  return e instanceof ConflictCopyFailedError
    ? { type: "failed", message, outlivesBoardSwitch: true }
    : { type: "failed", message };
}

/** A short, human-friendly URL for display (strips scheme and trailing slash). */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return path ? `${host}${path}` : host;
  } catch {
    return raw;
  }
}

export function useCardEdits(deps: CardEditsOptions): CardEditsController {
  const { gateway, dispatch, cardWrites, queueRef, cardsRef, dispatcher, idGenerator, recordErrorReport } = deps;

  // Открытые сессии правки текста по id карточки. Сессия открывается первой
  // записью (автосейв или сразу finalize) и закрывается успешным finalize, так
  // что `before` — документ до сессии, а не до очередного debounce-сохранения.
  const textSessionsRef = useRef(new Map<string, TextSession>());

  const openTextSession = useCallback(
    (id: string, kind: TextCardKind, before: unknown, corrupt: boolean | undefined) => {
      const sessions = textSessionsRef.current;
      if (!sessions.has(id)) sessions.set(id, { kind, before, recordable: corrupt !== true });
    },
    [],
  );

  // Конфликты, уже разрешённые копией, по линии черновика: сохранения той же
  // правки копию второй раз не создают, а дописывают в неё новейший текст.
  const settledConflictsRef = useRef(new WeakMap<DraftLineage, SettledConflict>());
  // Что этот клиент последним записал в копию из черновика оригинала: для
  // черновика самой копии это своя запись, а не чужая правка (её текст он уже
  // получил при передаче правки, см. draft-handoff.ts).
  const copyWritesRef = useRef(new Map<string, unknown>());
  // Сбои создания копии по линии черновика: автосейв раз в 250 мс не повторяет
  // создание и не пишет по отчёту на каждую попытку.
  const copyFailuresRef = useRef(new WeakMap<object, CopyFailure>());

  // Новая заметка «Conflict copy» с текстом `mine` справа от `beside`, как
  // отменяемое создание. На доску её кладёт вызывающий.
  const createConflictCopy = useCallback(
    async ({ beside, colorToken, mine, latest, key, finalize }: CopyRequest): Promise<NoteCardDto> => {
      const failure = copyFailuresRef.current.get(key);
      // Повтор — после паузы (она растёт) или при завершении правки: это действие
      // пользователя, а не таймер.
      if (failure && !finalize && Date.now() < failure.retryAt) {
        throw new ConflictCopyFailedError(CONFLICT_COPY_FAILED_MESSAGE);
      }
      const copyId = idGenerator.nextId();
      const documentJson = conflictCopyDocument(mine);
      const copy: NoteCardDto = {
        kind: "note",
        id: copyId,
        boardId: beside.boardId,
        frame: conflictCopyFrame(beside.frame),
        zIndex: beside.zIndex + 1,
        revision: 1,
        documentJson,
        plainText: documentToPlainText(documentJson),
        colorToken: "default",
      };
      try {
        await dispatcher.execute(
          new CreateNoteCommand(copyId, {
            id: copyId,
            boardId: copy.boardId,
            frame: copy.frame,
            zIndex: copy.zIndex,
            documentJson,
          }),
        );
      } catch (e) {
        const text = latest();
        // Один отчёт на серию сбоев; новый — только когда правка завершается с
        // другим текстом (после перехода на другую доску текст есть лишь в отчёте).
        const report = !failure || (finalize && !sameDocument(failure.reported, text));
        const delay = failure ? Math.min(failure.delay * 2, COPY_RETRY_MAX_MS) : COPY_RETRY_MS;
        copyFailuresRef.current.set(key, {
          retryAt: Date.now() + delay,
          delay,
          reported: report ? text : failure.reported,
        });
        if (report) {
          // Текст — только в отчёте: баннер короткий, а отчёт переживает следующую ошибку.
          recordErrorReport?.({
            message: CONFLICT_COPY_FAILED_MESSAGE,
            detail: `Reason: ${errorMessage(e)}\n\nYour text:\n${documentToPlainText(text)}`,
            boardId: beside.boardId,
            source: "canvas",
            ...(failure ? { supersede: true } : {}),
          });
        }
        throw new ConflictCopyFailedError(CONFLICT_COPY_FAILED_MESSAGE);
      }
      copyFailuresRef.current.delete(key);
      copyWritesRef.current.set(copyId, documentJson);
      // Цвет — отдельный вызов: его сбой не отменяет уже созданную копию.
      if (colorToken !== "default") {
        try {
          await gateway.setNoteColor({ id: copyId, colorToken });
          copy.colorToken = colorToken;
        } catch {
          // Копия остаётся в цвете по умолчанию.
        }
      }
      return copy;
    },
    [dispatcher, gateway, idGenerator, recordErrorReport],
  );

  // Новейший текст черновика уходит в его копию обычной записью; то, что уже
  // записано, не пишется повторно. Копию, которую с тех пор правил кто-то
  // другой, не затираем: текст уходит в новую копию рядом с ней.
  const writeToCopy = useCallback(
    async (lineage: DraftLineage, settled: SettledConflict, finalize: boolean): Promise<DocumentSaveConflict> => {
      const latest = lineage.latest;
      if (sameDocument(latest, settled.written)) return settled.conflict;
      const documentJson = conflictCopyDocument(latest);
      // Своё — последняя запись этого клиента в копию, или уже этот самый текст.
      const own = (doc: unknown) =>
        sameDocument(doc, copyWritesRef.current.get(settled.copyId)) || sameDocument(doc, documentJson);

      const recopy = async (copy: NoteCardDto): Promise<DocumentSaveConflict> => {
        const next = await createConflictCopy({
          beside: copy,
          colorToken: copy.colorToken,
          mine: latest,
          latest: () => lineage.latest,
          key: lineage,
          finalize,
        });
        cardWrites.apply({ type: "cardAdded", card: next });
        const conflict: DocumentSaveConflict = { stored: settled.conflict.stored, copyId: next.id, editingMovedTo: null };
        settledConflictsRef.current.set(lineage, { conflict, copyId: next.id, written: latest, revision: next.revision });
        dispatch({ type: "failed", message: NOTE_CONFLICT_MESSAGE, outlivesBoardSwitch: true });
        return conflict;
      };

      const held = cardsRef.current.find((c): c is NoteCardDto => c.kind === "note" && c.id === settled.copyId);
      if (held && sameDocument(held.documentJson, documentJson)) {
        settled.written = latest;
        return settled.conflict;
      }
      if (held && !own(held.documentJson)) return recopy(held);
      const write = (expectedRevision: number) =>
        gateway.updateNote({ id: settled.copyId, expectedRevision, documentJson });
      let receipt: TextReceipt;
      try {
        receipt = await write(held?.revision ?? settled.revision);
      } catch (e) {
        // Отказ разбираем, как у записи заметки: решает сохранённый текст копии.
        if (!isStaleRevisionError(e)) throw e;
        markStaleRevisionHandled(e);
        const card = await gateway.readCard(settled.copyId);
        if (card.kind !== "note") throw e;
        const stored: NoteCardDto = { ...card, documentJson: normalizeDocument(card.documentJson) };
        cardWrites.apply({ type: "cardStored", id: stored.id, card: stored });
        if (!own(stored.documentJson)) return recopy(stored);
        receipt = await write(stored.revision);
      }
      settled.revision = receipt.revision;
      settled.written = latest;
      copyWritesRef.current.set(settled.copyId, documentJson);
      cardWrites.apply({
        type: "cardContentUpdated",
        id: settled.copyId,
        revision: receipt.revision,
        documentJson,
        plainText: receipt.plainText,
      });
      return settled.conflict;
    },
    [gateway, cardWrites, cardsRef, createConflictCopy, dispatch],
  );

  // Текст заметки сменил кто-то другой: сохранённый остаётся в оригинале, текст
  // пользователя уходит в новую заметку «Conflict copy» рядом, как делает
  // синхронизация (src-tauri/src/sync/replay.rs). `held` — версия, которую
  // правил пользователь, `stored` — версия из хранилища. После автосохранения
  // пользователь продолжает печатать в копии; после завершения правки редактор
  // закрывается, как после обычного сохранения.
  const settleNoteConflict = useCallback(
    async (
      held: NoteCardDto,
      stored: NoteCardDto,
      document: unknown,
      options: DocumentSaveOptions | undefined,
      finalize: boolean,
    ): Promise<DocumentSaveConflict> => {
      textSessionsRef.current.delete(held.id);
      const lineage = options?.draft;
      const latest = () => (lineage ? lineage.latest : document);
      const showStored = () => {
        if (stored !== held) cardWrites.apply({ type: "cardStored", id: held.id, card: stored });
      };
      if (sameDocument(latest(), stored.documentJson)) {
        showStored();
        return { stored: stored.documentJson, copyId: null, editingMovedTo: null };
      }

      const mine = latest();
      const copy = await createConflictCopy({
        beside: stored,
        colorToken: held.colorToken,
        mine,
        latest,
        key: lineage ?? held,
        finalize,
      });
      const copyId = copy.id;
      showStored();
      // Правка переходит в копию: её черновик начнёт с новейшего текста, а
      // клавиши, пока фокус ни на каком редакторе, ждут её редактор.
      const moveEditing = !finalize;
      if (moveEditing) {
        const handedOver = lineage ?? { latest: mine };
        offerDraftHandoff(
          copyId,
          () => conflictCopyDocument(handedOver.latest),
          (typed) => {
            recordErrorReport?.({
              message: HANDOFF_INPUT_LOST_MESSAGE,
              detail: `Typed text:\n${typed}`,
              // Каждая потеря — свой текст: дедуп по сообщению не должен его схлопнуть.
              supersede: true,
              boardId: held.boardId,
              source: "canvas",
            });
            dispatch({ type: "failed", message: HANDOFF_INPUT_LOST_MESSAGE });
          },
        );
      }
      // Копия появляется сразу в правке, одним действием: иначе между двумя
      // рендерами она видна не правимой, и редактор ставит каретку в начало.
      cardWrites.apply({ type: "cardAdded", card: copy, ...(moveEditing ? { startEditing: true } : {}) });
      // Ledger добавляет карточку только на открытую доску; при переходе её здесь нет.
      const onOpenBoard = cardsRef.current.some((c) => c.id === copyId);
      if (moveEditing && !onOpenBoard) endDraftHandoff(copyId);
      const conflict: DocumentSaveConflict = {
        stored: stored.documentJson,
        copyId,
        editingMovedTo: moveEditing && onOpenBoard ? copyId : null,
      };
      if (lineage) {
        const settled: SettledConflict = { conflict, copyId, written: mine, revision: copy.revision };
        settledConflictsRef.current.set(lineage, settled);
        // Набранное, пока создавалась копия, дописываем в неё.
        await writeToCopy(lineage, settled, finalize).catch(() => {
          // Черновик досылает свой текст в копию сам (`forwardToCopy`).
        });
      }
      // Переживает смену доски: конфликт мог найти сброс черновика при переходе.
      dispatch({ type: "failed", message: NOTE_CONFLICT_MESSAGE, outlivesBoardSwitch: true });
      return conflict;
    },
    [cardWrites, cardsRef, createConflictCopy, dispatch, recordErrorReport, writeToCopy],
  );

  // Запись текста заметки. Отказ `stale_revision` разбираем здесь, а не
  // перезагрузкой доски: решает сохранённый текст, а не ревизия.
  const writeNoteText = useCallback(
    async (
      note: NoteCardDto,
      document: unknown,
      options: DocumentSaveOptions | undefined,
      base: unknown,
      finalize: boolean,
    ): Promise<TextReceipt | DocumentSaveConflict> => {
      const write = (expectedRevision: number) =>
        gateway.updateNote({ id: note.id, expectedRevision, documentJson: document, ...acknowledgeCorrupt(options) });
      try {
        return await write(note.revision);
      } catch (e) {
        if (options?.base === undefined || !isStaleRevisionError(e)) throw e;
        markStaleRevisionHandled(e);
        const card = await gateway.readCard(note.id);
        if (card.kind !== "note") throw e;
        const stored: NoteCardDto = { ...card, documentJson: normalizeDocument(card.documentJson) };
        if (!sameDocument(stored.documentJson, base)) {
          return settleNoteConflict(note, stored, document, options, finalize);
        }
        // Другой писатель менял не текст: берём его версию карточки целиком и
        // пишем текст поверх сохранённой ревизии. Ничего не потеряно — баннера нет.
        cardWrites.apply({ type: "cardStored", id: note.id, card: stored });
        return write(stored.revision);
      }
    },
    [gateway, cardWrites, settleNoteConflict],
  );

  /**
   * The part of a note save both handlers share: a draft whose conflict is
   * settled writes into its copy; a draft whose base is no longer the held
   * text makes a copy; otherwise the text is written. `undefined`: the note is
   * gone, or the caller goes on (finalize may convert it to a link first).
   */
  const judgeNoteSave = useCallback(
    async (
      id: string,
      document: unknown,
      options: DocumentSaveOptions | undefined,
      finalize: boolean,
    ): Promise<{ note: NoteCardDto; base: unknown } | DocumentSaveConflict | undefined> => {
      if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
        throw new Error("Note content is not a valid document");
      }
      const lineage = options?.draft;
      const settled = lineage ? settledConflictsRef.current.get(lineage) : undefined;
      if (lineage && settled) return writeToCopy(lineage, settled, finalize);
      const note = cardsRef.current.find((n): n is NoteCardDto => n.kind === "note" && n.id === id);
      if (!note) return undefined;
      // База — последний подтверждённый этим клиентом документ на момент, когда
      // сохранение дошло до очереди, а не когда его поставили.
      const base = options?.base?.();
      if (
        options?.base !== undefined &&
        !sameDocument(note.documentJson, base) &&
        !sameDocument(note.documentJson, copyWritesRef.current.get(id))
      ) {
        return settleNoteConflict(note, note, document, options, finalize);
      }
      return { note, base };
    },
    [cardsRef, settleNoteConflict, writeToCopy],
  );

  const closeTextSession = useCallback(
    (id: string, after: unknown) => {
      const session = textSessionsRef.current.get(id);
      textSessionsRef.current.delete(id);
      if (!session?.recordable || sameDocument(session.before, after)) return;
      void dispatcher.record(new EditCardTextCommand(idGenerator.nextId(), session.kind, id, session.before, after));
    },
    [dispatcher, idGenerator],
  );

  const handleUpdateNote = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions): Promise<void | DocumentSaveConflict> => {
      return queueRef.current.run(async (): Promise<void | DocumentSaveConflict> => {
        // Defensive check before persisting (in `judgeNoteSave`): never write a
        // non-object document into SQLite. A structurally unusual (but still
        // object) document is preserved as-is — validation is protective, not
        // a source of user-facing save failures.
        const judged = await judgeNoteSave(id, document, options, false);
        if (!judged || !("note" in judged)) return judged;
        const { note, base } = judged;
        openTextSession(id, "note", note.documentJson, note.corrupt);

        const receipt = await writeNoteText(note, document, options, base, false);
        if (!("revision" in receipt)) return receipt;
        // `cardWrites` keeps the ref authoritative *inside this microtask*: the
        // note's own auto-grow (NoteCard) debounces a resize write off the same
        // keystroke and can land right behind this one in the queue, before
        // React's effect has re-synced `cardsRef` from state.
        cardWrites.apply({
          type: "cardContentUpdated",
          id,
          revision: receipt.revision,
          documentJson: document,
          plainText: receipt.plainText,
        });
        options?.confirmed?.(document);
      }).catch((e) => {
        dispatch(failedAction(e));
        throw e;
      });
    },
    [dispatch, cardWrites, queueRef, openTextSession, judgeNoteSave, writeNoteText],
  );

  const handleFinalizeNote = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions): Promise<void | DocumentSaveConflict> => {
      return queueRef.current.run(async (): Promise<void | DocumentSaveConflict> => {
        const judged = await judgeNoteSave(id, document, options, true);
        if (!judged || !("note" in judged)) return judged;
        const { note, base } = judged;

        openTextSession(id, "note", note.documentJson, note.corrupt);

        const classification = classifyLinkConversion(document);
        if (classification.qualifies) {
          const embed = await gateway.convertNoteToEmbed({
            id,
            expectedRevision: note.revision,
            sourceUrl: classification.url,
            displayUrl: displayUrl(classification.url),
            title: classification.url,
            descriptionJson: plainTextToDocument(""),
          });
          cardWrites.apply({ type: "cardReplaced", id, card: embed });
          // Превращение в ссылку в историю не пишем: заметки больше нет, а
          // `EditCardTextCommand` владеет только текстом заметки.
          textSessionsRef.current.delete(id);
          return;
        }

        const receipt = await writeNoteText(note, document, options, base, true);
        if (!("revision" in receipt)) return receipt;
        // Same ref-staleness guard as handleUpdateNote above: a pending
        // auto-grow resize can be queued right behind this finalize.
        cardWrites.apply({
          type: "cardContentUpdated",
          id,
          revision: receipt.revision,
          documentJson: document,
          plainText: receipt.plainText,
        });
        options?.confirmed?.(document);
        closeTextSession(id, document);
      }).catch((e) => {
        dispatch(failedAction(e));
        throw e;
      });
    },
    [gateway, dispatch, cardWrites, queueRef, openTextSession, closeTextSession, judgeNoteSave, writeNoteText],
  );

  const saveImageCaption = useCallback(
    (id: string, document: unknown, options: DocumentSaveOptions | undefined, finalize: boolean): Promise<void> => {
      return queueRef.current.run(async () => {
        const image = cardsRef.current.find(
          (c): c is ImageCardDto => c.kind === "image" && c.id === id,
        );
        if (!image) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Image caption is not a valid document");
        }
        openTextSession(id, "image", image.captionJson, image.corrupt);
        const receipt = await gateway.updateImageCaption({
          id,
          expectedRevision: image.revision,
          captionJson: document,
          ...acknowledgeCorrupt(options),
        });
        cardWrites.apply({
          type: "imageCaptionUpdated",
          id,
          revision: receipt.revision,
          captionJson: document,
          captionPlainText: receipt.plainText,
        });
        options?.confirmed?.(document);
        if (finalize) closeTextSession(id, document);
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway, dispatch, cardWrites, queueRef, cardsRef, openTextSession, closeTextSession],
  );

  const handleUpdateImageCaption = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions) => saveImageCaption(id, document, options, false),
    [saveImageCaption],
  );

  const handleFinalizeImageCaption = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions) => saveImageCaption(id, document, options, true),
    [saveImageCaption],
  );

  const saveEmbedDescription = useCallback(
    (id: string, document: unknown, options: DocumentSaveOptions | undefined, finalize: boolean): Promise<void> => {
      return queueRef.current.run(async () => {
        const embed = cardsRef.current.find(
          (c): c is EmbedCardDto => c.kind === "embed" && c.id === id,
        );
        if (!embed) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Link description is not a valid document");
        }
        openTextSession(id, "embed", embed.descriptionJson, embed.corrupt);
        const receipt = await gateway.updateEmbedDescription({
          id,
          expectedRevision: embed.revision,
          descriptionJson: document,
          ...acknowledgeCorrupt(options),
        });
        cardWrites.apply({
          type: "embedDescriptionUpdated",
          id,
          revision: receipt.revision,
          descriptionJson: document,
          descriptionPlainText: receipt.plainText,
        });
        options?.confirmed?.(document);
        if (finalize) closeTextSession(id, document);
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway, dispatch, cardWrites, queueRef, cardsRef, openTextSession, closeTextSession],
  );

  const handleUpdateEmbedDescription = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions) => saveEmbedDescription(id, document, options, false),
    [saveEmbedDescription],
  );

  const handleFinalizeEmbedDescription = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions) => saveEmbedDescription(id, document, options, true),
    [saveEmbedDescription],
  );

  const handleResizeNote = useCallback(
    (id: string, width: number, height: number, options?: ResizeOptions) => {
      const card = cardsRef.current.find((c) => c.id === id);
      if (!card) return;
      void queueRef.current
        .run(async () => {
          const current = cardsRef.current.find((c) => c.id === id);
          if (!current) return;
          const frame = { ...current.frame, width, height };
          const receipt = await gateway.moveCard({
            id,
            expectedRevision: current.revision,
            frame,
          });
          // Same ref-staleness guard as content saves above: NoteCard's
          // auto-grow can queue a resize right behind a content autosave for
          // the same keystroke, and the two must not read the same stale
          // revision (tasks/lessons.md 2026-09-08).
          cardWrites.apply({ type: "cardMoved", id, revision: receipt.revision, frame });
          if (!options?.auto && !sameFrame(current.frame, frame)) {
            void dispatcher.record(new ResizeCardCommand(idGenerator.nextId(), id, current.frame, frame));
          }
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, dispatch, cardWrites, queueRef, cardsRef, dispatcher, idGenerator],
  );

  return {
    handleUpdateNote,
    handleFinalizeNote,
    handleUpdateImageCaption,
    handleFinalizeImageCaption,
    handleUpdateEmbedDescription,
    handleFinalizeEmbedDescription,
    handleResizeNote,
  };
}
