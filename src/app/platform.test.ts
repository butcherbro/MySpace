import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPlatformAttribute, detectPlatform } from "./platform";

function mockPlatform(platform: string, withUAData = false) {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  if (withUAData) {
    Object.defineProperty(navigator, "userAgentData", { value: { platform }, configurable: true });
  } else {
    Object.defineProperty(navigator, "userAgentData", { value: undefined, configurable: true });
  }
}

describe("platform detection", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-platform");
    vi.restoreAllMocks();
  });

  it("detects macOS from navigator.platform", () => {
    mockPlatform("MacIntel");
    expect(detectPlatform()).toBe("macos");
  });

  it("detects Windows from navigator.userAgentData when available", () => {
    mockPlatform("Win32", true);
    expect(detectPlatform()).toBe("windows");
  });

  it("detects Linux", () => {
    mockPlatform("Linux x86_64");
    expect(detectPlatform()).toBe("linux");
  });

  it("stamps the detected platform onto <html data-platform>", () => {
    mockPlatform("Win32");
    applyPlatformAttribute();
    expect(document.documentElement.getAttribute("data-platform")).toBe("windows");
  });
});
