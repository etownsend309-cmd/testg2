/**
 * The signed-in account panel.
 *
 * Sign out exists in one place, inside a panel that shares the `sidebar-note`
 * class with the informational notes the narrow layout hides to save room.
 * Losing it there leaves no way to end a session, so the narrow case is worth
 * asserting rather than assuming.
 */

import { expect, requester, test } from "./support/session";

test.describe("account panel", () => {
  for (const [label, viewport] of [
    ["narrow", { width: 390, height: 844 }],
    ["wide", { width: 1280, height: 900 }],
  ] as const) {
    test(`offers sign out on a ${label} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");

      await expect(page.getByText(requester.email)).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    });
  }

  test("hides the informational note on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // Keeping the account panel must not have un-hidden its siblings, which
    // is what a blunter override would have done.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText("Agreements are saved to the ClausePilot database.", { exact: false })).toHaveCount(1);
    await expect(page.getByText("Agreements are saved to the ClausePilot database.", { exact: false })).toBeHidden();
  });
});
