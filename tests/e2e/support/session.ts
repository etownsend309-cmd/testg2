import { test as base } from "@playwright/test";

import type { SessionUser } from "../../../src/shared/api";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { GOTRUE_STORAGE_KEY, NF_JWT_COOKIE, identitySession, requester } from "./identitySession";

const ORIGIN = "http://127.0.0.1:5173";

/** The seeded requester's ClausePilot account, with a reviewing role so both sides of the workspace are reachable. */
export const sessionUser: SessionUser = {
  id: "a0000000-0000-4000-8000-000000000001",
  email: requester.email,
  displayName: "Riley Requester",
  roles: ["requester", "reviewer"],
  permissions: [],
};

const servers = new WeakMap<object, FakeServer>();

/**
 * A Playwright `test` whose page starts already signed in, talking to an
 * in-memory API (see fakeServer.ts). Ask for the `server` fixture to inspect
 * what the page saved or to make a request fail.
 *
 * See identitySession.ts for why the session is seeded rather than performed,
 * and for what the two halves are.
 */
export const test = base.extend<{ server: FakeServer }>({
  page: async ({ page }, use) => {
    const { token, storedUser } = identitySession(ORIGIN);
    await page.context().addCookies([{ name: NF_JWT_COOKIE, value: token, url: ORIGIN }]);
    // An init script rather than a single write, so the session survives the
    // reloads these tests perform.
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [GOTRUE_STORAGE_KEY, storedUser] as const,
    );
    // The Vite dev server has no Netlify Functions, so the API is faked per
    // page. The real API is covered by tests/integration against a database.
    servers.set(page, await installFakeServer(page, sessionUser));
    await use(page);
  },
  server: async ({ page }, use) => {
    await use(servers.get(page)!);
  },
});

export { requester };
export { expect } from "@playwright/test";
