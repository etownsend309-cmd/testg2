/**
 * @vitest-environment jsdom
 *
 * Pins the seeded sign-in the browser tests rely on.
 *
 * Those tests put a Netlify Identity session into the browser instead of
 * performing one, because there is no local Identity server to sign in
 * against. The shape they write is `gotrue-js`'s private storage format, so an
 * upgrade could change it without warning. Playwright would then report
 * "expected the requester's email, found the sign-in card" from six different
 * tests, which says nothing about the cause. This fails first, and says it.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GOTRUE_STORAGE_KEY, NF_JWT_COOKIE, identitySession, requester } from "../e2e/support/identitySession";

const origin = window.location.origin;

beforeEach(() => {
  localStorage.clear();
  // Any request means the seeded session was not self-sufficient, which in a
  // browser test would mean reaching an Identity server that is not running.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("The seeded session must not need the network."))));
});

afterEach(() => {
  document.cookie = `${NF_JWT_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  vi.unstubAllGlobals();
  vi.resetModules();
});

const seed = ({ cookie = true, storage = true } = {}) => {
  const { token, storedUser } = identitySession(origin);
  if (cookie) document.cookie = `${NF_JWT_COOKIE}=${token}; path=/`;
  if (storage) localStorage.setItem(GOTRUE_STORAGE_KEY, storedUser);
};

it("resolves to the requester without a network request", async () => {
  seed();

  const { getUser } = await import("@netlify/identity");

  expect(await getUser()).toMatchObject({ id: requester.id, email: requester.email });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["cookie", { cookie: false }],
  ["stored user", { storage: false }],
])("resolves to no user when the %s is missing", async (_half, missing) => {
  seed(missing);

  const { getUser } = await import("@netlify/identity");

  expect(await getUser()).toBeNull();
});
