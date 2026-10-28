/**
 * Agreements and their findings.
 *
 * Every function takes a `Queryable` already scoped to the signed-in user (see
 * server/db.ts), so row-level security decides visibility. The checks here
 * exist to give clear errors and to keep workflow rules in one readable place;
 * the database enforces the same rules again underneath.
 */

import { analyzeAgreement, playbook } from "../../src/lib/analyze.ts";
import {
  FINDING_DECISIONS,
  LIMITS,
  type AgreementDetail,
  type AgreementStatusCode,
  type AgreementSummary,
  type CategoryReport,
  type DocumentRecord,
  type FindingDecisionCode,
  type FindingDecisionInput,
  type FindingRecord,
  type ManualFindingInput,
  type NewAgreementInput,
} from "../../src/shared/api.ts";
import { isUuid, type Queryable } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { recordAudit } from "./audit.ts";

const CATEGORY_NAMES = new Set(playbook.map((category) => category.name));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface SummaryRow {
  id: string;
  name: string;
  vendor: string;
  agreement_type: string;
  business_unit: string;
  needed_by: string | null;
  submitted_by: string;
  submitter_email: string | null;
  submitter_name: string | null;
  submitted_at: Date;
  status: AgreementStatusCode;
  completed_at: Date | null;
  approved_at: Date | null;
  finding_count: number;
  pending_finding_count: number;
}

interface DetailRow extends SummaryRow {
  raw_text: string;
  page_count: number | null;
  extraction_strategy: string | null;
  extraction_warnings: string[];
  approved_by: string | null;
}

interface FindingRow {
  id: string;
  category: string;
  confidence: string;
  source_text: string;
  decision: FindingDecisionCode;
  note: string;
  method: "local_rule" | "manual";
  decided_at: Date | null;
}

interface DocumentRow {
  id: string;
  file_name: string;
  content_type: DocumentRecord["contentType"];
  byte_size: string;
  uploaded_at: Date;
}

// `needed_by::text` keeps dates as YYYY-MM-DD instead of a timezone-shifted Date.
// The submitter's name comes through a LEFT JOIN because requesters may only
// read their own app_users row; for their own agreements that is always them.
const SUMMARY_COLUMNS = `
  a.id, a.name, a.vendor, a.agreement_type, a.business_unit, a.needed_by::text AS needed_by,
  a.submitted_by, u.email AS submitter_email, u.display_name AS submitter_name,
  a.submitted_at, a.status, a.completed_at, a.approved_at,
  (SELECT count(*)::int FROM findings f WHERE f.agreement_id = a.id) AS finding_count,
  (SELECT count(*)::int FROM findings f WHERE f.agreement_id = a.id AND f.decision = 'pending') AS pending_finding_count`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toSummary(row: SummaryRow): AgreementSummary {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    agreementType: row.agreement_type,
    businessUnit: row.business_unit,
    neededBy: row.needed_by,
    submittedBy: {
      id: row.submitted_by,
      email: row.submitter_email ?? "",
      displayName: row.submitter_name ?? "",
    },
    submittedAt: row.submitted_at.toISOString(),
    status: row.status,
    completedAt: iso(row.completed_at),
    approvedAt: iso(row.approved_at),
    findingCount: row.finding_count,
    pendingFindingCount: row.pending_finding_count,
  };
}

function toFinding(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    category: row.category,
    confidence: Number(row.confidence),
    sourceText: row.source_text,
    decision: row.decision,
    note: row.note,
    method: row.method,
    decidedAt: iso(row.decided_at),
  };
}

