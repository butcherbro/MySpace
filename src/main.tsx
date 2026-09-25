import ReactDOM from "react-dom/client";
import App from "./App";
import { StartupGate } from "./app/StartupGate";
import { installNativeContextMenuGuard } from "./app/native-context-menu";
import { applyPlatformAttribute } from "./app/platform";
// Inter Variable (all subsets incl. cyrillic) bundled as woff2 by Vite — the
// app never fetches fonts at runtime. Must precede tokens.css (--font-ui).
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/global.css";
import "./App.css";

// Stamp the platform onto <html> before anything renders, so the very first
// paint of the shell already has the right CSS scoping (macOS traffic-light
// clearance vs. native title bars elsewhere).
applyPlatformAttribute();
// WebView2 shows its own "Reload / Print / Inspect" menu on right-click; the
// app has its own menus for the canvas and cards.
installNativeContextMenuGuard();

// The gate asks the backend whether it started in recovery mode (P1.7) before
// the app mounts; in that mode only the recovery dialog renders.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StartupGate>
    <App />
  </StartupGate>,
);
