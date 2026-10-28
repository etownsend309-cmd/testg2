/**
 * A stand-in for the `/api` Netlify Function, for browser tests.
 *
 * The Vite dev server has no Netlify Functions, so each test page gets its own
 * in-memory copy of the API through `page.route`. It follows the workflow
 * rules the screens rely on (findings from the playbook rules on submit, a
 * decision moves an agreement into review, completion approves or escalates)
 * but not access control: tests/integration covers the real handler and
 * database, policies included.
 */

import type { Page, Route } from "@playwright/test";

import { analyzeAgreement, playbook } from "../../../src/lib/analyze";
import type {
  AgreementDetail,
  AgreementSummary,
  CategoryReport,
  FindingDecisionInput,
  ManagedUser,
  ManualFindingInput,
  NewAgreementInput,
  SessionUser,
  UserAccessInput,
} from "../../../src/shared/api";

export interface FakeServer {
  /** What the server currently holds, newest first. */
  agreements(): AgreementDetail[];
  /** The accounts the server holds, by email. */
  users(): ManagedUser[];
  /** Adds accounts, as if those people had signed in. */
  addUsers(...users: ManagedUser[]): void;
  /** Makes the next request to `path` (e.g. "POST /api/agreements") fail with this status and message. */
  failNext(request: string, status: number, error: string): void;
}

