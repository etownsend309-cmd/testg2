import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getUser, handleAuthCallback, login, logout, onAuthChange } from "@netlify/identity";

type User = Awaited<ReturnType<typeof getUser>>;
type SignedInUser = NonNullable<User>;

/** Same shield used by the sidebar brand in App.tsx. */
function ShieldIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 4.5 5v6c0 5 3.2 8.6 7.5 11 4.3-2.4 7.5-6 7.5-11V5L12 2Zm-3 10 2 2 4-5" />
    </svg>
  );
}

function Brand() {
  return (
    <div className="brand auth-brand">
      <span className="brand-mark"><ShieldIcon /></span>
      <span>Clause<span>Pilot</span></span>
    </div>
  );
}

/**
 * Shows the sign-in screen until a Netlify Identity session exists, then
 * renders the review app with the signed-in user.
 */
export function AuthGate({ children }: { children: (user: SignedInUser, signOut: () => void) => ReactNode }) {
  const [user, setUser] = useState<User>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await handleAuthCallback();
        const current = await getUser();
        if (active) setUser(current);
      } finally {
        if (active) setLoading(false);
      }
    })();
    const unsubscribe = onAuthChange((_event, current) => setUser(current));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      setUser(await login(String(form.get("email")), String(form.get("password"))));
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 401 || status === 400 ? "That email and password don't match an account." : "Sign-in failed. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-shell auth-loading" role="status">
        <Brand />
        <p>Checking your session…</p>
      </div>
    );
  }

  if (user) {
    return <>{children(user, async () => { await logout(); setUser(null); })}</>;
  }

  return (
    <div className="auth-shell">
      <section className="auth-intro">
        <Brand />
        <div>
          <span className="eyebrow">Vendor agreement review</span>
          <h1>Make the first pass count.</h1>
          <p>Sign in to submit agreements, review flagged clauses, and track decisions for Calder Legal Operations.</p>
        </div>
        <div className="sidebar-note">
          <span className="eyebrow">Invite only</span>
          <p>Accounts are created by invitation. Ask your project lead if you need access.</p>
        </div>
      </section>

      <section className="auth-form-side">
        <form className="panel auth-card" onSubmit={handleSubmit} aria-busy={submitting}>
          <div className="page-heading">
            <span className="eyebrow">Welcome back</span>
            <h1>Sign in</h1>
            <p>Use the email address your invitation was sent to.</p>
          </div>
          <fieldset className="intake-fields" disabled={submitting}>
            <legend className="visually-hidden">Sign-in details</legend>
            <div className="form-grid auth-fields">
              <label htmlFor="auth-email">
                <span>Email</span>
                <input id="auth-email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" aria-invalid={Boolean(error)} />
              </label>
              <label htmlFor="auth-password">
                <span>Password</span>
                <input id="auth-password" name="password" type="password" autoComplete="current-password" required aria-invalid={Boolean(error)} />
              </label>
            </div>
            <div role="alert">{error && <p className="error-message">{error}</p>}</div>
            <div className="form-actions auth-actions">
              <button type="submit" className="primary-button">{submitting ? "Signing in…" : "Sign in →"}</button>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
