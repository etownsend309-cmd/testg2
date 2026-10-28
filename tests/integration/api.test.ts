/**
 * The API end to end against a real database.
 *
 * Every test starts from the four committed migrations, seed data included,
 * applied to Netlify's local Postgres (PGlite). Requests go through the same
 * handler the Netlify Function uses, with only two stand-ins: an in-memory
 * document store instead of Netlify Blobs, and a fake identity check that
 * reads the signed-in user from a test header instead of verifying a Netlify
 * Identity token.
 *
 * Because the handler queries as `clausepilot_app`, these tests exercise the
 * row-level security policies, not just the service code above them.
 */

import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NetlifyDB } from "@netlify/database-dev";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AgreementDetail, AgreementSummary, CategoryReport, ManagedUser, SessionUser } from "../../src/shared/api.ts";
import { playbook } from "../../src/lib/analyze.ts";
import { createApiHandler } from "../../server/api.ts";
import { createDatabase, type ConnectionPool } from "../../server/db.ts";
import { createMemoryDocumentStore } from "../../server/documentStore.ts";
import type { IdentityUser } from "../../server/session.ts";

const ORIGIN = "https://clausepilot.example";
const MIGRATIONS = new URL("../../netlify/database/migrations", import.meta.url).pathname;
const CLEAR_MIGRATION = "20261028183000_clear_agreement_data.sql";

/**
 * Every migration except the clean start, which deletes the demo agreements
 * these tests are written against. The clean start has its own test below.
 */
const FIXTURE_MIGRATIONS = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "clausepilot-migrations-"));
  for (const file of readdirSync(MIGRATIONS)) {
    if (file !== CLEAR_MIGRATION) copyFileSync(path.join(MIGRATIONS, file), path.join(dir, file));
  }
  return dir;
})();

/** Netlify Identity users; the seeded app accounts are claimed by these emails. */
const people = {
  requester: { id: "idp-requester", email: "requester@example.test", name: "Riley" },
  reviewer: { id: "idp-reviewer", email: "reviewer@example.test", name: "Rowan" },
  approver: { id: "idp-approver", email: "approver@example.test", name: "Avery" },
  admin: { id: "idp-admin", email: "admin@example.test", name: "Alex" },
  stranger: { id: "idp-stranger", email: "stranger@example.test", name: "Sam" },
  founder: { id: "idp-founder", email: "Founder@Example.test", name: "Fran" },
} satisfies Record<string, IdentityUser>;
type Person = keyof typeof people;

const SEEDED = {
  newAgreement: "b0000000-0000-4000-8000-000000000001",
  inReview: "b0000000-0000-4000-8000-000000000002",
  approved: "b0000000-0000-4000-8000-000000000003",
  adminSubmitted: "b0000000-0000-4000-8000-000000000004",
  reviewerUser: "a0000000-0000-4000-8000-000000000002",
  requesterUser: "a0000000-0000-4000-8000-000000000001",
};

let netlifyDb: NetlifyDB;
let pool: pg.Pool;
let documents: ReturnType<typeof createMemoryDocumentStore>;
let handle: (request: Request) => Promise<Response>;

beforeAll(async () => {
  netlifyDb = new NetlifyDB({ logger: () => undefined });
  const connectionString = await netlifyDb.start();
  // PGlite serves one connection at a time.
  pool = new pg.Pool({ connectionString, max: 1 });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await netlifyDb?.stop();
});

beforeEach(async () => {
  await netlifyDb.reset();
  await netlifyDb.applyMigrations(FIXTURE_MIGRATIONS);
  documents = createMemoryDocumentStore();
  handle = createApiHandler({
    database: createDatabase(pool as unknown as ConnectionPool),
    documents,
    authenticate: async (request) => {
      const who = request.headers.get("x-test-person") as Person | null;
      return who ? people[who] : null;
    },
    bootstrapAdmins: new Set(["founder@example.test"]),
  });
}, 60_000);

