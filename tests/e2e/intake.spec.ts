import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const fields = [
  ["Vendor", "Northstar Data", "Enter a vendor."],
  ["Agreement type", "Master services agreement", "Enter an agreement type."],
  ["Business unit", "Shared services", "Enter a business unit."],
  ["Needed-by date", "2026-12-01", "Enter a needed-by date."],
] as const;
const fixture = (name: string) => path.resolve("fixtures/generated", name);
async function openIntake(page: Page) {
  await page.goto("/");
  await page.getByLabel("Viewing as").selectOption("Requester");
  await page.getByRole("navigation").getByRole("button", { name: "New agreement" }).click();
}
async function fillMetadata(page: Page, except?: string) {
  for (const [label, value] of fields) if (label !== except) await page.getByLabel(label).fill(value);
}

test("valid PDF submission appears in the requester tracker and survives reload", async ({ page }) => {
  await openIntake(page);
  await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("clean-agreement.pdf"));
  await fillMetadata(page);
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("status")).toContainText("submitted successfully");
  await expect(page.getByRole("heading", { name: "My submissions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "clean-agreement.pdf" })).toBeVisible();
  for (const [, value] of fields) await expect(page.locator(".tracker-record")).toContainText(value);
  await expect(page.locator(".tracker-record")).toContainText("Needs review");
  await page.reload();
  await page.getByRole("button", { name: "My submissions" }).click();
  await expect(page.getByRole("heading", { name: "clean-agreement.pdf" })).toBeVisible();
});

for (const [label, , message] of fields) {
  test(`required ${label} has accessible validation`, async ({ page }) => {
    await openIntake(page);
    await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("clean-agreement.pdf"));
    await fillMetadata(page, label);
    await page.getByRole("button", { name: /Create review/ }).click();
    await expect(page.getByLabel(label)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel(label)).toHaveAccessibleDescription(message);
    await expect(page.getByLabel(label)).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("Submission not completed");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("clausepilot-agreements-v1") ?? "[]"))).toEqual([]);
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

test("unreadable PDF gives a failure result without a record", async ({ page }) => {
  await openIntake(page);
  await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("scanned-agreement.pdf"));
  await fillMetadata(page);
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("alert")).toContainText(/scanned|image-only/i);
  await expect(page.getByLabel("Vendor")).toHaveValue("Northstar Data");
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("clausepilot-agreements-v1") ?? "[]"))).toEqual([]);
});

test("browser storage failure never reports success", async ({ page }) => {
  await openIntake(page);
  await page.getByLabel("Agreement document", { exact: true }).setInputFiles(fixture("clean-agreement.pdf"));
  await fillMetadata(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); }; });
  await page.getByRole("button", { name: /Create review/ }).click();
  await expect(page.getByRole("alert")).toContainText("Your submission was not saved");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "My submissions" }).click();
  await expect(page.getByRole("heading", { name: "No submissions yet" })).toBeVisible();
});
