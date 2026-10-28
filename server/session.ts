/**
 * Turns a verified Netlify Identity user into the application's session user.
 *
 * Netlify Identity proves who someone is (it issues and refreshes the `nf_jwt`
 * cookie the browser sends). The database decides what they may do: their
 * roles and the Approver permission live in `user_roles` and
 * `user_permissions`, not in the Identity token, so a change an administrator
 * makes applies on the very next request rather than after a token refresh.
 */

import type { AppPermission, AppRole, SessionUser } from "../src/shared/api.ts";
import type { Database, Queryable } from "./db.ts";
import { forbidden } from "./errors.ts";

/** The parts of a Netlify Identity user the app relies on. */
export interface IdentityUser {
  id: string;
  email?: string;
  name?: string;
}

/** Reads the signed-in Identity user for a request, or null. Verification happens inside. */
export type Authenticate = (request: Request) => Promise<IdentityUser | null>;

/** The default: `@netlify/identity` verifies the request's `nf_jwt` against the site's Identity service. */
export const netlifyIdentityAuthenticate: Authenticate = async () => {
  const { getUser } = await import("@netlify/identity");
  const user = await getUser();
  return user ? { id: user.id, email: user.email, name: user.name } : null;
};

/** Emails that are granted Administrator on sign-in, from the BOOTSTRAP_ADMIN_EMAILS setting. */
export function parseBootstrapAdmins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Finds or provisions the account for `identity` and returns its id, or null
 * when the account has been deactivated. See app.resolve_session in the RLS
 * migration for the claim-by-email and default-Requester rules.
 */
export async function resolveAccountId(
  database: Database,
  identity: IdentityUser,
  bootstrapAdmins: Set<string>,
): Promise<string | null> {
  const email = identity.email?.trim().toLowerCase();
  if (!email) throw forbidden("Your account has no email address, so it can't be linked to ClausePilot.");

  return database.withAnonymous(async (db) => {
    const { rows } = await db.query<{ id: string | null }>(
      "SELECT app.resolve_session($1, $2, $3, $4) AS id",
      [identity.id, email, identity.name ?? "", bootstrapAdmins.has(email)],
    );
    return rows[0]?.id ?? null;
  });
}

/** Loads the signed-in person's own record, roles and permissions (policies allow reading your own). */
export async function loadSessionUser(db: Queryable, userId: string): Promise<SessionUser> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    display_name: string;
    roles: AppRole[] | null;
    permissions: AppPermission[] | null;
  }>(
    `SELECT u.id, u.email, u.display_name,
            (SELECT array_agg(role::text ORDER BY role) FROM user_roles WHERE user_id = u.id) AS roles,
            (SELECT array_agg(permission::text ORDER BY permission) FROM user_permissions WHERE user_id = u.id) AS permissions
       FROM app_users u
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw forbidden("Your account is not active.");
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    roles: row.roles ?? [],
    permissions: row.permissions ?? [],
  };
}
