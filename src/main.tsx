import ReactDOM from "react-dom/client";
import App from "./App";
import { StartupGate } from "./app/StartupGate";
import "./styles/tokens.css";
import "./styles/global.css";
import "./App.css";

// The gate asks the backend whether it started in recovery mode (P1.7) before
// the app mounts; in that mode only the recovery dialog renders.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StartupGate>
    <App />
  </StartupGate>,
);
