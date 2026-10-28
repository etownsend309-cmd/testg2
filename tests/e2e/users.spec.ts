/**
 * The Administrator's Users page in a real browser.
 */

import { expect, test } from "./support/session";

test.use({
  account: {
    id: "a0000000-0000-4000-8000-000000000004",
    email: "admin@example.test",
    displayName: "Alex Administrator",
    roles: ["requester", "administrator"],
    permissions: [],
  },
});

test("an administrator makes someone a Reviewer and Approver", async ({ page, server }) => {
  server.addUsers({
    id: "a0000000-0000-4000-8000-000000000001",
    email: "requester@example.test",
    displayName: "Riley Requester",
    isActive: true,
    hasSignedIn: true,
    lastSeenAt: "2026-10-27T15:00:00.000Z",
    roles: ["requester"],
    permissions: [],
  });
  await page.goto("/");
  // Administrators start in the Reviewer view; Users lives in the Administrator view.
  await expect(page.getByRole("navigation").getByRole("button", { name: "Users" })).toHaveCount(0);
  await page.getByLabel("Viewing as").selectOption("Administrator");
  await page.getByRole("navigation").getByRole("button", { name: "Users" }).click();

  const riley = page.getByRole("article", { name: /Riley Requester/ });
  await expect(riley.getByRole("checkbox", { name: "Approver" })).toBeDisabled();
  await expect(riley.getByRole("checkbox", { name: "Approver" })).toHaveAccessibleDescription("Needs the Reviewer or Administrator role");
  await riley.getByRole("checkbox", { name: "Reviewer" }).check();
  await riley.getByRole("checkbox", { name: "Approver" }).check();
  await riley.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("status")).toContainText("Access for Riley Requester was updated");
  await expect(riley.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  expect(server.users().find((u) => u.email === "requester@example.test")).toMatchObject({
    roles: ["requester", "reviewer"],
    permissions: ["approve"],
  });

  const me = page.getByRole("article", { name: /Alex Administrator/ });
  await expect(me.getByRole("checkbox", { name: "Administrator" })).toBeDisabled();
  await expect(me.getByRole("checkbox", { name: "Active" })).toBeDisabled();

  await page.screenshot({ path: "test-results/users-page.png", fullPage: true });
});
