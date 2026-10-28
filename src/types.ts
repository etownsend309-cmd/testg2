export type View = "overview" | "tracker" | "intake" | "review" | "reports";

export type Role = "Requester" | "Reviewer" | "Approver" | "Administrator";

export type FindingDecision = "pending" | "accepted" | "dismissed" | "escalated";

export type AgreementStatus =
  | "Needs review"
  | "In review"
  | "Approved"
  | "Escalated";

/** A rule-based finding as the playbook rules produce it (see src/lib/analyze.ts). */
export interface Finding {
  id: string;
  category: string;
  confidence: number;
  sourceText: string;
  decision: FindingDecision;
  note: string;
  method: "Local rule" | "Manual";
}