interface Call {
  as?: Person;
  method?: string;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

async function call(path: string, { as, method = "GET", body, form, headers = {} }: Call = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (as) (init.headers as Record<string, string>)["x-test-person"] = as;
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (form) init.body = form;
  const response = await handle(new Request(`${ORIGIN}${path}`, init));
  return response;
}

async function callJson<T>(path: string, options: Call = {}): Promise<{ status: number; body: T }> {
  const response = await call(path, options);
  return { status: response.status, body: (await response.json()) as T };
}

const newAgreement = {
  name: "Acme Cloud Hosting",
  vendor: "Acme Hosting",
  agreementType: "Services Agreement",
  businessUnit: "IT",
  neededBy: "2026-12-01",
  rawText:
    "This Agreement is governed by the laws of the State of Georgia. Customer may terminate this Agreement for any reason upon thirty days' written notice.",
  // Not part of the contract: the server must ignore anything like this.
  findings: [{ category: "Exclusivity", confidence: 1, decision: "accepted" }],
};

const pdfFile = (name = "contract.pdf") =>
  new File([new TextEncoder().encode("%PDF-1.7\n%fake but well-formed header\n")], name, { type: "application/pdf" });

describe("sign-in and sessions", () => {
  it("rejects requests without a signed-in user", async () => {
    const { status, body } = await callJson<{ error: string }>("/api/session");
    expect(status).toBe(401);
    expect(body.error).toMatch(/sign in/i);
  });

  it("links a seeded account to its Identity user on first sign-in, by email", async () => {
    const { status, body } = await callJson<SessionUser>("/api/session", { as: "reviewer" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: SEEDED.reviewerUser, email: "reviewer@example.test", roles: ["reviewer"], permissions: [] });

    const again = await callJson<SessionUser>("/api/session", { as: "reviewer" });
    expect(again.body.id).toBe(SEEDED.reviewerUser);
  });

  it("represents Approver as a permission on top of the Reviewer role", async () => {
    const { body } = await callJson<SessionUser>("/api/session", { as: "approver" });
    expect(body.roles).toEqual(["reviewer"]);
    expect(body.permissions).toEqual(["approve"]);
  });

  it("gives a newly invited person the Requester role", async () => {
    const { body } = await callJson<SessionUser>("/api/session", { as: "stranger" });
    expect(body).toMatchObject({ email: "stranger@example.test", roles: ["requester"], permissions: [] });
  });

  it("makes configured bootstrap emails administrators, matching case-insensitively", async () => {
    const { body } = await callJson<SessionUser>("/api/session", { as: "founder" });
    expect(body.email).toBe("founder@example.test");
    expect(body.roles).toEqual(["requester", "administrator"]);
  });

  it("refuses cross-site writes that would ride the session cookie", async () => {
    const response = await call("/api/agreements", {
      as: "requester",
      method: "POST",
      body: newAgreement,
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});

describe("agreement visibility", () => {
  it("shows requesters only their own agreements", async () => {
    const { body } = await callJson<AgreementSummary[]>("/api/agreements", { as: "requester" });
    expect(body.map((a) => a.id).sort()).toEqual([SEEDED.newAgreement, SEEDED.inReview, SEEDED.approved].sort());
  });

  it("shows reviewers every agreement", async () => {
    const { body } = await callJson<AgreementSummary[]>("/api/agreements", { as: "reviewer" });
    expect(body).toHaveLength(4);
  });

  it("hides another person's agreement as not found rather than forbidden", async () => {
    const { status } = await callJson(`/api/agreements/${SEEDED.adminSubmitted}`, { as: "requester" });
    expect(status).toBe(404);
  });

  it("shows nothing to a new requester", async () => {
    const { body } = await callJson<AgreementSummary[]>("/api/agreements", { as: "stranger" });
    expect(body).toEqual([]);
  });
});

describe("submitting and reviewing", () => {
  it("records the submitter and generates findings on the server", async () => {
    const { status, body } = await callJson<AgreementDetail>("/api/agreements", {
      as: "requester",
      method: "POST",
      body: newAgreement,
    });
    expect(status).toBe(201);
    expect(body.status).toBe("needs_review");
    expect(body.submittedBy.email).toBe("requester@example.test");
    expect(body.neededBy).toBe("2026-12-01");
    expect(body.findings.map((f) => f.category).sort()).toEqual(["Governing Law", "Termination For Convenience"]);
    expect(body.findings.every((f) => f.decision === "pending" && f.method === "local_rule")).toBe(true);
  });

  it("validates the submission", async () => {
    const { status, body } = await callJson<{ error: string }>("/api/agreements", {
      as: "requester",
      method: "POST",
      body: { ...newAgreement, vendor: " " },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/vendor/i);
  });

  it("does not let reviewers submit agreements", async () => {
    const { status } = await callJson("/api/agreements", { as: "reviewer", method: "POST", body: newAgreement });
    expect(status).toBe(403);
  });

  it("does not let a requester decide findings, even on their own agreement", async () => {
    const detail = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.newAgreement}`, { as: "requester" });
    const finding = detail.body.findings[0]!;
    const { status } = await callJson(`/api/findings/${finding.id}`, {
      as: "requester",
      method: "PATCH",
      body: { decision: "accepted" },
    });
    expect(status).toBe(403);
  });

  it("moves an agreement into review when a reviewer records a decision", async () => {
    const detail = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.newAgreement}`, { as: "reviewer" });
    const finding = detail.body.findings[0]!;
    const { status, body } = await callJson<AgreementDetail>(`/api/findings/${finding.id}`, {
      as: "reviewer",
      method: "PATCH",
      body: { decision: "accepted", note: "Fine." },
    });
    expect(status).toBe(200);
    expect(body.status).toBe("in_review");
    expect(body.findings.find((f) => f.id === finding.id)).toMatchObject({ decision: "accepted", note: "Fine." });
  });

  async function acceptAll(agreementId: string, as: Person) {
    const detail = await callJson<AgreementDetail>(`/api/agreements/${agreementId}`, { as });
    for (const finding of detail.body.findings) {
      await call(`/api/findings/${finding.id}`, { as, method: "PATCH", body: { decision: "accepted" } });
    }
  }

  it("won't complete a review while findings are pending", async () => {
    const { status } = await callJson(`/api/agreements/${SEEDED.inReview}/complete`, { as: "approver", method: "POST" });
    expect(status).toBe(409);
  });

  it("requires the Approver permission to approve", async () => {
    await acceptAll(SEEDED.inReview, "reviewer");
    const denied = await callJson<{ error: string }>(`/api/agreements/${SEEDED.inReview}/complete`, {
      as: "reviewer",
      method: "POST",
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/Approver permission/);

    const approved = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.inReview}/complete`, {
      as: "approver",
      method: "POST",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.approvedBy).toBe("a0000000-0000-4000-8000-000000000003");
  });

  it("lets any reviewer complete a review as escalated", async () => {
    const detail = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.newAgreement}`, { as: "reviewer" });
    const [first, ...rest] = detail.body.findings;
    await call(`/api/findings/${first!.id}`, { as: "reviewer", method: "PATCH", body: { decision: "escalated" } });
    for (const finding of rest) {
      await call(`/api/findings/${finding.id}`, { as: "reviewer", method: "PATCH", body: { decision: "dismissed" } });
    }
    const { status, body } = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.newAgreement}/complete`, {
      as: "reviewer",
      method: "POST",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("escalated");
    expect(body.completedAt).not.toBeNull();
  });

  it("adds manual findings only in the approved categories", async () => {
    const bad = await callJson(`/api/agreements/${SEEDED.newAgreement}/findings`, {
      as: "reviewer",
      method: "POST",
      body: { category: "Indemnification", sourceText: "x" },
    });
    expect(bad.status).toBe(400);

    const good = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.newAgreement}/findings`, {
      as: "reviewer",
      method: "POST",
      body: { category: "Insurance", sourceText: "Vendor maintains insurance." },
    });
    expect(good.status).toBe(201);
    expect(good.body.findings.some((f) => f.method === "manual" && f.category === "Insurance")).toBe(true);
  });
});

describe("private document storage", () => {
  async function upload(as: Person, agreementId: string, file: File) {
    const form = new FormData();
    form.set("file", file);
    return callJson<{ id: string; error?: string }>(`/api/agreements/${agreementId}/documents`, {
      as,
      method: "POST",
      form,
    });
  }

  it("stores an upload privately and serves it only to people who can see the agreement", async () => {
    const uploaded = await upload("requester", SEEDED.newAgreement, pdfFile());
    expect(uploaded.status).toBe(201);
    expect(documents.keys()).toEqual([`agreements/${SEEDED.newAgreement}/${uploaded.body.id}`]);

    const own = await call(`/api/documents/${uploaded.body.id}`, { as: "requester" });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("application/pdf");
    expect(own.headers.get("cache-control")).toContain("no-store");
    expect(new TextDecoder().decode(await own.arrayBuffer())).toMatch(/^%PDF-1\.7/);

    expect((await call(`/api/documents/${uploaded.body.id}`, { as: "reviewer" })).status).toBe(200);
    expect((await call(`/api/documents/${uploaded.body.id}`, { as: "stranger" })).status).toBe(404);
    expect((await call(`/api/documents/${uploaded.body.id}`)).status).toBe(401);
  });

  it("does not let a requester attach files to someone else's agreement", async () => {
    const { status } = await upload("stranger", SEEDED.newAgreement, pdfFile());
    expect(status).toBe(404);
    expect(documents.keys()).toEqual([]);
  });

  it("does not let a requester attach files once review has started", async () => {
    const { status } = await upload("requester", SEEDED.inReview, pdfFile());
    expect(status).toBe(403);
    expect(documents.keys()).toEqual([]);
  });

  it("checks the file's contents, not just its name", async () => {
    const fake = new File(["just text"], "contract.pdf", { type: "application/pdf" });
    expect((await upload("requester", SEEDED.newAgreement, fake)).status).toBe(400);
    const exe = new File(["MZ"], "tool.exe", { type: "application/octet-stream" });
    expect((await upload("requester", SEEDED.newAgreement, exe)).status).toBe(400);
  });
});

describe("category report", () => {
  /** What the report should say, worked out from the agreements this person can open. */
  async function expectedReport(as: Person) {
    const list = await callJson<AgreementSummary[]>("/api/agreements", { as });
    const details = await Promise.all(list.body.map((a) => callJson<AgreementDetail>(`/api/agreements/${a.id}`, { as })));
    const findings = details.flatMap((d) => d.body.findings);
    return {
      agreementCount: list.body.length,
      categories: playbook.map(({ name }) => {
        const inCategory = findings.filter((f) => f.category === name);
        return {
          category: name,
          total: inCategory.length,
          accepted: inCategory.filter((f) => f.decision === "accepted").length,
          escalated: inCategory.filter((f) => f.decision === "escalated").length,
        };
      }),
    };
  }

  it.each(["requester", "reviewer"] as const)("counts only what the %s may see", async (as) => {
    const { status, body } = await callJson<CategoryReport>("/api/reports/categories", { as });
    expect(status).toBe(200);
    expect(body).toEqual(await expectedReport(as));
  });

  it("lists every approved category, even with no findings", async () => {
    const { body } = await callJson<CategoryReport>("/api/reports/categories", { as: "stranger" });
    expect(body.agreementCount).toBe(0);
    expect(body.categories.map((row) => row.category)).toEqual(playbook.map((c) => c.name));
    expect(body.categories.every((row) => row.total === 0)).toBe(true);
  });

  it("reflects a decision as soon as it is recorded", async () => {
    const before = await callJson<CategoryReport>("/api/reports/categories", { as: "reviewer" });
    const detail = await callJson<AgreementDetail>(`/api/agreements/${SEEDED.newAgreement}`, { as: "reviewer" });
    const finding = detail.body.findings[0]!;
    await callJson(`/api/findings/${finding.id}`, { as: "reviewer", method: "PATCH", body: { decision: "escalated" } });

    const after = await callJson<CategoryReport>("/api/reports/categories", { as: "reviewer" });
    const row = (report: CategoryReport) => report.categories.find((r) => r.category === finding.category)!;
    expect(row(after.body).escalated).toBe(row(before.body).escalated + 1);
  });
});

describe("account administration", () => {
  it("is limited to administrators", async () => {
    expect((await callJson("/api/users", { as: "reviewer" })).status).toBe(403);
    const { status, body } = await callJson<ManagedUser[]>("/api/users", { as: "admin" });
    expect(status).toBe(200);
    expect(body.map((u) => u.email)).toContain("approver@example.test");
  });

  it("grants Approver only alongside a reviewing role", async () => {
    const denied = await callJson(`/api/users/${SEEDED.requesterUser}/access`, {
      as: "admin",
      method: "PUT",
      body: { roles: ["requester"], approve: true, isActive: true },
    });
    expect(denied.status).toBe(400);

    const granted = await callJson<ManagedUser>(`/api/users/${SEEDED.requesterUser}/access`, {
      as: "admin",
      method: "PUT",
      body: { roles: ["requester", "reviewer"], approve: true, isActive: true },
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ roles: ["requester", "reviewer"], permissions: ["approve"] });

    // Takes effect on the next request, without waiting for a token refresh.
    const session = await callJson<SessionUser>("/api/session", { as: "requester" });
    expect(session.body.permissions).toEqual(["approve"]);
  });

  it("stops administrators locking themselves out", async () => {
    const me = await callJson<SessionUser>("/api/session", { as: "admin" });
    const { status } = await callJson(`/api/users/${me.body.id}/access`, {
      as: "admin",
      method: "PUT",
      body: { roles: ["reviewer"], approve: false, isActive: true },
    });
    expect(status).toBe(400);
  });

  it("cuts off a deactivated account immediately", async () => {
    await callJson(`/api/users/${SEEDED.reviewerUser}/access`, {
      as: "admin",
      method: "PUT",
      body: { roles: ["reviewer"], approve: false, isActive: false },
    });
    const { status, body } = await callJson<{ error: string }>("/api/agreements", { as: "reviewer" });
    expect(status).toBe(403);
    expect(body.error).toMatch(/deactivated/);
  });
});

describe("clean start migration", () => {
  const count = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0]!.n);

