/**
 * @vitest-environment jsdom
 *
 * Intake tests for the review app, covering the drag-and-drop path.
 *
 * Regression context: the intake "drop zone" was originally a click-only
 * button with no drag handlers, so dropping a PDF on it fell through to the
 * window and the browser navigated to the file, replacing the app with its own
 * PDF viewer.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../src/App";
import { extractText } from "../../src/lib/extractText";
vi.mock("../../src/lib/extractText", () => ({ extractText: vi.fn() }));
const STORAGE_KEY = "clausepilot-agreements-v1";
/** Stands in for the signed-in Netlify user; App reads only the identity. */
const signedInUser = { id: "test-requester-id", email: "requester@example.test" };
const renderApp = () => render(<App user={signedInUser} onSignOut={() => {}} />);
const fields = [
  ["Vendor", "Northstar Data", "Enter a vendor."],
  ["Agreement type", "Master services agreement", "Enter an agreement type."],
  ["Business unit", "Shared services", "Enter a business unit."],
  ["Needed-by date", "2026-12-01", "Enter a needed-by date."],
] as const;
async function fillMetadata(except?: string) {
  for (const [label, value] of fields) {
    if (label !== except) await userEvent.type(screen.getByLabelText(new RegExp(label)), value);
  }
}
const records = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(() => {
  vi.mocked(extractText).mockReset();
  vi.mocked(extractText).mockResolvedValue({ text: "GOVERNING LAW. Governed by the laws of Georgia.", warnings: [] });
  localStorage.clear();
});

const txtFile = (name = "northstar-msa.txt") =>
  new File(["GOVERNING LAW. Governed by the laws of Georgia."], name, { type: "text/plain" });

/** Move to the intake view and hand back its drop zone. */
async function openIntake(): Promise<HTMLElement> {
  renderApp();
  // Scoped to the sidebar: the overview hero offers a "New agreement" button too.
  const nav = screen.getByRole("navigation", { name: /primary navigation/i });
  await userEvent.click(within(nav).getByRole("button", { name: /new agreement/i }));
  return screen.getByRole("button", { name: /drop an agreement here/i });
}

describe("agreement intake", () => {
  it("accepts a dropped file and cancels the browser's own navigation", async () => {
    const dropZone = await openIntake();
    const file = txtFile();

    // `fireEvent.drop` reports whether any handler called preventDefault.
    // Without that, the browser opens the file instead of the app handling it.
    const notCancelled = fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(notCancelled).toBe(false);
    expect(screen.getByText(file.name)).toBeTruthy();
  });

  it("cancels the default on dragover so the drop target stays active", async () => {
    const dropZone = await openIntake();

    const notCancelled = fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });

    expect(notCancelled).toBe(false);
  });

  it("uses the dropped filename as the default agreement title", async () => {
    const dropZone = await openIntake();

    fireEvent.drop(dropZone, { dataTransfer: { files: [txtFile("vendor-sow.txt")] } });

    const title = screen.getByPlaceholderText(/Northstar MSA/i) as HTMLInputElement;
    expect(title.value).toBe("vendor-sow.txt");
  });

  it("extracts a dropped agreement and saves a trackable record", async () => {
    const dropZone = await openIntake();

    fireEvent.drop(dropZone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("submitted successfully");
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ vendor: "Northstar Data", agreementType: "Master services agreement", businessUnit: "Shared services", neededBy: "2026-12-01", status: "Needs review", submittedBy: signedInUser.email });
    expect(records()[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(records()[0].findings[0].category).toBe("Governing Law");
    expect(Number.isNaN(Date.parse(records()[0].submittedAt))).toBe(false);
  });
});

