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

  it("renders a tuple-content WorkspaceError (StaleRevision) instead of the bare code", () => {
    // Rust's `#[serde(tag = "code", content = "message")]` serialises
    // `StaleRevision { expected, actual }` as `{ code: "stale_revision",
    // message: { expected, actual } }` — `message` is an object, not a
    // string, so the old code fell through to the uninformative bare code.
    expect(errorMessage({ code: "stale_revision", message: { expected: 3, actual: 4 } })).toBe(
      "stale_revision: expected 3, actual 4",
    );
  });

  it("handles null/undefined/number", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(42)).toBe("42");
  });
});
