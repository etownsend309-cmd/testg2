/**
 * The contract between the browser and the `/api` Netlify Function.
 *
 * Both sides import these types, so a field renamed on one side fails to
 * typecheck on the other. Wire values use the database's own codes
 * (`needs_review`, `reviewer`); the display labels the UI already uses live in
 * the label maps at the bottom.
 */

import type { AgreementStatus, Role } from "../types";

export const APP_ROLES = ["requester", "reviewer", "administrator"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const APP_PERMISSIONS = ["approve"] as const;
export type AppPermission = (typeof APP_PERMISSIONS)[number];

export const AGREEMENT_STATUSES = ["needs_review", "in_review", "approved", "escalated"] as const;
export type AgreementStatusCode = (typeof AGREEMENT_STATUSES)[number];

export const FINDING_DECISIONS = ["pending", "accepted", "dismissed", "escalated"] as const;
export type FindingDecisionCode = (typeof FINDING_DECISIONS)[number];

export type FindingMethodCode = "local_rule" | "manual";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roles: AppRole[];
  permissions: AppPermission[];
}

export interface AgreementSummary {
  id: string;
  name: string;
  vendor: string;
  agreementType: string;
  businessUnit: string;
  /** YYYY-MM-DD, or null when not given. */
  neededBy: string | null;
  submittedBy: { id: string; email: string; displayName: string };
  submittedAt: string;
  status: AgreementStatusCode;
  completedAt: string | null;
  approvedAt: string | null;
  findingCount: number;
  pendingFindingCount: number;
}

export interface FindingRecord {
  id: string;
  category: string;
  confidence: number;
  sourceText: string;
  decision: FindingDecisionCode;
  note: string;
  method: FindingMethodCode;
  decidedAt: string | null;
}

export interface DocumentRecord {
  id: string;
  fileName: string;
  contentType: "application/pdf" | "text/plain";
  byteSize: number;
  uploadedAt: string;
}

export interface AgreementDetail extends AgreementSummary {
  rawText: string;
  pageCount: number | null;
  extractionStrategy: string | null;
  extractionWarnings: string[];
  approvedBy: string | null;
  findings: FindingRecord[];
  documents: DocumentRecord[];
}

export interface NewAgreementInput {
  name: string;
  vendor: string;
  agreementType: string;
  businessUnit: string;
  /** YYYY-MM-DD, or "" when not given. */
  neededBy: string;
  rawText: string;
  pageCount?: number;
  extractionStrategy?: string;
  extractionWarnings?: string[];
}

export interface FindingDecisionInput {
  decision: FindingDecisionCode;
  note?: string;
}

export interface ManualFindingInput {
  category: string;
  sourceText: string;
  note?: string;
}

/** Finding counts for one playbook category, across the agreements the person may see. */
export interface CategoryReportRow {
  category: string;
  total: number;
  accepted: number;
  escalated: number;
}

export interface CategoryReport {
  /** How many agreements the counts cover. */
  agreementCount: number;
  /** One row per approved category, in playbook order, including categories with no findings. */
  categories: CategoryReportRow[];
}

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  /** False until the person first signs in with Netlify Identity. */
  hasSignedIn: boolean;
  lastSeenAt: string | null;
  roles: AppRole[];
  permissions: AppPermission[];
}

export interface UserAccessInput {
  roles: AppRole[];
  approve: boolean;
  isActive: boolean;
}

export interface ApiErrorBody {
  error: string;
}

/** Hard limits, enforced on the server and mirrored in the browser for early feedback. */
export const LIMITS = {
  documentBytes: 25 * 1024 * 1024,
  rawTextChars: 2_000_000,
  shortTextChars: 200,
  noteChars: 4_000,
} as const;

export const STATUS_LABELS: Record<AgreementStatusCode, AgreementStatus> = {
  needs_review: "Needs review",
  in_review: "In review",
  approved: "Approved",
  escalated: "Escalated",
};

export const ROLE_LABELS: Record<AppRole, Role> = {
  requester: "Requester",
  reviewer: "Reviewer",
  administrator: "Administrator",
};

/**
 * The workspace views a person may switch between.
 *
 * Approver is a permission rather than a role, but the app presents it as its
 * own view because approving is a distinct job. It is offered only to someone
 * who holds the permission, which in turn requires a reviewing role.
 */
export function availableViews(user: Pick<SessionUser, "roles" | "permissions">): Role[] {
  const views: Role[] = [];
  if (user.roles.includes("requester")) views.push("Requester");
  if (user.roles.includes("reviewer") || user.roles.includes("administrator")) views.push("Reviewer");
  if (user.permissions.includes("approve")) views.push("Approver");
  if (user.roles.includes("administrator")) views.push("Administrator");
  return views;
}
