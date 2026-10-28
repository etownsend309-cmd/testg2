/**
 * @vitest-environment jsdom
 *
 * The review queue and reports, driven against the in-memory API fake.
 * Each action must go to the server, and the screen must show the server's
 * answer, including its refusals.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../src/App";
import { ApiRequestError } from "../../src/lib/api";
import type { Role } from "../../src/types";
import { fakeApi, makeAgreement, resetFakeApi, seed, signedInUser, stored } from "./support/fakeApi";

vi.mock("../../src/lib/api", async () => (await import("./support/fakeApi")).mockApiModule());

const TWO_FINDINGS =
  "GOVERNING LAW. This Agreement is governed by the laws of Georgia. Vendor may not assign this Agreement without prior written consent.";

beforeEach(() => resetFakeApi());
afterEach(() => cleanup());

async function openQueue(views: Role[] = ["Requester", "Reviewer", "Approver"]) {
  render(<App user={signedInUser} views={views} onSignOut={() => {}} />);
  const nav = await screen.findByRole("navigation", { name: /primary navigation/i });
  await userEvent.click(within(nav).getByRole("button", { name: /review queue/i }));
}

const detailPanel = () => document.querySelector<HTMLElement>(".review-detail")!;

describe("review queue", () => {
  it("records a decision on the server and moves the agreement into review", async () => {
    const agreement = makeAgreement({ rawText: TWO_FINDINGS });
    seed(agreement);
    await openQueue();

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(fakeApi.decideFinding).toHaveBeenCalledWith(agreement.findings[0]!.id, { decision: "accepted", note: "" });
    expect(stored()[0]!.findings[0]!.decision).toBe("accepted");
    expect(await within(detailPanel()).findByText("In review")).toBeTruthy();
    expect(screen.getByText("1 findings still need a decision")).toBeTruthy();
  });

  it("saves a reviewer note when the field loses focus, keeping the decision", async () => {
    const agreement = makeAgreement();
    seed(agreement);
    await openQueue();

    await userEvent.type(await screen.findByLabelText("Reviewer note"), "Matches our standard clause.");
    expect(fakeApi.decideFinding).not.toHaveBeenCalled();
    await userEvent.tab();

    expect(fakeApi.decideFinding).toHaveBeenCalledWith(agreement.findings[0]!.id, {
      decision: "pending",
      note: "Matches our standard clause.",
    });
    expect(stored()[0]!.findings[0]!.note).toBe("Matches our standard clause.");
  });

  it("sends an unsaved note along with the decision", async () => {
    const agreement = makeAgreement();
    seed(agreement);
    await openQueue();

    await userEvent.type(await screen.findByLabelText("Reviewer note"), "Out of policy.");
    await userEvent.click(screen.getByRole("button", { name: "Escalate" }));

    expect(fakeApi.decideFinding).toHaveBeenLastCalledWith(agreement.findings[0]!.id, { decision: "escalated", note: "Out of policy." });
    expect(stored()[0]!.findings[0]).toMatchObject({ decision: "escalated", note: "Out of policy." });
  });

  it("saves an unsaved note before completing the review", async () => {
    const agreement = makeAgreement();
    seed(agreement);
    await openQueue();

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await userEvent.type(screen.getByLabelText("Reviewer note"), "Checked against the playbook.");
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));

    expect(await within(detailPanel()).findByText("Approved")).toBeTruthy();
    expect(stored()[0]!.findings[0]).toMatchObject({ decision: "accepted", note: "Checked against the playbook." });
  });

  it("adds a manual finding and selects it", async () => {
    const agreement = makeAgreement();
    seed(agreement);
    await openQueue();

    await screen.findByRole("button", { name: "Accept" });
    await userEvent.selectOptions(within(detailPanel()).getByRole("combobox"), "Audit Rights");
    await userEvent.click(screen.getByRole("button", { name: /add manual finding/i }));

    expect(fakeApi.addManualFinding).toHaveBeenCalledWith(agreement.id, {
      category: "Audit Rights",
      sourceText: "GOVERNING LAW. Governed by the laws of Georgia.",
    });
    expect(await screen.findByRole("heading", { name: "Audit Rights" })).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
  });

  it("shows the server's reason when completing a review is refused", async () => {
    seed(makeAgreement());
    await openQueue(["Requester", "Reviewer"]);
    fakeApi.completeReview.mockRejectedValueOnce(new ApiRequestError(403, "Approving an agreement requires the Approver permission."));

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Approving an agreement requires the Approver permission.");
    expect(stored()[0]!.status).toBe("in_review");
  });

  it("completes a review and then shows it read-only", async () => {
    seed(makeAgreement());
    await openQueue();

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));

    expect(await within(detailPanel()).findByText("Approved")).toBeTruthy();
    expect(stored()[0]!.status).toBe("approved");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete review" })).toBeNull();
    expect((screen.getByLabelText("Reviewer note") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("gives the Requester view no review controls", async () => {
    seed(makeAgreement());
    await openQueue(["Requester"]);

    expect(await screen.findByText(/Supporting source text/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect((screen.getByLabelText("Reviewer note") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("links to the stored original file", async () => {
    const agreement = makeAgreement({
      documents: [{ id: "d0000000-0000-4000-8000-000000000001", fileName: "msa.pdf", contentType: "application/pdf", byteSize: 10, uploadedAt: "2026-10-01T12:00:00.000Z" }],
    });
    seed(agreement);
    await openQueue();

    const link = await screen.findByRole("link", { name: "msa.pdf" });
    expect(link.getAttribute("href")).toBe("/api/documents/d0000000-0000-4000-8000-000000000001");
  });
});

describe("reports", () => {
  it("shows the server's category counts, busiest first", async () => {
    const agreement = makeAgreement({ rawText: TWO_FINDINGS });
    agreement.findings[1]!.decision = "escalated";
    seed(agreement, makeAgreement());
    render(<App user={signedInUser} views={["Reviewer"]} onSignOut={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reports" }));

    expect(await screen.findByText("2 agreements visible to you")).toBeTruthy();
    const rows = [...document.querySelectorAll(".report-row:not(.report-header)")].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    );
    expect(rows[0]).toEqual(["Governing Law", "", "2", "0", "0"]);
    expect(rows[1]).toEqual(["Anti-Assignment", "", "1", "0", "1"]);
    expect(rows).toHaveLength(12);
  });
});
