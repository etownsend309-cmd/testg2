import path from "node:path";
import { type Page } from "@playwright/test";

// Starts signed in: the intake flow is behind the identity gate, and these
// tests are about submission, not about authentication.
import { expect, requester, test } from "./support/session";

const fields = [
  ["Vendor", "Northstar Data", "Enter a vendor."],
  ["Agreement type", "Master services agreement", "Enter an agreement type."],
  ["Business unit", "Shared services", "Enter a business unit."],
  ["Needed-by date", "2026-12-01", "Enter a needed-by date."],
] as const;
const fixture = (name: string) => path.resolve("fixtures/generated", name);
async function openIntake(page: Page) {
  await page.goto("/");
  // Asserted rather than assumed: if the seeded session stopped satisfying the
  // gate, every test below would otherwise fail on a missing control with no
  // hint that the sign-in card is what rendered.
  await expect(page.getByText(requester.email)).toBeVisible();
  await page.getByLabel("Viewing as").selectOption("Requester");
  await page.getByRole("navigation").getByRole("button", { name: "New agreement" }).click();
}
async function fillMetadata(page: Page, except?: string) {
  for (const [label, value] of fields) if (label !== except) await page.getByLabel(label).fill(value);
}

test("valid PDF submission is saved through the API and survives reload", async ({ page, server }) => {
  await openIntake(page);
  await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("clean-agreement.pdf"));
  await fillMetadata(page);
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("status")).toContainText("submitted successfully");
  await expect(page.getByRole("heading", { name: "My submissions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "clean-agreement.pdf" })).toBeVisible();
  for (const [, value] of fields) await expect(page.locator(".tracker-record")).toContainText(value);
  await expect(page.locator(".tracker-record")).toContainText("Needs review");
  const [saved] = server.agreements();
  expect(saved).toMatchObject({ name: "clean-agreement.pdf", vendor: "Northstar Data", neededBy: "2026-12-01", status: "needs_review" });
  expect(saved!.rawText.length).toBeGreaterThan(0);
  expect(saved!.documents.map((d) => d.fileName)).toEqual(["clean-agreement.pdf"]);
  await page.reload();
  await page.getByRole("button", { name: "My submissions" }).click();
  await expect(page.getByRole("heading", { name: "clean-agreement.pdf" })).toBeVisible();
});

for (const [label, , message] of fields) {
  test(`required ${label} has accessible validation`, async ({ page, server }) => {
    await openIntake(page);
    await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("clean-agreement.pdf"));
    await fillMetadata(page, label);
    await page.getByRole("button", { name: /Create review/ }).click();
    await expect(page.getByLabel(label)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel(label)).toHaveAccessibleDescription(message);
    await expect(page.getByLabel(label)).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("Submission not completed");
    expect(server.agreements()).toEqual([]);
  });
}

test("document is required", async ({ page }) => {
  await openIntake(page);
  await fillMetadata(page);
  await page.getByRole("button", { name: /Create review/ }).click();
  const upload = page.getByRole("button", { name: /Drop an agreement/ });
  await expect(upload).toBeFocused();
  await expect(upload).toHaveAccessibleDescription("Choose a PDF or text document.");
});

test("upload and submission work using the keyboard", async ({ page }) => {
  await openIntake(page);
  const upload = page.getByRole("button", { name: /Drop an agreement/ });
  await upload.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(fixture("clean-agreement.pdf"));
  await page.getByRole("button", { name: /Replace agreement document/ }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Agreement title")).toBeFocused();
  await page.keyboard.press("Tab");
  for (const [label, value] of fields) {
    await expect(page.getByLabel(label)).toBeFocused();
    await page.getByLabel(label).fill(value);
    await page.keyboard.press("Tab");
    // Native date inputs expose several keyboard stops (month/day/year/calendar).
    if (label === "Needed-by date") {
      for (let stop = 0; stop < 5 && await page.getByLabel(label).evaluate((input) => input === document.activeElement); stop++) await page.keyboard.press("Tab");
    }
  }
  await expect(page.getByRole("button", { name: "Load demo agreement" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /Create review/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("submitted successfully");
});

test("unreadable PDF gives a failure result without a record", async ({ page, server }) => {
  await openIntake(page);
  await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("scanned-agreement.pdf"));
  await fillMetadata(page);
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("alert")).toContainText(/scanned|image-only/i);
  await expect(page.getByLabel("Vendor")).toHaveValue("Northstar Data");
  // The status region stays mounted so it can be announced; it must be empty.
  await expect(page.getByRole("status")).toHaveText("");
  expect(server.agreements()).toEqual([]);
});

test("a server failure never reports success", async ({ page, server }) => {
  await openIntake(page);
  await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("clean-agreement.pdf"));
  await fillMetadata(page);
  server.failNext("POST /api/agreements", 500, "Something went wrong on our side. Try again in a moment.");
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("alert")).toContainText("Something went wrong on our side");
  await expect(page.getByRole("alert")).toContainText("Your submission was not saved");
  await expect(page.getByRole("status")).toHaveText("");
  await page.getByRole("button", { name: "My submissions" }).click();
  await expect(page.getByRole("heading", { name: "No submissions yet" })).toBeVisible();
});

test("a reviewer records decisions and completes the review", async ({ page, server }) => {
  await openIntake(page);
  await page.getByRole("button", { name: "Load demo agreement" }).click();
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("status")).toContainText("submitted successfully");

  await page.getByLabel("Viewing as").selectOption("Reviewer");
  await page.getByRole("button", { name: /Review queue/ }).click();
  const detail = page.locator(".review-detail");
  await expect(detail.getByRole("link", { name: "Northstar MSA.txt" })).toBeVisible();

  const findings = server.agreements()[0]!.findings;
  expect(findings.length).toBeGreaterThan(0);
  await page.getByLabel("Reviewer note").fill("Escalating for legal.");
  await page.getByRole("button", { name: "Escalate" }).click();
  for (let index = 1; index < findings.length; index++) {
    await detail.locator(".finding-nav > button").nth(index).click();
    await page.getByRole("button", { name: "Accept" }).click();
  }
  await expect(page.getByText("0 findings still need a decision")).toBeVisible();
  await page.getByRole("button", { name: "Complete review" }).click();

  await expect(detail.locator(".document-heading .status")).toHaveText("Escalated");
  const [saved] = server.agreements();
  expect(saved!.status).toBe("escalated");
  expect(saved!.findings[0]).toMatchObject({ decision: "escalated", note: "Escalating for legal." });
  expect(saved!.findings.slice(1).every((f) => f.decision === "accepted")).toBe(true);

  await page.getByRole("button", { name: "Reports" }).click();
  await expect(page.getByText("1 agreement visible to you")).toBeVisible();
});
