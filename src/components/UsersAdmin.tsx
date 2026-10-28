import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { APP_ROLES, ROLE_LABELS, type AppRole, type ManagedUser, type UserAccessInput } from "../shared/api";

const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(date));

const errorMessage = (reason: unknown, fallback: string) => (reason instanceof Error && reason.message ? reason.message : fallback);

const ROLE_HELP: Record<AppRole, string> = {
  requester: "Submits agreements and tracks their own",
  reviewer: "Sees every agreement and records decisions",
  administrator: "Reviews, and manages people's access",
};

const accessOf = (user: ManagedUser): UserAccessInput => ({
  roles: APP_ROLES.filter((role) => user.roles.includes(role)),
  approve: user.permissions.includes("approve"),
  isActive: user.isActive,
});

const sameAccess = (a: UserAccessInput, b: UserAccessInput) =>
  a.approve === b.approve && a.isActive === b.isActive && a.roles.length === b.roles.length && a.roles.every((role) => b.roles.includes(role));

const canApprove = (roles: AppRole[]) => roles.includes("reviewer") || roles.includes("administrator");

/** Why an edited access can't be saved, if it can't. Mirrors the server's own checks for early feedback. */
function problemWith(access: UserAccessInput, isSelf: boolean): string | undefined {
  if (access.roles.length === 0) return "Give the account at least one role, or deactivate it instead.";
  if (access.approve && !canApprove(access.roles)) return "Approver needs the Reviewer or Administrator role.";
  if (isSelf && !access.roles.includes("administrator")) return "You can't remove your own Administrator role.";
  if (isSelf && !access.isActive) return "You can't deactivate your own account.";
  return undefined;
}

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/**
 * The Administrator's Users page: everyone with a ClausePilot account and
 * what they may do. The API and database enforce the same rules again; the
 * checks here only explain them before a request is sent.
 */
