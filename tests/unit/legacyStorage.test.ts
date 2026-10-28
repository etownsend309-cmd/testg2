/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from "vitest";

import { LEGACY_AGREEMENTS_KEY, clearLegacyAgreements } from "../../src/lib/legacyStorage";

afterEach(() => localStorage.clear());

describe("clearLegacyAgreements", () => {
  it("removes the agreements an older version kept in this browser", () => {
    localStorage.setItem(LEGACY_AGREEMENTS_KEY, JSON.stringify([{ id: "old", rawText: "contract text" }]));

    expect(clearLegacyAgreements()).toBe(true);
    expect(localStorage.getItem(LEGACY_AGREEMENTS_KEY)).toBeNull();
  });

  it("leaves everything else alone, including the sign-in session", () => {
    localStorage.setItem(LEGACY_AGREEMENTS_KEY, "[]");
    localStorage.setItem("gotrue.user", "{\"id\":\"someone\"}");

    clearLegacyAgreements();

    expect(localStorage.getItem("gotrue.user")).toBe("{\"id\":\"someone\"}");
  });

  it("reports when there was nothing to remove", () => {
    expect(clearLegacyAgreements()).toBe(false);
  });

  it("does not throw when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    };
    expect(clearLegacyAgreements(blocked)).toBe(false);
  });
});
