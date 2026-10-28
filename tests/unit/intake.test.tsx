/**
 * @vitest-environment jsdom
 *
 * Intake tests for the review app, covering the drag-and-drop path and how a
 * submission reaches the API.
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
import { ApiRequestError } from "../../src/lib/api";
import { extractText } from "../../src/lib/extractText";
import { fakeApi, makeAgreement, resetFakeApi, seed, signedInUser, stored } from "./support/fakeApi";

vi.mock("../../src/lib/extractText", () => ({ extractText: vi.fn() }));
vi.mock("../../src/lib/api", async () => (await import("./support/fakeApi")).mockApiModule());

/** Every view, as before roles came from the server; these tests are about intake, not access. */
const allViews = ["Requester", "Reviewer", "Approver", "Administrator"] as const;
const renderApp = () => render(<App user={signedInUser} views={[...allViews]} onSignOut={() => {}} />);
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetFakeApi();
  vi.mocked(extractText).mockReset();
  vi.mocked(extractText).mockResolvedValue({ text: "GOVERNING LAW. Governed by the laws of Georgia.", warnings: [] });
});

const txtFile = (name = "northstar-msa.txt") =>
  new File(["GOVERNING LAW. Governed by the laws of Georgia."], name, { type: "text/plain" });

/** Move to the intake view and hand back its drop zone. */
async function openIntake(): Promise<HTMLElement> {
  renderApp();
  // Scoped to the sidebar: the overview hero offers a "New agreement" button too.
  const nav = await screen.findByRole("navigation", { name: /primary navigation/i });
  await userEvent.click(within(nav).getByRole("button", { name: /new agreement/i }));
  return screen.getByRole("button", { name: /drop an agreement here/i });
}

const submitButton = () => screen.getByRole("button", { name: /create review/i });

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

  it("sends the details and extracted text to the API, then stores the original file", async () => {
    const dropZone = await openIntake();
    const file = txtFile();

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    await fillMetadata();
    await userEvent.click(submitButton());
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("submitted successfully");

    expect(fakeApi.submitAgreement).toHaveBeenCalledTimes(1);
    const input = fakeApi.submitAgreement.mock.calls[0]![0];
    expect(input).toEqual({
      name: "northstar-msa.txt",
      vendor: "Northstar Data",
      agreementType: "Master services agreement",
      businessUnit: "Shared services",
      neededBy: "2026-12-01",
      rawText: "GOVERNING LAW. Governed by the laws of Georgia.",
      pageCount: undefined,
      extractionStrategy: undefined,
      extractionWarnings: [],
    });
    // Findings are the server's job, so the browser does not send any.
    expect(input).not.toHaveProperty("findings");

    const [saved] = stored();
    expect(fakeApi.uploadDocument).toHaveBeenCalledWith(saved!.id, file);
    expect(saved!.documents.map((d) => d.fileName)).toEqual([file.name]);
    expect(screen.getByRole("status").textContent).toContain(saved!.id);
    expect(screen.getByRole("heading", { name: "northstar-msa.txt" })).toBeTruthy();
  });

  it("keeps the submission and says so when only the file upload fails", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    fakeApi.uploadDocument.mockRejectedValueOnce(new ApiRequestError(413, "The file is too large to upload."));

    await userEvent.click(submitButton());

    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    const notice = screen.getByRole("status").textContent!;
    expect(notice).toContain("submitted successfully");
    expect(notice).toContain("The original file wasn't stored (The file is too large to upload.)");
    expect(stored()).toHaveLength(1);
  });
});

