import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUnsortedDrawer } from "./use-unsorted-drawer";

describe("useUnsortedDrawer", () => {
  it("opens when the unsorted count grows", () => {
    const { result, rerender } = renderHook(
      ({ unsortedCount }: { unsortedCount: number }) => useUnsortedDrawer({ unsortedCount }),
      { initialProps: { unsortedCount: 0 } },
    );

    expect(result.current.unsortedOpen).toBe(false);

    rerender({ unsortedCount: 1 });

    expect(result.current.unsortedOpen).toBe(true);
  });

  it("stays closed when the count shrinks", () => {
    const { result, rerender } = renderHook(
      ({ unsortedCount }: { unsortedCount: number }) => useUnsortedDrawer({ unsortedCount }),
      { initialProps: { unsortedCount: 2 } },
    );

    act(() => {
      result.current.setUnsortedOpen(false);
    });

    rerender({ unsortedCount: 1 });

    expect(result.current.unsortedOpen).toBe(false);
  });

  it("stays closed when the count is unchanged", () => {
    const { result, rerender } = renderHook(
      ({ unsortedCount }: { unsortedCount: number }) => useUnsortedDrawer({ unsortedCount }),
      { initialProps: { unsortedCount: 1 } },
    );

    rerender({ unsortedCount: 1 });

    expect(result.current.unsortedOpen).toBe(false);
  });

  it("respects a manual close until the next growth", () => {
    const { result, rerender } = renderHook(
      ({ unsortedCount }: { unsortedCount: number }) => useUnsortedDrawer({ unsortedCount }),
      { initialProps: { unsortedCount: 1 } },
    );

    rerender({ unsortedCount: 2 });
    expect(result.current.unsortedOpen).toBe(true);

    act(() => {
      result.current.setUnsortedOpen(false);
    });
    expect(result.current.unsortedOpen).toBe(false);

    rerender({ unsortedCount: 2 });
    expect(result.current.unsortedOpen).toBe(false);

    rerender({ unsortedCount: 3 });
    expect(result.current.unsortedOpen).toBe(true);
  });
});