export async function listAgreements(db: Queryable): Promise<AgreementSummary[]> {
  const { rows } = await db.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS}
       FROM agreements a LEFT JOIN app_users u ON u.id = a.submitted_by
      ORDER BY a.submitted_at DESC`,
  );
  return rows.map(toSummary);
}

/**
 * Finding counts per playbook category. Row-level security limits both
 * queries to the agreements this person may see, so a requester's report
 * covers only their own submissions.
 */
export async function categoryReport(db: Queryable): Promise<CategoryReport> {
  const agreements = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM agreements");
  const { rows } = await db.query<{ category: string; total: number; accepted: number; escalated: number }>(
    `SELECT f.category,
            count(*)::int AS total,
            count(*) FILTER (WHERE f.decision = 'accepted')::int AS accepted,
            count(*) FILTER (WHERE f.decision = 'escalated')::int AS escalated
       FROM findings f JOIN agreements a ON a.id = f.agreement_id
      GROUP BY f.category`,
  );
  const byCategory = new Map(rows.map((row) => [row.category, row]));
  return {
    agreementCount: agreements.rows[0]?.count ?? 0,
    categories: playbook.map(({ name }) => {
      const row = byCategory.get(name);
      return { category: name, total: row?.total ?? 0, accepted: row?.accepted ?? 0, escalated: row?.escalated ?? 0 };
    }),
  };
}

export async function getAgreement(db: Queryable, id: string): Promise<AgreementDetail> {
  if (!isUuid(id)) throw notFound("That agreement");

  const { rows } = await db.query<DetailRow>(
    `SELECT ${SUMMARY_COLUMNS}, a.raw_text, a.page_count, a.extraction_strategy,
            a.extraction_warnings, a.approved_by
       FROM agreements a LEFT JOIN app_users u ON u.id = a.submitted_by
      WHERE a.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound("That agreement");

  const findings = await db.query<FindingRow>(
    `SELECT id, category, confidence, source_text, decision, note, method, decided_at
       FROM findings WHERE agreement_id = $1 ORDER BY created_at, category`,
    [id],
  );
  const documents = await db.query<DocumentRow>(
    `SELECT id, file_name, content_type, byte_size, uploaded_at
       FROM agreement_documents WHERE agreement_id = $1 ORDER BY uploaded_at`,
    [id],
  );

  return {
    ...toSummary(row),
    rawText: row.raw_text,
    pageCount: row.page_count,
    extractionStrategy: row.extraction_strategy,
    extractionWarnings: row.extraction_warnings,
    approvedBy: row.approved_by,
    findings: findings.rows.map(toFinding),
    documents: documents.rows.map((doc) => ({
      id: doc.id,
      fileName: doc.file_name,
      contentType: doc.content_type,
      byteSize: Number(doc.byte_size),
      uploadedAt: doc.uploaded_at.toISOString(),
    })),
  };
}

