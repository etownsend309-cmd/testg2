import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  acceptInvite,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  requestPasswordRecovery,
  updateUser,
} from "@netlify/identity";

type User = Awaited<ReturnType<typeof getUser>>;
type SignedInUser = NonNullable<User>;

/**
 * Which card the sign-in side shows:
 * - signin: email + password
 * - forgot: ask for an email and send a reset link
 * - reset:  the user arrived from a reset email and must choose a new password
 * - invite: the user arrived from an invitation email and must choose their first password
 */
type Mode = "signin" | "forgot" | "reset" | "invite";

const MIN_PASSWORD_LENGTH = 8;

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

/** Checks the two "new password" fields and returns an error message, or "" if they're fine. */
function checkNewPassword(password: string, confirm: string) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== confirm) return "The two passwords don't match.";
  return "";
}

/**
 * Shows the sign-in screen until a Netlify Identity session exists, then
 * renders the review app with the signed-in user. Also handles the
 * forgot-password, reset-password and accept-invite flows.
 */
export function AuthGate({ children }: { children: (user: SignedInUser, signOut: () => void) => ReactNode }) {
  const [user, setUser] = useState<User>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<Mode>("signin");
  const [inviteToken, setInviteToken] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Reads #recovery_token / #invite_token etc. from the URL after a user clicks an email link.
        const result = await handleAuthCallback();
        if (!active) return;
        if (result?.type === "recovery") {
          // Logged in by the link, but they still need to pick a new password.
          setMode("reset");
        } else if (result?.type === "invite" && result.token) {
          setInviteToken(result.token);
          setMode("invite");
        }
        const current = await getUser();
        if (active) setUser(current);
      } catch {
        if (active) setError("That link is invalid or has expired. Request a new one below.");
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

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
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

  async function handleForgot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      await requestPasswordRecovery(String(form.get("email")));
    } catch {
      // Ignore lookup failures so the form doesn't reveal which emails have accounts.
    } finally {
      setSubmitting(false);
      setMode("signin");
      setNotice("If that email has an account, a reset link is on its way. Check your inbox.");
    }
  }

  async function handleNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    const problem = checkNewPassword(password, String(form.get("confirm")));
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    try {
      const updated = mode === "invite" ? await acceptInvite(inviteToken, password) : await updateUser({ password });
      // Clear the token from the address bar so a refresh doesn't reuse it.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setInviteToken("");
      setMode("signin");
      setUser(updated);
    } catch {
      setError(
        mode === "invite"
          ? "This invitation link is invalid or has expired. Ask your project lead to resend it."
          : "Couldn't save your new password. The reset link may have expired — request a new one.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Leaves the password card without setting a password.
   *
   * A recovery session is exactly what goes stale, so once the link expires
   * the card can only retry something that will keep failing. Leaving has to
   * discard that session rather than keep it: it is unusable, and it would
   * otherwise let someone reach the app with the password still unset.
   *
   * An invitation is the opposite case. Any session present belongs to
   * whoever was already signed in here, unrelated to the invitation, so
   * backing out returns them to it instead of signing them out of it.
   */
  async function leavePasswordCard() {
    setInviteToken("");
    if (mode === "invite") {
      switchMode("signin");
      return;
    }
    setSubmitting(true);
    try {
      await logout();
    } catch {
      // The session is being abandoned either way. Failing to revoke it must
      // not strand the user on the card they are trying to leave.
    } finally {
      setUser(null);
      setSubmitting(false);
      switchMode("forgot");
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

  /**
   * Whether a signed-in user still owes us a password before reaching the app.
   *
   * A recovery link signs the user in itself, and an invitation can be opened
   * in a browser that already holds a session, so in both cases `getUser()`
   * returns someone while the password is still unset. Handing them the app
   * would strand the link: its token is only in state by now, because
   * `handleAuthCallback` clears it from the address bar as it reads it.
   */
  const needsPassword = mode === "reset" || mode === "invite";

  if (user && !needsPassword) {
    return <>{children(user, async () => { await logout(); setUser(null); switchMode("signin"); })}</>;
  }

  const messages = (
    <>
      <div role="alert">{error && <p className="error-message">{error}</p>}</div>
      <div role="status">{notice && <p className="auth-notice">{notice}</p>}</div>
    </>
  );

  let card: ReactNode;

  if (mode === "forgot") {
    card = (
      <form className="panel auth-card" onSubmit={handleForgot} aria-busy={submitting}>
        <div className="page-heading">
          <span className="eyebrow">Password help</span>
          <h1>Reset password</h1>
          <p>Enter the email you sign in with and we'll send you a link to choose a new password.</p>
        </div>
        <fieldset className="intake-fields" disabled={submitting}>
          <legend className="visually-hidden">Password reset request</legend>
          <div className="form-grid auth-fields">
            <label htmlFor="forgot-email">
              <span>Email</span>
              <input id="forgot-email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
            </label>
          </div>
          {messages}
          <div className="form-actions auth-actions">
            <button type="submit" className="primary-button">{submitting ? "Sending…" : "Send reset link →"}</button>
          </div>
          <p className="auth-switch">
            <button type="button" className="text-button" onClick={() => switchMode("signin")}>← Back to sign in</button>
          </p>
        </fieldset>
      </form>
    );
  } else if (needsPassword) {
    const isInvite = mode === "invite";
    card = (
      <form className="panel auth-card" onSubmit={handleNewPassword} aria-busy={submitting} noValidate>
        <div className="page-heading">
          <span className="eyebrow">{isInvite ? "Welcome" : "Password help"}</span>
          <h1>{isInvite ? "Set your password" : "Choose a new password"}</h1>
          <p>
            {isInvite
              ? "You've been invited to ClausePilot. Choose a password to finish creating your account."
              : `Signed in as ${user?.email ?? "your account"}. Pick a new password to finish.`}
          </p>
        </div>
        <fieldset className="intake-fields" disabled={submitting}>
          <legend className="visually-hidden">New password</legend>
          <div className="form-grid auth-fields">
            <label htmlFor="new-password">
              <span>New password</span>
              <input id="new-password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} aria-invalid={Boolean(error)} />
            </label>
            <label htmlFor="confirm-password">
              <span>Confirm password</span>
              <input id="confirm-password" name="confirm" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} aria-invalid={Boolean(error)} />
            </label>
          </div>
          {messages}
          <div className="form-actions auth-actions">
            <button type="submit" className="primary-button">
              {submitting ? "Saving…" : isInvite ? "Create account →" : "Save password →"}
            </button>
          </div>
          <p className="auth-switch">
            <button type="button" className="text-button" onClick={() => void leavePasswordCard()}>
              {isInvite ? "← Back to sign in" : "Request a new reset link"}
            </button>
          </p>
        </fieldset>
      </form>
    );
  } else {
    card = (
      <form className="panel auth-card" onSubmit={handleSignIn} aria-busy={submitting}>
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
          {messages}
          <div className="form-actions auth-actions">
            <button type="submit" className="primary-button">{submitting ? "Signing in…" : "Sign in →"}</button>
          </div>
          <p className="auth-switch">
            <button type="button" className="text-button" onClick={() => switchMode("forgot")}>Forgot password?</button>
          </p>
        </fieldset>
      </form>
    );
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

      <section className="auth-form-side">{card}</section>
    </div>
  );
}