export async function installFakeServer(page: Page, session: SessionUser): Promise<FakeServer> {
  const store = new Map<string, AgreementDetail>();
  const failures = new Map<string, { status: number; error: string }>();
  const accounts = new Map<string, ManagedUser>([
    [
      session.id,
      {
        id: session.id,
        email: session.email,
        displayName: session.displayName,
        isActive: true,
        hasSignedIn: true,
        lastSeenAt: new Date().toISOString(),
        roles: session.roles,
        permissions: session.permissions,
      },
    ],
  ]);
  const byEmail = () => [...accounts.values()].sort((a, b) => a.email.localeCompare(b.email));

  const summary = (detail: AgreementDetail): AgreementSummary => ({
    id: detail.id,
    name: detail.name,
    vendor: detail.vendor,
    agreementType: detail.agreementType,
    businessUnit: detail.businessUnit,
    neededBy: detail.neededBy,
    submittedBy: detail.submittedBy,
    submittedAt: detail.submittedAt,
    status: detail.status,
    completedAt: detail.completedAt,
    approvedAt: detail.approvedAt,
    findingCount: detail.findings.length,
    pendingFindingCount: detail.findings.filter((f) => f.decision === "pending").length,
  });
  const newest = () => [...store.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const isComplete = (detail: AgreementDetail) => detail.status === "approved" || detail.status === "escalated";

  const reply = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  const fail = (route: Route, status: number, error: string) => route.fulfill({ status, json: { error } });

  async function handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    const failure = failures.get(`${method} ${path}`);
    if (failure) {
      failures.delete(`${method} ${path}`);
      return fail(route, failure.status, failure.error);
    }

    let match: RegExpMatchArray | null;
    if (method === "GET" && path === "/api/users") {
      if (!session.roles.includes("administrator")) return fail(route, 403, "Only administrators can manage accounts.");
      return reply(route, byEmail());
    }
    if ((match = path.match(/^\/api\/users\/([^/]+)\/access$/)) && method === "PUT") {
      if (!session.roles.includes("administrator")) return fail(route, 403, "Only administrators can manage accounts.");
      const user = accounts.get(match[1]!);
      if (!user) return fail(route, 404, "That account was not found.");
      const input = request.postDataJSON() as UserAccessInput;
      if (input.roles.length === 0) return fail(route, 400, "Give the account at least one role, or deactivate it instead.");
      if (input.approve && !input.roles.includes("reviewer") && !input.roles.includes("administrator")) {
        return fail(route, 400, "The Approver permission requires the Reviewer or Administrator role.");
      }
      Object.assign(user, { roles: input.roles, permissions: input.approve ? ["approve"] : [], isActive: input.isActive });
      return reply(route, user);
    }
    if (method === "GET" && path === "/api/session") return reply(route, session);
    if (method === "GET" && path === "/api/agreements") return reply(route, newest().map(summary));
    if (method === "GET" && path === "/api/reports/categories") {
      const findings = [...store.values()].flatMap((d) => d.findings);
      const report: CategoryReport = {
        agreementCount: store.size,
        categories: playbook.map(({ name }) => {
          const rows = findings.filter((f) => f.category === name);
          return {
            category: name,
            total: rows.length,
            accepted: rows.filter((f) => f.decision === "accepted").length,
            escalated: rows.filter((f) => f.decision === "escalated").length,
          };
        }),
      };
      return reply(route, report);
    }
    if (method === "POST" && path === "/api/agreements") {
      const input = request.postDataJSON() as NewAgreementInput;
      const id = crypto.randomUUID();
      const detail: AgreementDetail = {
        id,
        name: input.name,
        vendor: input.vendor,
        agreementType: input.agreementType,
        businessUnit: input.businessUnit,
        neededBy: input.neededBy || null,
        submittedBy: { id: session.id, email: session.email, displayName: session.displayName },
        submittedAt: new Date().toISOString(),
        status: "needs_review",
        completedAt: null,
        approvedAt: null,
        findingCount: 0,
        pendingFindingCount: 0,
        rawText: input.rawText,
        pageCount: input.pageCount ?? null,
        extractionStrategy: input.extractionStrategy ?? null,
        extractionWarnings: input.extractionWarnings ?? [],
        approvedBy: null,
        documents: [],
        findings: analyzeAgreement(input.rawText).map((finding) => ({
          id: crypto.randomUUID(),
          category: finding.category,
          confidence: finding.confidence,
          sourceText: finding.sourceText,
          decision: "pending",
          note: "",
          method: "local_rule",
          decidedAt: null,
        })),
      };
      store.set(id, detail);
      return reply(route, detail, 201);
    }
    if ((match = path.match(/^\/api\/agreements\/([^/]+)$/)) && method === "GET") {
      const detail = store.get(match[1]!);
      return detail ? reply(route, detail) : fail(route, 404, "That agreement was not found.");
    }
    if ((match = path.match(/^\/api\/agreements\/([^/]+)\/documents$/)) && method === "POST") {
      const detail = store.get(match[1]!);
      if (!detail) return fail(route, 404, "That agreement was not found.");
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const fileName = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1] ?? "agreement";
      const record = {
        id: crypto.randomUUID(),
        fileName,
        contentType: fileName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain",
        byteSize: body.length,
        uploadedAt: new Date().toISOString(),
      } as const;
      detail.documents.push(record);
      return reply(route, record, 201);
    }
    if ((match = path.match(/^\/api\/findings\/([^/]+)$/)) && method === "PATCH") {
      const detail = [...store.values()].find((d) => d.findings.some((f) => f.id === match![1]));
      if (!detail) return fail(route, 404, "That finding was not found.");
      if (isComplete(detail)) return fail(route, 409, "This review is already complete.");
      const input = request.postDataJSON() as FindingDecisionInput;
      const finding = detail.findings.find((f) => f.id === match![1])!;
      finding.decision = input.decision;
      if (input.note !== undefined) finding.note = input.note;
      if (detail.status === "needs_review") detail.status = "in_review";
      return reply(route, detail);
    }
    if ((match = path.match(/^\/api\/agreements\/([^/]+)\/findings$/)) && method === "POST") {
      const detail = store.get(match[1]!);
      if (!detail) return fail(route, 404, "That agreement was not found.");
      if (isComplete(detail)) return fail(route, 409, "This review is already complete.");
      const input = request.postDataJSON() as ManualFindingInput;
      detail.findings.push({
        id: crypto.randomUUID(),
        category: input.category,
        confidence: 1,
        sourceText: input.sourceText,
        decision: "pending",
        note: input.note ?? "Added manually by reviewer.",
        method: "manual",
        decidedAt: null,
      });
      if (detail.status === "needs_review") detail.status = "in_review";
      return reply(route, detail, 201);
    }
    if ((match = path.match(/^\/api\/agreements\/([^/]+)\/complete$/)) && method === "POST") {
      const detail = store.get(match[1]!);
      if (!detail) return fail(route, 404, "That agreement was not found.");
      if (isComplete(detail)) return fail(route, 409, "This review is already complete.");
      if (detail.findings.some((f) => f.decision === "pending")) {
        return fail(route, 409, "Record a decision on every finding before completing the review.");
      }
      const escalated = detail.findings.some((f) => f.decision === "escalated");
      if (!escalated && !session.permissions.includes("approve")) {
        return fail(route, 403, "Approving an agreement requires the Approver permission.");
      }
      detail.status = escalated ? "escalated" : "approved";
      detail.completedAt = new Date().toISOString();
      return reply(route, detail);
    }
    return fail(route, 404, "That API route was not found.");
  }

  await page.route("**/api/**", handle);

  return {
    agreements: () => structuredClone(newest()),
    users: () => structuredClone(byEmail()),
    addUsers: (...users) => users.forEach((user) => accounts.set(user.id, structuredClone(user))),
    failNext: (request, status, error) => failures.set(request, { status, error }),
  };
}
