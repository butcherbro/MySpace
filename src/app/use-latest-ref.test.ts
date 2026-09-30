import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestRef } from "./use-latest-ref";

describe("useLatestRef", () => {
  it("follows the value after a rerender", () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: 1 },
    });

    expect(result.current.current).toBe(1);

    rerender({ value: 2 });

    expect(result.current.current).toBe(2);
  });

  it("keeps a stable ref identity across rerenders", () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: "a" },
    });
    const first = result.current;

    rerender({ value: "b" });

    expect(result.current).toBe(first);
  });
});
