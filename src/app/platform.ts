// The shell needs to know, at the CSS layer, whether it is running with macOS's
// overlay title bar (traffic lights float over the content, so the top bar must
// reserve space for them) or a native title bar (Windows/Linux, where the OS
// already draws its own chrome above ours and no reservation is needed).
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