  it("removes every agreement and its history but keeps accounts and access", async () => {
    await callJson("/api/agreements", { as: "requester", method: "POST", body: newAgreement });
    await callJson(`/api/users/${SEEDED.reviewerUser}/access`, {
      as: "admin",
      method: "PUT",
      body: { roles: ["reviewer"], approve: true, isActive: true },
    });
    const accountsBefore = await count("SELECT count(*) AS n FROM app_users");
    const rolesBefore = await count("SELECT count(*) AS n FROM user_roles");
    expect(await count("SELECT count(*) AS n FROM agreements")).toBe(5);

    await netlifyDb.applyMigrations(MIGRATIONS);

    for (const table of ["agreements", "findings", "agreement_documents"]) {
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action <> 'user.access_changed'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'user.access_changed'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM app_users")).toBe(accountsBefore);
    expect(await count("SELECT count(*) AS n FROM user_roles")).toBe(rolesBefore);

    const session = await callJson<SessionUser>("/api/session", { as: "reviewer" });
    expect(session.body.permissions).toEqual(["approve"]);
    const list = await callJson<AgreementSummary[]>("/api/agreements", { as: "reviewer" });
    expect(list.body).toEqual([]);

    // The workspace keeps working afterwards.
    const created = await callJson<AgreementDetail>("/api/agreements", { as: "requester", method: "POST", body: newAgreement });
    expect(created.status).toBe(201);
  });
});
