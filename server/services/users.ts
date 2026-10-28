/**
 * Account and access management for administrators.
 *
 * Row-level security limits every statement here to administrators. The
 * service adds the rules that keep a team from locking itself out: an
 * administrator cannot remove their own Administrator role or deactivate
 * themselves.
 */

import { APP_ROLES, type AppPermission, type AppRole, type ManagedUser, type UserAccessInput } from "../../src/shared/api.ts";
import { isUuid, type Queryable } from "../db.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { recordAudit } from "./audit.ts";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  identity_id: string | null;
  last_seen_at: Date | null;
  roles: AppRole[] | null;
  permissions: AppPermission[] | null;
}

const USER_COLUMNS = `
  u.id, u.email, u.display_name, u.is_active, u.identity_id, u.last_seen_at,
  (SELECT array_agg(role::text ORDER BY role) FROM user_roles WHERE user_id = u.id) AS roles,
  (SELECT array_agg(permission::text ORDER BY permission) FROM user_permissions WHERE user_id = u.id) AS permissions`;

function toManagedUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isActive: row.is_active,
    hasSignedIn: row.identity_id !== null,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    roles: row.roles ?? [],
    permissions: row.permissions ?? [],
  };
}

async function requireAdmin(db: Queryable) {
  const { rows } = await db.query<{ ok: boolean }>("SELECT app.is_admin() AS ok");
  if (!rows[0]?.ok) throw forbidden("Only administrators can manage accounts.");
}

export async function listUsers(db: Queryable): Promise<ManagedUser[]> {
  await requireAdmin(db);
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_users u ORDER BY u.email`);
  return rows.map(toManagedUser);
}

export function parseUserAccess(body: unknown): UserAccessInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const roles = input.roles;
  if (!Array.isArray(roles) || roles.some((role) => !APP_ROLES.includes(role as AppRole))) {
    throw badRequest(`Roles must be a list of: ${APP_ROLES.join(", ")}.`);
  }
  if (roles.length === 0) throw badRequest("Give the account at least one role, or deactivate it instead.");
  if (typeof input.approve !== "boolean" || typeof input.isActive !== "boolean") {
    throw badRequest("Send approve and isActive as true or false.");
  }
  const unique = [...new Set(roles as AppRole[])];
  if (input.approve && !unique.includes("reviewer") && !unique.includes("administrator")) {
    throw badRequest("The Approver permission requires the Reviewer or Administrator role.");
  }
  return { roles: unique, approve: input.approve, isActive: input.isActive };
}

export async function updateUserAccess(
  db: Queryable,
  actorId: string,
  targetId: string,
  input: UserAccessInput,
): Promise<ManagedUser> {
  await requireAdmin(db);
  if (!isUuid(targetId)) throw notFound("That account");

  const existing = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_users u WHERE u.id = $1 FOR UPDATE`, [targetId]);
  if (!existing.rows[0]) throw notFound("That account");

  if (targetId === actorId) {
    if (!input.roles.includes("administrator")) throw badRequest("You can't remove your own Administrator role.");
    if (!input.isActive) throw badRequest("You can't deactivate your own account.");
  }

  // Grant before revoking so the approve permission never sees a moment
  // without the reviewing role it depends on.
  for (const role of input.roles) {
    await db.query(
      "INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [targetId, role, actorId],
    );
  }
  if (input.approve) {
    await db.query(
      "INSERT INTO user_permissions (user_id, permission, granted_by) VALUES ($1, 'approve', $2) ON CONFLICT DO NOTHING",
      [targetId, actorId],
    );
  } else {
    await db.query("DELETE FROM user_permissions WHERE user_id = $1 AND permission = 'approve'", [targetId]);
  }
  await db.query("DELETE FROM user_roles WHERE user_id = $1 AND NOT (role = ANY($2::app_role[]))", [targetId, input.roles]);
  await db.query("UPDATE app_users SET is_active = $2 WHERE id = $1", [targetId, input.isActive]);

  await recordAudit(db, actorId, null, "user.access_changed", { userId: targetId, ...input });

  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_users u WHERE u.id = $1`, [targetId]);
  return toManagedUser(rows[0]!);
}
