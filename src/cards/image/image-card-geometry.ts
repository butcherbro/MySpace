// Геометрия image card: расчёт стартового frame по пропорциям картинки и
// вспомогательные функции для aspect-locked resize.
//
// Backend не хранит natural width/height картинки (assets.width/height в
// БД всегда NULL — стадия импорта их не читает), поэтому единственный
// источник пропорций — сам браузер через `Image()`/`<img>.naturalWidth`.
// Эти значения используются только на фронте, персистится как раньше
// только итоговый frame {width, height}.

/** Ширина новой карточки по умолчанию (как было раньше). */
export const DEFAULT_IMAGE_WIDTH = 320;

/**
 * Высота зоны подписи, когда она ещё пустая ("Add caption…"). Должна
 * соответствовать `.image-card--no-caption .image-card__caption` в
 * image-card.css (padding-top 6 + padding-bottom 8 + min-height 26).
 * Не идеально точна для многострочных подписей — при ручном resize
 * фактическая высота подписи измеряется через DOM (см. ImageCard.tsx),
 * это значение — только для расчёта стартового frame при создании.
 */
export const CAPTION_BASE_HEIGHT = 40;

// Синхронизировано с CHECK-констрейнтами `cards` в src-tauri/migrations/0002_assets.sql.
export const MIN_CARD_WIDTH = 120;
export const MAX_CARD_WIDTH = 1600;
export const MIN_CARD_HEIGHT = 48;
export const MAX_CARD_HEIGHT = 10000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Стартовый размер карточки: ширина по умолчанию, высота — по пропорциям
 * картинки (image area) плюс место под подпись. Если natural size
 * недоступен (например, файл не декодировался в браузере), возвращает
 * старый фиксированный fallback 320×240, чтобы создание карточки не ломалось.
 */
export function computeInitialImageFrameSize(
  naturalWidth: number | null | undefined,
  naturalHeight: number | null | undefined,
): { width: number; height: number } {
  if (!naturalWidth || !naturalHeight || naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: DEFAULT_IMAGE_WIDTH, height: 240 };
  }
  const width = clamp(DEFAULT_IMAGE_WIDTH, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  const imageAreaHeight = width * (naturalHeight / naturalWidth);
  const height = clamp(
    Math.round(imageAreaHeight + CAPTION_BASE_HEIGHT),
    MIN_CARD_HEIGHT,
    MAX_CARD_HEIGHT,
  );
  return { width, height };
}

/**
 * Читает natural width/height картинки по URL (например `myspace-asset://…`).
 * Резолвится в `null` при ошибке загрузки — вызывающий код должен упасть
 * обратно на дефолтный размер.
 */
export function loadNaturalImageSize(
  src: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve(
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null,
      );
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Aspect-locked resize: по ширине карточки и известным пропорциям картинки
 * считает высоту (image area по пропорциям + текущая высота зоны подписи).
 */
export function computeResizedImageFrameSize(
  width: number,
  imageAspectRatio: number | null,
  captionHeight: number,
): { width: number; height: number } {
  const clampedWidth = clamp(width, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  if (!imageAspectRatio || imageAspectRatio <= 0) {
    return { width: clampedWidth, height: clamp(width, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT) };
  }
  const imageAreaHeight = clampedWidth / imageAspectRatio;
  const height = clamp(
    Math.round(imageAreaHeight + captionHeight),
    MIN_CARD_HEIGHT,
    MAX_CARD_HEIGHT,
  );
  return { width: clampedWidth, height };
}
