import { test as base } from "@playwright/test";

import { GOTRUE_STORAGE_KEY, NF_JWT_COOKIE, identitySession, requester } from "./identitySession";

const ORIGIN = "http://127.0.0.1:5173";

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
    await use(page);
  },
});

export { requester };
export { expect } from "@playwright/test";
