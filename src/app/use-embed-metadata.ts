import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from "react";
import { errorMessage } from "../services/error-message";
import type { CardDto, EmbedCardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";

/**
 * Link Card metadata enrichment: fetches title/preview/favicon for embeds
 * still `pending`, de-duplicated per card+revision so a re-render doesn't
 * re-fire the same fetch, and exposes a manual retry that bypasses that guard.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 4).
 */

export interface EmbedMetadataOptions {
  cards: CardDto[];
  cardsRef: RefObject<CardDto[]>;
  gateway: WorkspaceGateway;
  dispatch: Dispatch<CurrentBoardAction>;
}

export interface EmbedMetadataController {
  requestEmbedMetadata: (embed: EmbedCardDto, force?: boolean) => void;
  handleRetryEmbedMetadata: (id: string) => void;
}

export function useEmbedMetadata(options: EmbedMetadataOptions): EmbedMetadataController {
  const { cards, cardsRef, gateway, dispatch } = options;

  const metadataInFlightRef = useRef(new Set<string>());
  const metadataAttemptedRef = useRef(new Set<string>());

  const requestEmbedMetadata = useCallback(
    (embed: EmbedCardDto, force = false) => {
      const attemptKey = `${embed.id}:${embed.revision}`;
      if (metadataInFlightRef.current.has(embed.id)) return;
      if (!force && metadataAttemptedRef.current.has(attemptKey)) return;

      metadataInFlightRef.current.add(embed.id);
      metadataAttemptedRef.current.add(attemptKey);
      void gateway
        .enrichEmbedMetadata({ id: embed.id, expectedRevision: embed.revision })
        .then((enriched) => {
          // Keep the mutation ref authoritative before the enriched card mounts:
          // Link Card may immediately persist a larger content-driven height.
          cardsRef.current = cardsRef.current.map((card) =>
            card.id === embed.id ? enriched : card,
          );
          dispatch({ type: "cardReplaced", id: embed.id, card: enriched });
        })
        .catch((cause) => {
          dispatch({ type: "failed", message: errorMessage(cause) });
        })
        .finally(() => {
          metadataInFlightRef.current.delete(embed.id);
        });
      // dispatch стабилен (useReducer), а cardsRef — тот же смысл, что и
      // stable setState/dispatch: identity не меняется, но вне App линтер
      // этого не видит для параметра хука — указываем оба явно.
    },
    [gateway, dispatch, cardsRef],
  );

  useEffect(() => {
    for (const card of cards) {
      if (card.kind === "embed" && card.metadataStatus === "pending") {
        requestEmbedMetadata(card);
      }
    }
  }, [requestEmbedMetadata, cards]);

  const handleRetryEmbedMetadata = useCallback(
    (id: string) => {
      const embed = cardsRef.current.find(
        (card): card is EmbedCardDto => card.kind === "embed" && card.id === id,
      );
      if (embed) requestEmbedMetadata(embed, true);
    },
    [requestEmbedMetadata, cardsRef],
  );

  return { requestEmbedMetadata, handleRetryEmbedMetadata };
}