export function UsersAdmin({ currentUserId, onNotice }: { currentUserId: string; onNotice: (message: string) => void }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [drafts, setDrafts] = useState<Record<string, UserAccessInput>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string>();
  const [filter, setFilter] = useState("");

  const load = async () => {
    setState({ kind: "loading" });
    try {
      setUsers(await api.listUsers());
      setState({ kind: "ready" });
    } catch (reason) {
      setState({ kind: "error", message: errorMessage(reason, "Couldn't load the people in this workspace.") });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? users.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(needle)) : users;
  }, [users, filter]);

  const edit = (user: ManagedUser, change: (access: UserAccessInput) => UserAccessInput) => {
    setDrafts((current) => {
      const next = change(current[user.id] ?? accessOf(user));
      // An Approver who loses every reviewing role can no longer approve.
      if (next.approve && !canApprove(next.roles)) next.approve = false;
      const copy = { ...current };
      if (sameAccess(next, accessOf(user))) delete copy[user.id];
      else copy[user.id] = next;
      return copy;
    });
    setErrors((current) => ({ ...current, [user.id]: "" }));
  };

  const toggleRole = (user: ManagedUser, role: AppRole, on: boolean) =>
    edit(user, (access) => ({
      ...access,
      roles: on ? APP_ROLES.filter((r) => r === role || access.roles.includes(r)) : access.roles.filter((r) => r !== role),
    }));

  const discard = (user: ManagedUser) => {
    setDrafts((current) => {
      const copy = { ...current };
      delete copy[user.id];
      return copy;
    });
    setErrors((current) => ({ ...current, [user.id]: "" }));
  };

  const save = async (user: ManagedUser) => {
    const access = drafts[user.id];
    if (!access || saving) return;
    setSaving(user.id);
    try {
      const updated = await api.updateUserAccess(user.id, access);
      setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      discard(updated);
      const name = updated.displayName || updated.email;
      onNotice(
        updated.id === currentUserId
          ? `Your access was updated. Reload the page to see your new views.`
          : `Access for ${name} was updated. It applies from their next action.`,
      );
    } catch (reason) {
      setErrors((current) => ({ ...current, [user.id]: errorMessage(reason, "The change was not saved.") }));
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <section className="narrow-page users-page">
      <div className="page-heading">
        <span className="eyebrow">Administration</span>
        <h1>Users</h1>
        <p>
          Choose what each person can do. To add someone, invite them from Netlify Identity; they appear here after they first sign in,
          as a Requester.
        </p>
      </div>

      {state.kind === "loading" && <p className="panel users-message">Loading people…</p>}
      {state.kind === "error" && (
        <div className="panel users-message">
          <p className="error-message" role="alert">{state.message}</p>
          <button className="primary-button" onClick={() => void load()}>Try again</button>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <label className="users-filter">
            <span>Find a person</span>
            <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name or email" />
          </label>
          <p className="users-count">{shown.length === users.length ? `${users.length} people` : `${shown.length} of ${users.length} people`}</p>

          {shown.length === 0 && <p className="panel users-message">No one matches “{filter.trim()}”.</p>}

          {shown.map((user) => {
            const isSelf = user.id === currentUserId;
            const access = drafts[user.id] ?? accessOf(user);
            const dirty = user.id in drafts;
            const problem = dirty ? problemWith(access, isSelf) : undefined;
            const error = errors[user.id];
            const headingId = `user-${user.id}`;
            return (
              <article key={user.id} className={`panel user-card${access.isActive ? "" : " inactive"}`} aria-labelledby={headingId}>
                <div className="user-card-heading">
                  <div>
                    <h2 id={headingId}>{user.displayName || user.email}{isSelf && <span className="user-tag">You</span>}</h2>
                    {user.displayName && <p className="user-email">{user.email}</p>}
                  </div>
                  <p className="user-seen">
                    {!user.isActive ? "Deactivated" : !user.hasSignedIn ? "Hasn't signed in yet" : user.lastSeenAt ? `Last seen ${formatDate(user.lastSeenAt)}` : "Signed in"}
                  </p>
                </div>

                <fieldset className="user-access" disabled={saving === user.id}>
                  <legend className="visually-hidden">Access for {user.email}</legend>
                  {APP_ROLES.map((role) => {
                    const locked = isSelf && role === "administrator";
                    return (
                      <AccessOption
                        key={role}
                        id={`${user.id}-${role}`}
                        label={ROLE_LABELS[role]}
                        help={locked ? "You can't remove your own" : ROLE_HELP[role]}
                        checked={access.roles.includes(role)}
                        disabled={locked}
                        onChange={(on) => toggleRole(user, role, on)}
                      />
                    );
                  })}
                  <AccessOption
                    id={`${user.id}-approve`}
                    label="Approver"
                    help={canApprove(access.roles) ? "Can approve completed reviews" : "Needs the Reviewer or Administrator role"}
                    checked={access.approve}
                    disabled={!canApprove(access.roles)}
                    onChange={(on) => edit(user, (current) => ({ ...current, approve: on }))}
                  />
                  <AccessOption
                    id={`${user.id}-active`}
                    label="Active"
                    help={isSelf ? "You can't deactivate yourself" : "Clear to block sign-in without deleting"}
                    checked={access.isActive}
                    disabled={isSelf}
                    onChange={(on) => edit(user, (current) => ({ ...current, isActive: on }))}
                  />
                </fieldset>

                {(problem || error) && <p className="error-message" role="alert">{problem ?? error}</p>}
                {dirty && (
                  <div className="user-actions">
                    <button type="button" className="text-button" onClick={() => discard(user)} disabled={saving === user.id}>Discard</button>
                    <button type="button" className="primary-button" onClick={() => void save(user)} disabled={Boolean(problem) || saving !== undefined}>
                      {saving === user.id ? "Saving…" : "Save changes"}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}

/** One checkbox, named by its label alone, with its help text as the description. */
function AccessOption({
  id,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={`user-option${disabled ? " disabled" : ""}`}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={`${id}-help`} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id}>{label}</label>
      <small id={`${id}-help`}>{help}</small>
    </div>
  );
}
