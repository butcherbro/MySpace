import { describe, expect, it } from "vitest";
import { UuidV7Generator } from "./id-generator";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("UuidV7Generator", () => {
  it("produces a canonical UUID string", () => {
    const id = new UuidV7Generator().nextId();
    expect(id).toMatch(UUID_RE);
  });

  it("sets version 7 and the RFC 9562 variant", () => {
    const id = new UuidV7Generator().nextId();
    // Version is the high nibble of the 13th hex char (index 14 in the string).
    expect(id[14]).toBe("7");
    // Variant high bits are 10; the 17th hex char index is 19.
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("generates unique values", () => {
    const g = new UuidV7Generator();
    const ids = new Set(Array.from({ length: 1000 }, () => g.nextId()));
    expect(ids.size).toBe(1000);
  });
});
