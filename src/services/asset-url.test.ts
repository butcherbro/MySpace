import { afterEach, describe, expect, it } from "vitest";
import { assetUrl, assetUrlBase } from "./asset-url";

// Mirrors Tauri 2's injected `__TAURI_INTERNALS__.convertFileSrc`.
function tauriConvert(os: "macos" | "windows" | "linux") {
  return (filePath: string, protocol = "asset") => {
    const path = encodeURIComponent(filePath);
    return os === "windows" ? `http://${protocol}.localhost/${path}` : `${protocol}://localhost/${path}`;
  };
}

describe("assetUrl", () => {
  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("uses the custom scheme outside Tauri (browser, tests)", () => {
    expect(assetUrlBase(undefined)).toBe("myspace-asset://localhost/");
    expect(assetUrl("0192-abc.png")).toBe("myspace-asset://localhost/0192-abc.png");
  });

  it("uses the custom scheme on macOS and Linux", () => {
    expect(assetUrl("a.png", assetUrlBase(tauriConvert("macos")))).toBe("myspace-asset://localhost/a.png");
    expect(assetUrl("a.png", assetUrlBase(tauriConvert("linux")))).toBe("myspace-asset://localhost/a.png");
  });

  it("uses the http://<scheme>.localhost form on Windows (WebView2)", () => {
    expect(assetUrl("0192-abc.png", assetUrlBase(tauriConvert("windows")))).toBe(
      "http://myspace-asset.localhost/0192-abc.png",
    );
  });

  it("reads Tauri's convertFileSrc from the injected internals by default", () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { convertFileSrc: tauriConvert("windows") };
    expect(assetUrl("a.png")).toBe("http://myspace-asset.localhost/a.png");
  });

  it("falls back to the custom scheme if convertFileSrc throws", () => {
    expect(
      assetUrlBase(() => {
        throw new Error("boom");
      }),
    ).toBe("myspace-asset://localhost/");
  });
});
