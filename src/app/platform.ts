import { useSyncExternalStore } from "react";

// The shell needs to know, at the CSS layer, whether it is running with macOS's
// overlay title bar (traffic lights float over the content, so the top bar must
// reserve space for them) or not (Windows/Linux, where the window is
// undecorated and the shell draws its own min/max/close controls at the right).
//
// `navigator.userAgentData.platform` is the modern, spec-backed source; older/
// non-Chromium engines fall back to the deprecated `navigator.platform`. Both
// are read once at startup and stamped onto `<html>` so CSS can scope
// macOS-only rules with `html[data-platform="macos"]` instead of guessing from
// a hard-coded pixel offset that only makes sense on one platform.

export type ShellPlatform = "macos" | "windows" | "linux" | "unknown";

interface NavigatorUAData {
  platform?: string;
}

function rawPlatformString(): string {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  return uaData?.platform ?? navigator.platform ?? "";
}

export function detectPlatform(): ShellPlatform {
  const platform = rawPlatformString().toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

/** Stamps the detected platform onto `<html data-platform="...">` once at startup. */
export function applyPlatformAttribute(doc: Document = document): ShellPlatform {
  const platform = detectPlatform();
  doc.documentElement.setAttribute("data-platform", platform);
  return platform;
}

function readPlatformAttribute(): ShellPlatform {
  const value = document.documentElement.getAttribute("data-platform");
  return value === "macos" || value === "windows" || value === "linux" ? value : "unknown";
}

function subscribePlatformAttribute(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-platform"] });
  return () => observer.disconnect();
}

/** The platform stamped on `<html data-platform>`, re-rendering if it changes. */
export function useShellPlatform(): ShellPlatform {
  return useSyncExternalStore(subscribePlatformAttribute, readPlatformAttribute, () => "unknown");
}

/** Windows and Linux run undecorated (see tauri.windows.conf.json /
 *  tauri.linux.conf.json), so the shell draws its own min/max/close buttons and
 *  marks the top bar as a Tauri drag region. macOS keeps its native traffic lights. */
export function usesCustomWindowChrome(platform: ShellPlatform): boolean {
  return platform === "windows" || platform === "linux";
}
