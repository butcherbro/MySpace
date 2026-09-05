import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it("returns Error.message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a bare string as-is", () => {
    expect(errorMessage("denied")).toBe("denied");
  });

  it("flattens a serialized WorkspaceError with code + message", () => {
    expect(errorMessage({ code: "constraint_violation", message: "a board cannot become its own descendant" }))
      .toBe("constraint_violation: a board cannot become its own descendant");
  });

  it("falls back to the message field when only message is present", () => {
    expect(errorMessage({ message: "stale revision" })).toBe("stale revision");
  });

  it("does not render [object Object] for an unknown object", () => {
    expect(errorMessage({ code: "root_board_protected" })).toBe("root_board_protected");
  });

  it("handles null/undefined/number", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(42)).toBe("42");
  });
});
