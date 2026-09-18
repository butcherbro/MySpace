import type { CardDto } from "../services/workspace-gateway";

interface EmptyBoardHintProps {
  /** Карточки ТЕКУЩЕЙ открытой доски (не Unsorted — там свои карточки допустимы). */
  cards: CardDto[];
  error: string | null;
}

/**
 * Подсказка "Click New note" по центру канваса.
 *
 * Раньше условие показа смотрело только на заметки (`kind === "note"`), поэтому
 * доска с одной картинкой/ссылкой/файлом/порталом/папкой считалась "пустой" и
 * подсказка не пропадала, ложась поверх карточек. Теперь смотрим на ВСЕ карточки
 * доски — подсказка живёт только пока доска действительно пуста, одинаково на
 * Home и на вложенных досках. Карточки в Unsorted не в счёт: доска сама по себе
 * может быть пустой, пока разбор Unsorted ещё не сделан.
 *
 * `.workspace__empty` уже имеет `pointer-events: none`, поэтому подсказка не
 * перехватывает клики даже пока она видна.
 */
export function EmptyBoardHint({ cards, error }: EmptyBoardHintProps) {
  if (cards.length !== 0 || error) return null;

  return (
    <div className="workspace__empty">
      Click “New note” to create your first note.
    </div>
  );
}
