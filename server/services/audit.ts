import type { Queryable } from "../db.ts";

/** Appends to the audit trail. The table is insert-only for the application role. */
export async function recordAudit(
  db: Queryable,
  actorId: string,
  agreementId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    "INSERT INTO audit_events (actor_id, agreement_id, action, detail) VALUES ($1, $2, $3, $4)",
    [actorId, agreementId, action, JSON.stringify(detail)],
  );
}
