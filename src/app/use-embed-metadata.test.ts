import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CardDto, EmbedCardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { useEmbedMetadata } from "./use-embed-metadata";

function embed(overrides: Partial<EmbedCardDto> = {}): EmbedCardDto {
  return {
    kind: "embed",
    id: "embed-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 180 },
    zIndex: 0,
    revision: 1,
    sourceUrl: "https://example.com",
    displayUrl: "example.com",
    siteName: null,
    title: "https://example.com",
    provider: null,
    descriptionJson: { type: "doc", content: [] },
    descriptionPlainText: "",
    descriptionOrigin: null,
    faviconAsset: null,
    previewAsset: null,
    previewOrigin: null,
    metadataStatus: "pending",
    metadataError: null,
    ...overrides,
  };
}

function harness(
  overrides: {
    cards?: CardDto[];
    enrichEmbedMetadata?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const enrichEmbedMetadata =
    overrides.enrichEmbedMetadata ??
    vi.fn(async (input: { id: string; expectedRevision: number }) =>
      embed({ id: input.id, revision: input.expectedRevision, metadataStatus: "ready", title: "Example" }),
    );
  const gateway = { enrichEmbedMetadata } as unknown as WorkspaceGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const cards = overrides.cards ?? [];
  const cardsRef: RefObject<CardDto[]> = { current: cards };

  const { result } = renderHook(() => useEmbedMetadata({ cards, cardsRef, gateway, dispatch }));

  return { result, dispatch, enrichEmbedMetadata, cardsRef };
}

describe("useEmbedMetadata", () => {
  it("requests metadata for a pending embed and dispatches the enriched card", async () => {
    const enriched = embed({ metadataStatus: "ready", title: "Example" });
    const test = harness({
      cards: [embed()],
      enrichEmbedMetadata: vi.fn(async () => enriched),
    });

    await waitFor(() =>
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardReplaced", id: "embed-1", card: enriched }),
    );
    expect(test.enrichEmbedMetadata).toHaveBeenCalledWith({ id: "embed-1", expectedRevision: 1 });
    expect(test.cardsRef.current).toEqual([enriched]);
  });

  it("dispatches a failure instead of throwing when the gateway call rejects", async () => {
    const test = harness({
      cards: [embed()],
      enrichEmbedMetadata: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });

    await waitFor(() =>
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "fetch failed" }),
    );
  });

  it("does not re-request the same card+revision once already attempted", async () => {
    const test = harness({ cards: [embed()] });
    await waitFor(() => expect(test.enrichEmbedMetadata).toHaveBeenCalledTimes(1));

    act(() => {
      test.result.current.requestEmbedMetadata(embed());
    });

    expect(test.enrichEmbedMetadata).toHaveBeenCalledTimes(1);
  });

  it("ignores a concurrent request for the same card while the first is in flight", async () => {
    let resolveFetch!: (value: EmbedCardDto) => void;
    const enrichEmbedMetadata = vi.fn(
      () =>
        new Promise<EmbedCardDto>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const test = harness({ enrichEmbedMetadata });

    act(() => {
      test.result.current.requestEmbedMetadata(embed());
      test.result.current.requestEmbedMetadata(embed());
    });

    expect(enrichEmbedMetadata).toHaveBeenCalledTimes(1);

    // Не оставляем pending-промис висеть после теста.
    await act(async () => {
      resolveFetch(embed({ metadataStatus: "ready" }));
      await Promise.resolve();
    });
  });

  it("retries past the attempted guard, bypassing de-duplication", async () => {
    const test = harness({ cards: [embed()] });
    await waitFor(() => expect(test.enrichEmbedMetadata).toHaveBeenCalledTimes(1));

    act(() => {
      test.result.current.handleRetryEmbedMetadata("embed-1");
    });

    await waitFor(() => expect(test.enrichEmbedMetadata).toHaveBeenCalledTimes(2));
  });

  it("does nothing when retrying an id that is not a currently known embed", () => {
    const test = harness({ cards: [] });

    act(() => {
      test.result.current.handleRetryEmbedMetadata("missing");
    });

    expect(test.enrichEmbedMetadata).not.toHaveBeenCalled();
  });
});
