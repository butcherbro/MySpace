import { describe, expect, it } from "vitest";
import { canSubmitCode, formatCode } from "./pairing-code";

describe("pairing code", () => {
  it("groups 8 digits as 2-3-3", () => {
    expect(formatCode("12345678")).toBe("12 345 678");
    expect(formatCode("123")).toBe("123");
  });

  it("never puts 6 digits in the first 7 characters (an older build's input)", () => {
    for (let i = 0; i < 50; i++) {
      const code = String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0");
      const truncated = formatCode(code).slice(0, 7);
      expect(truncated.replace(/\D/g, "")).toHaveLength(5);
    }
  });

  it("lets 8 digits and old 6-digit codes through, nothing else", () => {
    expect(canSubmitCode("12 345 678")).toBe(true);
    expect(canSubmitCode("123 456")).toBe(true);
    expect(canSubmitCode("1234567")).toBe(false);
    expect(canSubmitCode("")).toBe(false);
  });
});