describe("KAN-40 validation and safe submission", () => {
  it.each(fields)("requires %s with an associated accessible error", async (label, _value, message) => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata(label);
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    const input = screen.getByLabelText(new RegExp(label));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(message);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("alert").textContent).toContain("Correct the marked fields");
    expect(extractText).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });

  it("requires a document and focuses the upload button", async () => {
    const zone = await openIntake();
    await fillMetadata();
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(zone);
    expect(screen.getByText("Choose a PDF or text document.")).toBeTruthy();
    expect(records()).toEqual([]);
  });

  it("rejects whitespace vendor values rather than saving a default", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata("Vendor");
    await userEvent.type(screen.getByLabelText(/Vendor/), "   ");
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect(screen.getByText("Enter a vendor.")).toBeTruthy();
    expect(records()).toEqual([]);
  });

  it("keeps metadata after extraction failure and allows a retry", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    vi.mocked(extractText).mockRejectedValueOnce(new Error("No readable text. Supply a readable copy."));
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("No readable text");
    expect(records()).toEqual([]);
    expect((screen.getByLabelText(/Vendor/) as HTMLInputElement).value).toBe("Northstar Data");
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(records()).toHaveLength(1);
  });

  it("does not report success or create a ghost record when persistence fails", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your submission was not saved");
    // The status region stays mounted so it can be announced; it must be empty.
    expect(screen.getByRole("status").textContent).toBe("");
    expect(records()).toEqual([]);
    save.mockRestore();
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(records()).toHaveLength(1);
  });

  it("prevents duplicate submissions while extraction is pending", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    let resolve!: (value: { text: string; warnings: string[] }) => void;
    vi.mocked(extractText).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.submit(screen.getByRole("button", { name: /create review/i }).closest("form")!);
    fireEvent.submit(screen.getByRole("button", { name: /submitting/i }).closest("form")!);
    expect(extractText).toHaveBeenCalledTimes(1);
    resolve({ text: "Governing law", warnings: [] });
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(records()).toHaveLength(1);
  });

  it("reloads saved submissions and filters out another submitter", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    await userEvent.click(screen.getByRole("button", { name: /create review/i }));
    await screen.findByRole("heading", { name: "My submissions" });
    const own = records()[0];
    cleanup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([own, { ...own, id: "other", name: "Another requester's contract", submittedBy: "Other requester" }]));
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "My submissions" }));
    expect(screen.getByRole("heading", { name: own.name })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Another requester's contract" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("concurrent submission and review", () => {
  const existingAgreement = {
    id: "existing-agreement",
    name: "Pre-existing MSA.pdf",
    vendor: "Acme Supply",
    agreementType: "Master services agreement",
    businessUnit: "Shared services",
    neededBy: "2026-11-01",
    submittedAt: "2026-10-01T12:00:00.000Z",
    submittedBy: signedInUser.email,
    status: "Needs review",
    rawText: "GOVERNING LAW. Governed by the laws of Georgia.",
    findings: [
      {
        id: "existing-finding",
        category: "Governing Law",
        confidence: 0.98,
        sourceText: "Governed by the laws of Georgia.",
        decision: "pending",
        note: "",
        method: "Local rule",
      },
    ],
  };

  /**
   * Extraction is asynchronous, but the sidebar stays live while it runs: the
   * disabled fieldset covers the form, not the navigation. A reviewer can
   * therefore record a decision on another agreement mid-parse. Submission has
   * to merge into whatever was saved in the meantime rather than into the list
   * it captured when it started, or the decision is lost with no error — the
   * stale write itself succeeds.
   */
  it("keeps a decision recorded while extraction is still in flight", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([existingAgreement]));
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile("new-contract.txt")] } });
    await fillMetadata();

    let resolve!: (value: { text: string; warnings: string[] }) => void;
    vi.mocked(extractText).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.submit(screen.getByRole("button", { name: /create review/i }).closest("form")!);

    const nav = screen.getByRole("navigation", { name: /primary navigation/i });
    await userEvent.click(within(nav).getByRole("button", { name: /review queue/i }));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(records()[0].findings[0].decision).toBe("accepted");

    resolve({ text: "GOVERNING LAW. Governed by the laws of Georgia.", warnings: [] });
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();

    const saved = records();
    expect(saved).toHaveLength(2);
    const reviewed = saved.find((item: { id: string }) => item.id === existingAgreement.id);
    expect(reviewed.findings[0].decision).toBe("accepted");
    expect(reviewed.status).toBe("In review");
  });

  /**
   * Sign out is in the sidebar, so it is reachable mid-extraction too, and it
   * unmounts App while the submission is still awaiting its text. The stored
   * list is shared by every account that uses the browser, so the abandoned
   * submission must not write once the next session has started saving.
   */
  it("discards a submission abandoned by signing out mid-extraction", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile("abandoned.txt")] } });
    await fillMetadata();

    let resolve!: (value: { text: string; warnings: string[] }) => void;
    vi.mocked(extractText).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.submit(screen.getByRole("button", { name: /create review/i }).closest("form")!);

    cleanup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([existingAgreement]));
    resolve({ text: "GOVERNING LAW. Governed by the laws of Georgia.", warnings: [] });
    await Promise.resolve();

    expect(records()).toEqual([existingAgreement]);
  });
});
