import { describe, expect, it } from "vitest";
import { classifyLinkConversion } from "./link-conversion";

function doc(content: Record<string, unknown>[]): unknown {
  return { type: "doc", content };
}

function para(text: string): Record<string, unknown> {
  return { type: "paragraph", content: text.length > 0 ? [{ type: "text", text }] : [] };
}

describe("classifyLinkConversion", () => {
  describe("qualifies", () => {
    it("a single bare URL", () => {
      expect(classifyLinkConversion(doc([para("https://example.com")]))).toEqual({
        qualifies: true,
        url: "https://example.com",
      });
    });

    it("a URL with surrounding outer whitespace", () => {
      expect(classifyLinkConversion(doc([para("  https://example.com  ")]))).toEqual({
        qualifies: true,
        url: "https://example.com",
      });
    });

    it("a URL followed by an empty trailing paragraph", () => {
      const d = doc([para("https://example.com"), para(""), para("  ")]);
      expect(classifyLinkConversion(d)).toEqual({
        qualifies: true,
        url: "https://example.com",
      });
    });
  });

  describe("does not qualify", () => {
    it("empty document", () => {
      expect(classifyLinkConversion(doc([para("")]))).toEqual({
        qualifies: false,
        reason: "empty",
      });
    });

    it("plain prose (not a URL)", () => {
      expect(classifyLinkConversion(doc([para("hello world")]))).toEqual({
        qualifies: false,
        reason: "not-web-url",
      });
    });

    it("URL surrounded by extra words", () => {
      expect(classifyLinkConversion(doc([para("Read https://example.com now")]))).toEqual({
        qualifies: false,
        reason: "has-other-content",
      });
    });

    it("two URLs on separate lines", () => {
      const d = doc([para("https://a.com"), para("https://b.com")]);
      expect(classifyLinkConversion(d)).toEqual({
        qualifies: false,
        reason: "multiple-urls",
      });
    });

    it("two URLs in one paragraph", () => {
      const d = doc([para("https://a.com https://b.com")]);
      expect(classifyLinkConversion(d)).toEqual({
        qualifies: false,
        reason: "multiple-urls",
      });
    });

    it("a list containing only a URL", () => {
      const d = doc([
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [para("https://example.com")] }],
        },
      ]);
      // The URL is not the only top-level semantic shape; a list is an explicit
      // block and must not silently convert.
      expect(classifyLinkConversion(d)).toEqual({
        qualifies: false,
        reason: "has-other-content",
      });
    });

    it("a URL plus an embedded image", () => {
      const d = doc([
        para("https://example.com"),
        { type: "image", attrs: { src: "myspace-asset://localhost/x.png" } },
      ]);
      expect(classifyLinkConversion(d)).toEqual({
        qualifies: false,
        reason: "has-other-content",
      });
    });

    it("a non-web URL (file://)", () => {
      expect(classifyLinkConversion(doc([para("file:///tmp/x")]))).toEqual({
        qualifies: false,
        reason: "not-web-url",
      });
    });

    it("an email address", () => {
      expect(classifyLinkConversion(doc([para("me@example.com")]))).toEqual({
        qualifies: false,
        reason: "not-web-url",
      });
    });

    it("a malformed / partial URL", () => {
      expect(classifyLinkConversion(doc([para("https://")]))).toEqual({
        qualifies: false,
        reason: "not-web-url",
      });
    });
  });
});
