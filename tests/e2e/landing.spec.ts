import { expect, test } from "@playwright/test";

test("default landing page renders without browser errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.ok(), "The application entry page should load successfully").toBe(true);
  await expect(page).toHaveURL("http://127.0.0.1:5173/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Make the first pass count.", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agreement summary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Eight-stage path", exact: true })).toBeVisible();
  await expect(page.locator(".workflow-list > li")).toHaveCount(8);
  await expect(page.getByText("No agreements yet", { exact: true })).toBeVisible();

  expect(consoleErrors, "The landing page should not log console errors").toEqual([]);
  expect(pageErrors, "The landing page should not throw uncaught exceptions").toEqual([]);
});
