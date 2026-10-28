/**
 * @vitest-environment jsdom
 *
 * The Administrator's Users page, against the in-memory API fake. Access
 * control itself is enforced and tested on the server (tests/integration);
 * these tests cover what the page offers and what it sends.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../src/App";
import { ApiRequestError } from "../../src/lib/api";
import type { Role } from "../../src/types";
import { fakeApi, makeUser, resetFakeApi, seedUsers, signedInUser, storedUsers } from "./support/fakeApi";

vi.mock("../../src/lib/api", async () => (await import("./support/fakeApi")).mockApiModule());

const me = makeUser({ id: signedInUser.id, email: signedInUser.email, displayName: "Alex Admin", roles: ["administrator"] });
const riley = makeUser({ email: "riley@example.test", displayName: "Riley Requester", roles: ["requester"] });
const newcomer = makeUser({ email: "new@example.test", displayName: "", hasSignedIn: false, lastSeenAt: null });

beforeEach(() => {
  resetFakeApi();
  seedUsers(me, riley, newcomer);
});
afterEach(() => cleanup());

const renderApp = (views: Role[] = ["Requester", "Reviewer", "Administrator"]) =>
  render(<App user={signedInUser} views={views} onSignOut={() => {}} />);

const nav = () => screen.getByRole("navigation", { name: /primary navigation/i });

async function openUsers() {
  renderApp();
  await screen.findByRole("navigation", { name: /primary navigation/i });
  await userEvent.selectOptions(screen.getByLabelText("Viewing as"), "Administrator");
  await userEvent.click(within(nav()).getByRole("button", { name: "Users" }));
  await screen.findByRole("heading", { level: 1, name: "Users" });
}

const card = (name: string) => screen.getByRole("article", { name: new RegExp(name) });

describe("Users page", () => {
  it("is offered only in the Administrator view", async () => {
    renderApp();
    await screen.findByRole("navigation", { name: /primary navigation/i });
    // Starts in Reviewer, the most review-oriented view this person holds.
    expect(within(nav()).queryByRole("button", { name: "Users" })).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Viewing as"), "Administrator");
    await userEvent.click(within(nav()).getByRole("button", { name: "Users" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Users" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Viewing as"), "Reviewer");
    expect(screen.queryByRole("heading", { level: 1, name: "Users" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Users" })).toBeNull();
  });

  it("is not offered to someone without the Administrator role", async () => {
    renderApp(["Requester", "Reviewer"]);
    await screen.findByRole("navigation", { name: /primary navigation/i });
    expect(within(nav()).queryByRole("button", { name: "Users" })).toBeNull();
    expect(fakeApi.listUsers).not.toHaveBeenCalled();
  });

  it("lists everyone with their current access and sign-in state", async () => {
    await openUsers();

    expect(screen.getByText("3 people")).toBeTruthy();
    const rileyCard = card("Riley Requester");
    expect((within(rileyCard).getByRole("checkbox", { name: "Requester" }) as HTMLInputElement).checked).toBe(true);
    expect((within(rileyCard).getByRole("checkbox", { name: "Reviewer" }) as HTMLInputElement).checked).toBe(false);
    expect(within(rileyCard).getByText(/Last seen/)).toBeTruthy();
    expect(within(card("new@example.test")).getByText("Hasn't signed in yet")).toBeTruthy();
    expect(within(card("Alex Admin")).getByText("You")).toBeTruthy();
  });

  it("saves a role and the Approver permission together", async () => {
    await openUsers();
    const rileyCard = card("Riley Requester");
    const approver = within(rileyCard).getByRole("checkbox", { name: "Approver" }) as HTMLInputElement;
    expect(approver.disabled).toBe(true);

    await userEvent.click(within(rileyCard).getByRole("checkbox", { name: "Reviewer" }));
    expect(approver.disabled).toBe(false);
    await userEvent.click(approver);
    await userEvent.click(within(rileyCard).getByRole("button", { name: "Save changes" }));

    expect(fakeApi.updateUserAccess).toHaveBeenCalledWith(riley.id, { roles: ["requester", "reviewer"], approve: true, isActive: true });
    expect(await screen.findByText(/Access for Riley Requester was updated/)).toBeTruthy();
    expect(storedUsers().find((u) => u.id === riley.id)).toMatchObject({ roles: ["requester", "reviewer"], permissions: ["approve"] });
    expect(within(rileyCard).queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("drops Approver when the last reviewing role is removed", async () => {
    const approver = makeUser({ email: "avery@example.test", displayName: "Avery Approver", roles: ["reviewer"], permissions: ["approve"] });
    seedUsers(approver);
    await openUsers();
    const averyCard = card("Avery Approver");

    await userEvent.click(within(averyCard).getByRole("checkbox", { name: "Requester" }));
    await userEvent.click(within(averyCard).getByRole("checkbox", { name: "Reviewer" }));
    expect((within(averyCard).getByRole("checkbox", { name: "Approver" }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(within(averyCard).getByRole("button", { name: "Save changes" }));

    expect(fakeApi.updateUserAccess).toHaveBeenCalledWith(approver.id, { roles: ["requester"], approve: false, isActive: true });
  });

  it("explains an account with no roles instead of saving it", async () => {
    await openUsers();
    const rileyCard = card("Riley Requester");

    await userEvent.click(within(rileyCard).getByRole("checkbox", { name: "Requester" }));

    expect(within(rileyCard).getByRole("alert").textContent).toBe("Give the account at least one role, or deactivate it instead.");
    expect((within(rileyCard).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("deactivates an account and can discard an unsaved change", async () => {
    await openUsers();
    const rileyCard = card("Riley Requester");

    await userEvent.click(within(rileyCard).getByRole("checkbox", { name: "Reviewer" }));
    await userEvent.click(within(rileyCard).getByRole("button", { name: "Discard" }));
    expect((within(rileyCard).getByRole("checkbox", { name: "Reviewer" }) as HTMLInputElement).checked).toBe(false);

    await userEvent.click(within(rileyCard).getByRole("checkbox", { name: "Active" }));
    await userEvent.click(within(rileyCard).getByRole("button", { name: "Save changes" }));
    expect(await within(rileyCard).findByText("Deactivated")).toBeTruthy();
    expect(storedUsers().find((u) => u.id === riley.id)!.isActive).toBe(false);
  });

  it("won't let administrators remove their own Administrator role or deactivate themselves", async () => {
    await openUsers();
    const myCard = card("Alex Admin");

    expect((within(myCard).getByRole("checkbox", { name: "Administrator" }) as HTMLInputElement).disabled).toBe(true);
    expect((within(myCard).getByRole("checkbox", { name: "Active" }) as HTMLInputElement).disabled).toBe(true);

    await userEvent.click(within(myCard).getByRole("checkbox", { name: "Reviewer" }));
    await userEvent.click(within(myCard).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Your access was updated. Reload the page/)).toBeTruthy();
  });

  it("shows the server's reason when a change is refused", async () => {
    await openUsers();
    const rileyCard = card("Riley Requester");
    fakeApi.updateUserAccess.mockRejectedValueOnce(new ApiRequestError(403, "Only administrators can manage accounts."));

    await userEvent.click(within(rileyCard).getByRole("checkbox", { name: "Reviewer" }));
    await userEvent.click(within(rileyCard).getByRole("button", { name: "Save changes" }));

    expect((await within(rileyCard).findByRole("alert")).textContent).toBe("Only administrators can manage accounts.");
    expect((within(rileyCard).getByRole("checkbox", { name: "Reviewer" }) as HTMLInputElement).checked).toBe(true);
  });

  it("filters people by name or email", async () => {
    await openUsers();

    await userEvent.type(screen.getByLabelText("Find a person"), "riley");

    expect(screen.getByText("1 of 3 people")).toBeTruthy();
    expect(screen.getByRole("article", { name: /Riley Requester/ })).toBeTruthy();
    expect(screen.queryByRole("article", { name: /Alex Admin/ })).toBeNull();
  });

  it("explains a failure to load and retries", async () => {
    fakeApi.listUsers.mockRejectedValueOnce(new ApiRequestError(0, "Couldn't reach ClausePilot. Check your connection and try again."));
    renderApp();
    await screen.findByRole("navigation", { name: /primary navigation/i });
    await userEvent.selectOptions(screen.getByLabelText("Viewing as"), "Administrator");
    await userEvent.click(within(nav()).getByRole("button", { name: "Users" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't reach ClausePilot");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("3 people")).toBeTruthy();
  });
});