describe("KAN-40 validation and safe submission", () => {
  it.each(fields)("requires %s with an associated accessible error", async (label, _value, message) => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata(label);
    await userEvent.click(submitButton());
    const input = screen.getByLabelText(new RegExp(label));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(message);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("alert").textContent).toContain("Correct the marked fields");
    expect(extractText).not.toHaveBeenCalled();
    expect(fakeApi.submitAgreement).not.toHaveBeenCalled();
  });

  it("requires a document and focuses the upload button", async () => {
    const zone = await openIntake();
    await fillMetadata();
    await userEvent.click(submitButton());
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(zone);
    expect(screen.getByText("Choose a PDF or text document.")).toBeTruthy();
    expect(fakeApi.submitAgreement).not.toHaveBeenCalled();
  });

  it("rejects a file over the 25 MB limit before extracting it", async () => {
    const zone = await openIntake();
    const big = txtFile("huge.txt");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    fireEvent.drop(zone, { dataTransfer: { files: [big] } });
    await fillMetadata();
    await userEvent.click(submitButton());
    expect(screen.getByText("Choose a file of 25 MB or less.")).toBeTruthy();
    expect(extractText).not.toHaveBeenCalled();
  });

  it("rejects whitespace vendor values rather than saving a default", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata("Vendor");
    await userEvent.type(screen.getByLabelText(/Vendor/), "   ");
    await userEvent.click(submitButton());
    expect(screen.getByText("Enter a vendor.")).toBeTruthy();
    expect(fakeApi.submitAgreement).not.toHaveBeenCalled();
  });

  it("keeps metadata after extraction failure and allows a retry", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    vi.mocked(extractText).mockRejectedValueOnce(new Error("No readable text. Supply a readable copy."));
    await userEvent.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toContain("No readable text");
    expect(fakeApi.submitAgreement).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Vendor/) as HTMLInputElement).value).toBe("Northstar Data");
    await userEvent.click(submitButton());
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(stored()).toHaveLength(1);
  });

  it("does not report success or create a ghost record when the server refuses it", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    fakeApi.submitAgreement.mockRejectedValueOnce(new ApiRequestError(500, "Something went wrong on our side. Try again in a moment."));
    await userEvent.click(submitButton());
    const alert = (await screen.findByRole("alert")).textContent;
    expect(alert).toContain("Something went wrong on our side");
    expect(alert).toContain("Your submission was not saved");
    // The status region stays mounted so it can be announced; it must be empty.
    expect(screen.getByRole("status").textContent).toBe("");
    expect(stored()).toEqual([]);
    expect(fakeApi.uploadDocument).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Vendor/) as HTMLInputElement).value).toBe("Northstar Data");

    await userEvent.click(submitButton());
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(stored()).toHaveLength(1);
  });

  it("prevents duplicate submissions while extraction is pending", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile()] } });
    await fillMetadata();
    let resolve!: (value: { text: string; warnings: string[] }) => void;
    vi.mocked(extractText).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.submit(submitButton().closest("form")!);
    fireEvent.submit(screen.getByRole("button", { name: /submitting/i }).closest("form")!);
    expect(extractText).toHaveBeenCalledTimes(1);
    resolve({ text: "Governing law", warnings: [] });
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();
    expect(fakeApi.submitAgreement).toHaveBeenCalledTimes(1);
    expect(stored()).toHaveLength(1);
  });

  it("shows only the signed-in person's own agreements under My submissions", async () => {
    const own = makeAgreement({ name: "My own contract" });
    const other = makeAgreement({
      name: "Another requester's contract",
      submittedBy: { id: "a0000000-0000-4000-8000-000000000099", email: "other@example.test", displayName: "Other" },
    });
    seed(own, other);
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "My submissions" }));
    expect(await screen.findByRole("heading", { name: own.name })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: other.name })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("explains a failure to load agreements and retries on request", async () => {
    fakeApi.listAgreements.mockRejectedValueOnce(new ApiRequestError(0, "Couldn't reach ClausePilot. Check your connection and try again."));
    seed(makeAgreement({ name: "Loaded on retry" }));
    renderApp();
    expect(await screen.findByText(/Couldn't reach ClausePilot/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Loaded on retry")).toBeTruthy();
  });
});

describe("concurrent submission and review", () => {
  /**
   * Extraction is asynchronous, but the sidebar stays live while it runs: the
   * disabled fieldset covers the form, not the navigation. A reviewer can
   * therefore record a decision on another agreement mid-parse, and the new
   * submission must join the list without losing what was shown for it.
   */
  it("keeps a decision recorded while extraction is still in flight", async () => {
    const existing = makeAgreement();
    seed(existing);
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile("new-contract.txt")] } });
    await fillMetadata();

    let resolve!: (value: { text: string; warnings: string[] }) => void;
    vi.mocked(extractText).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.submit(submitButton().closest("form")!);

    const nav = screen.getByRole("navigation", { name: /primary navigation/i });
    await userEvent.click(within(nav).getByRole("button", { name: /review queue/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(fakeApi.decideFinding).toHaveBeenCalledWith(existing.findings[0]!.id, { decision: "accepted", note: "" });

    resolve({ text: "GOVERNING LAW. Governed by the laws of Georgia.", warnings: [] });
    expect(await screen.findByRole("heading", { name: "My submissions" })).toBeTruthy();

    const saved = stored();
    expect(saved).toHaveLength(2);
    const reviewed = saved.find((item) => item.id === existing.id)!;
    expect(reviewed.findings[0]!.decision).toBe("accepted");
    expect(reviewed.status).toBe("in_review");
    expect(screen.getByRole("heading", { name: existing.name })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "new-contract.txt" })).toBeTruthy();
  });

  /**
   * Sign out is in the sidebar, so it is reachable mid-extraction too, and it
   * unmounts App while the submission is still awaiting its text. The
   * abandoned submission must not be sent once the person has signed out.
   */
  it("discards a submission abandoned by signing out mid-extraction", async () => {
    const zone = await openIntake();
    fireEvent.drop(zone, { dataTransfer: { files: [txtFile("abandoned.txt")] } });
    await fillMetadata();

    let resolve!: (value: { text: string; warnings: string[] }) => void;
    vi.mocked(extractText).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.submit(submitButton().closest("form")!);

    cleanup();
    resolve({ text: "GOVERNING LAW. Governed by the laws of Georgia.", warnings: [] });
    await new Promise((done) => setTimeout(done, 0));

    expect(fakeApi.submitAgreement).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });
});
