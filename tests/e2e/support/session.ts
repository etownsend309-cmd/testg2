import { test as base } from "@playwright/test";

import type { SessionUser } from "../../../src/shared/api";
import { GOTRUE_STORAGE_KEY, NF_JWT_COOKIE, identitySession, requester } from "./identitySession";

const ORIGIN = "http://127.0.0.1:5173";

/** The seeded requester's ClausePilot account, with a reviewing role so both sides of the workspace are reachable. */
const sessionUser: SessionUser = {
  id: "a0000000-0000-4000-8000-000000000001",
  email: requester.email,
  displayName: "Riley Requester",
  roles: ["requester", "reviewer"],
  permissions: [],
};

/**
 * A Playwright `test` whose page starts already signed in.
 *
 * See identitySession.ts for why the session is seeded rather than performed,
 * and for what the two halves are.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const { token, storedUser } = identitySession(ORIGIN);
    await page.context().addCookies([{ name: NF_JWT_COOKIE, value: token, url: ORIGIN }]);
    // An init script rather than a single write, so the session survives the
    // reloads these tests perform. It sets only the identity key and leaves
    // stored agreements alone.
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [GOTRUE_STORAGE_KEY, storedUser] as const,
    );
    // The Vite dev server has no Netlify Functions, so answer the one API
    // call the workspace makes on load. The API itself is covered by
    // tests/integration against a real database.
    await page.route("**/api/session", (route) =>
      route.fulfill({ json: sessionUser }),
    );
    await use(page);
  },
});

export { requester };
export { expect } from "@playwright/test";
