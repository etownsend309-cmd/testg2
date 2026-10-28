/**
 * The default landing page is the signed-out one.
 *
 * Opening `/` without a session now reaches the identity gate, not the review
 * workspace, so this covers the sign-in screen. The workspace behind the gate
 * is covered by intake.spec.ts, which starts from a seeded session.
 */

import { expect, test } from "@playwright/test";

test("signed-out landing page renders the sign-in screen without browser errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.ok(), "The application entry page should load successfully").toBe(true);
  await expect(page).toHaveURL("http://127.0.0.1:5173/");

  // The gate resolves the session before deciding what to show, so the
  // "Checking your session…" state must have been replaced by the time these
  // pass. A gate stuck loading would fail here rather than silently pass.
  await expect(page.getByRole("heading", { level: 1, name: "Make the first pass count.", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  await expect(page.getByText("Accounts are created by invitation.", { exact: false })).toBeVisible();

  // The workspace is the thing the gate exists to withhold, so absence is the
  // assertion that matters, not a side effect of changing pages.
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agreement summary" })).toHaveCount(0);
  await expect(page.getByLabel("Viewing as")).toHaveCount(0);

  expect(consoleErrors, "The landing page should not log console errors").toEqual([]);
  expect(pageErrors, "The landing page should not throw uncaught exceptions").toEqual([]);
});
