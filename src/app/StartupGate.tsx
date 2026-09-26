import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RecoveryDialog } from "../backup/recovery-dialog";
import { createGateway } from "../services/create-gateway";
import type { StartupFailure, WorkspaceGateway } from "../services/workspace-gateway";
import { destroyWindow } from "./use-close-flush";

interface StartupGateProps {
  /** The app to render once the backend reports a healthy start. */
  children: ReactNode;
  /** Injected in tests; defaults to the runtime gateway. */
  gateway?: WorkspaceGateway;
  /** Quit in recovery mode; defaults to destroying the window. */
  onQuit?: () => void;
}

type GateState = { kind: "checking" } | { kind: "ready" } | { kind: "recovery"; failure: StartupFailure };

/**
 * P1.7 entry guard. The backend starts in recovery mode, with no `Workspace`,
 * when the database cannot be opened; any workspace command would then fail.
 * So before the app mounts (and issues its first `get_home_board`), ask
 * `getStartupFailure`: when it is set, render only the recovery dialog and
 * never mount the app.
 */
export function StartupGate({ children, gateway: injected, onQuit }: StartupGateProps) {
  const gateway = useMemo(() => injected ?? createGateway(), [injected]);
  const [state, setState] = useState<GateState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    gateway
      .getStartupFailure()
      .then((failure) => {
        if (cancelled) return;
        setState(failure ? { kind: "recovery", failure } : { kind: "ready" });
      })
      .catch((e: unknown) => {
        // The check itself failing says nothing about the workspace: start
        // normally and let the app surface any real error.
        console.error("startup check failed", e);
        if (!cancelled) setState({ kind: "ready" });
      });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  if (state.kind === "checking") return null;
  if (state.kind === "recovery") {
    return (
      <RecoveryDialog
        gateway={gateway}
        failure={state.failure}
        onQuit={onQuit ?? (() => void destroyWindow().catch(() => window.close()))}
      />
    );
  }
  return <>{children}</>;
}
