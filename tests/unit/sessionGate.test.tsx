/**
 * @vitest-environment jsdom
 *
 * The step between Netlify Identity sign-in and the workspace: loading the
 * person's roles from the API, and turning those roles into the views the
 * "Viewing as" switcher offers.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../src/App";
import { SessionGate } from "../../src/components/SessionGate";
import { availableViews, type SessionUser } from "../../src/shared/api";

const session: SessionUser = {
  id: "a0000000-0000-4000-8000-000000000003",
  email: "approver@example.test",
  displayName: "Avery Approver",
  roles: ["reviewer"],
  permissions: ["approve"],
};

const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("availableViews", () => {
  it.each([
    [{ roles: ["requester"], permissions: [] }, ["Requester"]],
    [{ roles: ["reviewer"], permissions: [] }, ["Reviewer"]],
    [{ roles: ["reviewer"], permissions: ["approve"] }, ["Reviewer", "Approver"]],
    [{ roles: ["administrator"], permissions: [] }, ["Reviewer", "Administrator"]],
    [{ roles: ["requester", "administrator"], permissions: ["approve"] }, ["Requester", "Reviewer", "Approver", "Administrator"]],
  ] as const)("maps %j to %j", (user, views) => {
    expect(availableViews({ roles: [...user.roles], permissions: [...user.permissions] })).toEqual(views);
  });
});

describe("SessionGate", () => {
  it("shows the workspace once the account loads", async () => {
    respond(200, session);
    render(<SessionGate onSignOut={() => {}}>{(s) => <p>Hello {s.displayName}</p>}</SessionGate>);

    expect(screen.getByRole("status").textContent).toContain("Loading your workspace");
    await screen.findByText("Hello Avery Approver");
    expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("explains a deactivated account and offers only sign out", async () => {
    respond(403, { error: "Your ClausePilot account has been deactivated. Ask an administrator for access." });
    const onSignOut = vi.fn();
    render(<SessionGate onSignOut={onSignOut}>{() => <p>workspace</p>}</SessionGate>);

    expect((await screen.findByRole("alert")).textContent).toMatch(/deactivated/);
    expect(screen.queryByText("workspace")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("offers a retry when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(
      new Response(JSON.stringify(session), { status: 200 }),
    ));
    render(<SessionGate onSignOut={() => {}}>{(s) => <p>Hello {s.displayName}</p>}</SessionGate>);

    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach ClausePilot/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Hello Avery Approver");
  });

  it("signs out when the server no longer recognises the Identity session", async () => {
    respond(401, { error: "Sign in to continue." });
    const onSignOut = vi.fn();
    render(<SessionGate onSignOut={onSignOut}>{() => <p>workspace</p>}</SessionGate>);

    await vi.waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("workspace")).toBeNull();
  });
});

describe("the Viewing as switcher", () => {
  it("offers only the views the person's roles allow", () => {
    render(<App user={{ id: "x", email: session.email }} views={availableViews(session)} displayName="Avery Approver" onSignOut={() => {}} />);

    const switcher = screen.getByLabelText<HTMLSelectElement>("Viewing as");
    expect(within(switcher).getAllByRole("option").map((o) => o.textContent)).toEqual(["Reviewer", "Approver"]);
    expect(switcher.value).toBe("Reviewer");
    screen.getByText("Avery Approver");
  });

  it("is fixed for someone with a single view", () => {
    render(<App user={{ id: "x", email: "r@example.test" }} views={["Requester"]} onSignOut={() => {}} />);

    const switcher = screen.getByLabelText<HTMLSelectElement>("Viewing as");
    expect(switcher.value).toBe("Requester");
    expect(switcher.disabled).toBe(true);
  });
});
