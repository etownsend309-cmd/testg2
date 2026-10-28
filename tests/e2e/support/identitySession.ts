/**
 * Builds the browser state a completed Netlify Identity sign-in leaves behind.
 *
 * The app is gated by Netlify Identity, which has no local server to
 * authenticate against: a real sign-in needs a deployed site and real
 * credentials, so it is neither deterministic nor something to hold in CI.
 * Rather than add a bypass to the app, tests seed this state and let the
 * production gate run unchanged — it still decides, it simply finds a session
 * already there.
 *
 * Both halves are needed. `GoTrue.currentUser()` recovers the user from the
 * `gotrue.user` record, and `getUser()` then checks it against the `nf_jwt`
 * cookie; with either one missing it clears the session and the gate shows the
 * sign-in card. Neither half is read over the network, so seeding them makes no
 * request and involves no credential.
 *
 * The shape below is `gotrue-js`'s own storage format rather than a public API.
 * tests/unit/identitySession.test.ts pins it, so an upgrade that changes it
 * fails there with a clear reason instead of failing as "sign-in card rendered"
 * across every browser test.
 */

export const NF_JWT_COOKIE = "nf_jwt";
export const GOTRUE_STORAGE_KEY = "gotrue.user";

/** The signed-in requester. `App` records `email` as the submitter. */
export const requester = {
  id: "11111111-2222-4333-8444-555555555555",
  email: "requester@example.test",
};

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A structurally valid JWT carrying a throwaway signature.
 *
 * Nothing verifies it: the library base64-decodes the payload only to read
 * `exp`, and a token it cannot parse logs a console error. An hour of life
 * keeps it clear of the 60-second refresh margin, so the background refresh
 * never fires during a run and never reaches for the network.
 */
function accessToken() {
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    sub: requester.id,
    email: requester.email,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.e2e-signature-is-never-verified`;
}

export function identitySession(origin: string) {
  const token = accessToken();
  return {
    token,
    storedUser: JSON.stringify({
      url: `${origin}/.netlify/identity`,
      token: { access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: "e2e-refresh-token" },
      audience: "",
      id: requester.id,
      email: requester.email,
      confirmed_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      app_metadata: { provider: "email", roles: [] },
      user_metadata: { full_name: "Prototype Requester" },
    }),
  };
}