function requiredText(value: unknown, label: string, max: number = LIMITS.shortTextChars): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${label} is required.`);
  if (value.length > max) throw badRequest(`${label} is too long.`);
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw badRequest(`${label} must be text.`);
  if (value.length > max) throw badRequest(`${label} is too long.`);
  return value.trim();
}

export function parseNewAgreement(body: unknown): NewAgreementInput {
  if (typeof body !== "object" || body === null) throw badRequest("Send the agreement details as JSON.");
  const input = body as Record<string, unknown>;

  const neededBy = optionalText(input.neededBy, "Needed by", 10);
  if (neededBy && !ISO_DATE.test(neededBy)) throw badRequest("Needed by must be a date (YYYY-MM-DD).");

  const rawText = optionalText(input.rawText, "Agreement text", LIMITS.rawTextChars);
  if (!rawText) throw badRequest("The agreement has no readable text.");

  const pageCount = input.pageCount;
  if (pageCount !== undefined && (!Number.isInteger(pageCount) || (pageCount as number) < 1)) {
    throw badRequest("Page count must be a positive whole number.");
  }

  const warnings = input.extractionWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((w) => typeof w !== "string" || w.length > 500) || warnings.length > 20) {
    throw badRequest("Extraction warnings must be a short list of text.");
  }

  return {
    name: requiredText(input.name, "Agreement name"),
    vendor: requiredText(input.vendor, "Vendor"),
    agreementType: requiredText(input.agreementType, "Agreement type"),
    businessUnit: requiredText(input.businessUnit, "Business unit"),
    neededBy,
    rawText,
    pageCount: pageCount as number | undefined,
    extractionStrategy: optionalText(input.extractionStrategy, "Extraction strategy", LIMITS.shortTextChars) || undefined,
    extractionWarnings: warnings as string[],
  };
}

/**
 * Submits an agreement as the signed-in user. Findings are produced here, by
 * the same deterministic rules the browser runs, rather than accepted from the
 * request: a requester cannot hand in pre-made findings.
 */
export async function submitAgreement(db: Queryable, userId: string, input: NewAgreementInput): Promise<AgreementDetail> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agreements (
       name, vendor, agreement_type, business_unit, needed_by, submitted_by,
       raw_text, page_count, extraction_strategy, extraction_warnings)
     VALUES ($1, $2, $3, $4, NULLIF($5, '')::date, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.name,
      input.vendor,
      input.agreementType,
      input.businessUnit,
      input.neededBy,
      userId,
      input.rawText,
      input.pageCount ?? null,
      input.extractionStrategy ?? null,
      input.extractionWarnings ?? [],
    ],
  );
  const id = rows[0]!.id;

  for (const finding of analyzeAgreement(input.rawText)) {
    await db.query(
      `INSERT INTO findings (agreement_id, category, confidence, source_text, method)
       VALUES ($1, $2, $3, $4, 'local_rule')`,
      [id, finding.category, finding.confidence, finding.sourceText],
    );
  }

  await recordAudit(db, userId, id, "agreement.submitted");
  return getAgreement(db, id);
}

async function lockAgreement(db: Queryable, id: string): Promise<{ status: AgreementStatusCode }> {
  if (!isUuid(id)) throw notFound("That agreement");
  const { rows } = await db.query<{ status: AgreementStatusCode }>(
    "SELECT status FROM agreements WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (rows[0]) return rows[0];

  // FOR UPDATE also applies the UPDATE policy, so a requester looking at their
  // own agreement gets no row here. Tell "can't see it" from "can't change it".
  const visible = await db.query("SELECT 1 FROM agreements WHERE id = $1", [id]);
  if (visible.rowCount) throw forbidden("Only reviewers can change an agreement under review.");
  throw notFound("That agreement");
}

/** A reviewer touching a new agreement moves it into review. */
async function markInReview(db: Queryable, id: string, status: AgreementStatusCode) {
  if (status === "needs_review") {
    await db.query("UPDATE agreements SET status = 'in_review' WHERE id = $1", [id]);
  }
}

export function parseDecision(body: unknown): FindingDecisionInput {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!FINDING_DECISIONS.includes(input.decision as FindingDecisionCode)) {
    throw badRequest(`Decision must be one of: ${FINDING_DECISIONS.join(", ")}.`);
  }
  return {
    decision: input.decision as FindingDecisionCode,
    note: input.note === undefined ? undefined : optionalText(input.note, "Note", LIMITS.noteChars),
  };
}

export async function decideFinding(
  db: Queryable,
  userId: string,
  findingId: string,
  input: FindingDecisionInput,
): Promise<AgreementDetail> {
  if (!isUuid(findingId)) throw notFound("That finding");
  const { rows } = await db.query<{ agreement_id: string }>(
    "SELECT agreement_id FROM findings WHERE id = $1",
    [findingId],
  );
  const agreementId = rows[0]?.agreement_id;
  if (!agreementId) throw notFound("That finding");

  const agreement = await lockAgreement(db, agreementId);
  if (agreement.status === "approved" || agreement.status === "escalated") {
    throw conflict("This review is already complete.");
  }

  const updated = await db.query(
    "UPDATE findings SET decision = $2, note = COALESCE($3, note) WHERE id = $1",
    [findingId, input.decision, input.note ?? null],
  );
  if (!updated.rowCount) throw forbidden("Only reviewers can record decisions.");

  await markInReview(db, agreementId, agreement.status);
  await recordAudit(db, userId, agreementId, "finding.decided", { findingId, decision: input.decision });
  return getAgreement(db, agreementId);
}

export function parseManualFinding(body: unknown): ManualFindingInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const category = requiredText(input.category, "Category");
  if (!CATEGORY_NAMES.has(category)) throw badRequest("That isn't one of the 12 approved categories.");
  return {
    category,
    sourceText: requiredText(input.sourceText, "Source text", LIMITS.noteChars),
    note: input.note === undefined ? undefined : optionalText(input.note, "Note", LIMITS.noteChars),
  };
}

export async function addManualFinding(
  db: Queryable,
  userId: string,
  agreementId: string,
  input: ManualFindingInput,
): Promise<AgreementDetail> {
  const agreement = await lockAgreement(db, agreementId);
  if (agreement.status === "approved" || agreement.status === "escalated") {
    throw conflict("This review is already complete.");
  }

  await db.query(
    `INSERT INTO findings (agreement_id, category, confidence, source_text, note, method)
     VALUES ($1, $2, 1, $3, $4, 'manual')`,
    [agreementId, input.category, input.sourceText, input.note ?? "Added manually by reviewer."],
  );
  await markInReview(db, agreementId, agreement.status);
  await recordAudit(db, userId, agreementId, "finding.added", { category: input.category });
  return getAgreement(db, agreementId);
}

/**
 * Completes a review. With any escalated finding the agreement is escalated,
 * which any reviewer may do; otherwise it is approved, which needs the
 * Approver permission (the database trigger refuses it without).
 */
export async function completeReview(db: Queryable, userId: string, agreementId: string): Promise<AgreementDetail> {
  const agreement = await lockAgreement(db, agreementId);
  if (agreement.status === "approved" || agreement.status === "escalated") {
    throw conflict("This review is already complete.");
  }

  const { rows } = await db.query<{ pending: number; escalated: number }>(
    `SELECT count(*) FILTER (WHERE decision = 'pending')::int AS pending,
            count(*) FILTER (WHERE decision = 'escalated')::int AS escalated
       FROM findings WHERE agreement_id = $1`,
    [agreementId],
  );
  const counts = rows[0] ?? { pending: 0, escalated: 0 };
  if (counts.pending > 0) throw conflict("Record a decision on every finding before completing the review.");

  const outcome: AgreementStatusCode = counts.escalated > 0 ? "escalated" : "approved";
  const updated = await db.query("UPDATE agreements SET status = $2 WHERE id = $1", [agreementId, outcome]);
  if (!updated.rowCount) throw forbidden("Only reviewers can complete a review.");

  await recordAudit(db, userId, agreementId, outcome === "approved" ? "agreement.approved" : "agreement.escalated");
  return getAgreement(db, agreementId);
}
