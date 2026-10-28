import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { api, ApiRequestError } from "../lib/api";
import type { SessionUser } from "../shared/api";

type State =
  | { kind: "loading" }
  | { kind: "ready"; session: SessionUser }
  | { kind: "error"; message: string; canRetry: boolean };

/**
 * Loads the signed-in person's ClausePilot account after Netlify Identity has
 * signed them in.
 *
 * Identity says who someone is; the server says what they may do. Until the
 * roles arrive the workspace is not shown, and if the server refuses the
 * account (deactivated, or the session has lapsed) the person is told why and
 * offered a way out instead of an empty workspace.
 */
export function SessionGate({
  onSignOut,
  children,
}: {
  onSignOut: () => void;
  children: (session: SessionUser) => ReactNode;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  // AuthGate hands over a new sign-out callback on every render (a token
  // refresh re-renders it). Reading it through a ref keeps that from
  // reloading the session and flashing the loading screen.
  const signOutRef = useRef(onSignOut);
  useEffect(() => {
    signOutRef.current = onSignOut;
  }, [onSignOut]);

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    setState({ kind: "loading" });
    try {
      const session = await api.getSession();
      if (isCurrent()) setState({ kind: "ready", session });
    } catch (error) {
      if (!isCurrent()) return;
      const status = error instanceof ApiRequestError ? error.status : 0;
      if (status === 401) {
        // The Identity session has lapsed between the gate and this request.
        signOutRef.current();
        return;
      }
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Couldn't load your account.",
        canRetry: status !== 403,
      });
    }
  }, []);

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  if (state.kind === "ready") return <>{children(state.session)}</>;

  return (
    <div className="auth-shell auth-loading" role={state.kind === "loading" ? "status" : undefined}>
      {state.kind === "loading" ? (
        <p>Loading your workspace…</p>
      ) : (
        <div className="panel auth-card">
          <div className="page-heading">
            <span className="eyebrow">Account</span>
            <h1>We couldn't open your workspace</h1>
          </div>
          <p className="error-message" role="alert">{state.message}</p>
          <div className="form-actions auth-actions">
            {state.canRetry && (
              <button type="button" className="primary-button" onClick={() => void load()}>Try again</button>
            )}
            <button type="button" className="text-button" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}
