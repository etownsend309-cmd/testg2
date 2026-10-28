/**
 * @vitest-environment jsdom
 *
 * Which screen the identity gate shows once the session has resolved.
 *
 * The cases that matter are the ones where a user exists but the app is still
 * the wrong thing to render: a recovery link signs the user in before the
 * password is chosen, and an invitation can be opened in a browser that
 * already holds a session. Handing either of them the app strands the link,
 * because `handleAuthCallback` clears its token from the address bar as it
 * reads it, leaving the token in React state only.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthGate } from "../../src/components/AuthGate";

vi.mock("@netlify/identity", () => ({
  acceptInvite: vi.fn(),
  getUser: vi.fn(),
  handleAuthCallback: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  onAuthChange: vi.fn(() => () => {}),
  requestPasswordRecovery: vi.fn(),
  updateUser: vi.fn(),
}));

const { getUser, handleAuthCallback, logout, updateUser } = await import("@netlify/identity");

/** A session that already exists in this browser, unrelated to any link. */
const existingUser = { id: "existing-user-id", email: "already@example.test" };

const renderGate = () => render(<AuthGate>{(user) => <p>Workspace for {user.email}</p>}</AuthGate>);

beforeEach(() => {
  vi.mocked(handleAuthCallback).mockResolvedValue(null);
  vi.mocked(getUser).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("identity gate", () => {
  it("shows the sign-in card when there is no session", async () => {
    renderGate();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText(/^Workspace for/)).toBeNull();
  });

  it("shows the app when a session exists and no link was followed", async () => {
    vi.mocked(getUser).mockResolvedValue(existingUser);

    renderGate();

    expect(await screen.findByText(`Workspace for ${existingUser.email}`)).toBeTruthy();
  });

  it.each([
    ["recovery", { type: "recovery" as const, user: existingUser }, "Choose a new password"],
    ["invitation", { type: "invite" as const, user: null, token: "invite-token" }, "Set your password"],
  ])("holds a signed-in user on the password card after %s", async (_kind, callback, heading) => {
    vi.mocked(handleAuthCallback).mockResolvedValue(callback);
    // The invitation case is the regression: the link carries no session of
    // its own, but one already in the browser is enough to satisfy `getUser`.
    vi.mocked(getUser).mockResolvedValue(existingUser);

    renderGate();

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
    expect(screen.queryByText(/^Workspace for/)).toBeNull();
  });
});

/**
 * An expired link is reported on the same card that caused it, and retrying
 * there can only fail again, so each password card needs a way off it. What
 * leaving should do differs by card, because the session underneath differs.
 */
describe("leaving the password card", () => {
  it("discards the stale session and offers a new link after recovery", async () => {
    vi.mocked(handleAuthCallback).mockResolvedValue({ type: "recovery", user: existingUser });
    vi.mocked(getUser).mockResolvedValue(existingUser);
    renderGate();
    await screen.findByRole("heading", { name: "Choose a new password" });

    await userEvent.click(screen.getByRole("button", { name: "Request a new reset link" }));

    expect(logout).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Reset password" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("returns an invited user to the session they already had", async () => {
    vi.mocked(handleAuthCallback).mockResolvedValue({ type: "invite", user: null, token: "invite-token" });
    vi.mocked(getUser).mockResolvedValue(existingUser);
    renderGate();
    await screen.findByRole("heading", { name: "Set your password" });

    await userEvent.click(screen.getByRole("button", { name: "← Back to sign in" }));

    // Signing them out of their own account would be the wrong read of
    // "back": the invitation is what they are declining, not the session.
    expect(logout).not.toHaveBeenCalled();
    expect(await screen.findByText(`Workspace for ${existingUser.email}`)).toBeTruthy();
  });

  it("keeps the user on the card while a password save is in flight", async () => {
    vi.mocked(handleAuthCallback).mockResolvedValue({ type: "recovery", user: existingUser });
    vi.mocked(getUser).mockResolvedValue(existingUser);
    vi.mocked(updateUser).mockImplementation(() => new Promise(() => {}));
    renderGate();
    await screen.findByRole("heading", { name: "Choose a new password" });
    await userEvent.type(screen.getByLabelText("New password"), "a-long-enough-password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "a-long-enough-password");

    await userEvent.click(screen.getByRole("button", { name: "Save password →" }));

    // The exit sits inside the fieldset the card disables while saving, so
    // bailing out cannot race a password update that may still succeed.
    expect(screen.getByRole("button", { name: "Request a new reset link" }).matches(":disabled")).toBe(true);
    expect(logout).not.toHaveBeenCalled();
  });
});
