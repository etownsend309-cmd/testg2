/**
 * The `/api` request handler.
 *
 * Each request is authenticated with Netlify Identity, mapped to an
 * application account, and then served inside a database scope for that
 * account. Dependencies are passed in so tests can supply a local database,
 * an in-memory document store and a fake identity.
 */

import type { ApiErrorBody, SessionUser } from "../src/shared/api.ts";
import type { Database, Queryable } from "./db.ts";
import type { DocumentStore } from "./documentStore.ts";
import { ApiError, badRequest, forbidden, notFound, toApiError, unauthorized } from "./errors.ts";
import {
  addManualFinding,
  categoryReport,
  completeReview,
  decideFinding,
  getAgreement,
  listAgreements,
  parseDecision,
  parseManualFinding,
  parseNewAgreement,
  submitAgreement,
} from "./services/agreements.ts";
import { downloadDocument, uploadDocument } from "./services/documents.ts";
import { listUsers, parseUserAccess, updateUserAccess } from "./services/users.ts";
import { loadSessionUser, resolveAccountId, type Authenticate } from "./session.ts";

export interface ApiDependencies {
  database: Database;
  documents: DocumentStore;
  authenticate: Authenticate;
  bootstrapAdmins: Set<string>;
}

interface RouteContext {
  request: Request;
  params: string[];
  user: SessionUser;
  db: Queryable;
  documents: DocumentStore;
}

type Handler = (context: RouteContext) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const ID = "([0-9a-fA-F-]{36})";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw badRequest("Send the request body as JSON.");
  }
  try {
    return await request.json();
  } catch {
    throw badRequest("The request body isn't valid JSON.");
  }
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/session$/,
    handler: async ({ user }) => json(user),
  },
  {
    method: "GET",
    pattern: /^\/api\/agreements$/,
    handler: async ({ db }) => json(await listAgreements(db)),
  },
  {
    method: "POST",
    pattern: /^\/api\/agreements$/,
    handler: async ({ db, user, request }) =>
      json(await submitAgreement(db, user.id, parseNewAgreement(await readJson(request))), 201),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/agreements/${ID}$`),
    handler: async ({ db, params }) => json(await getAgreement(db, params[0]!)),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/agreements/${ID}/complete$`),
    handler: async ({ db, user, params }) => json(await completeReview(db, user.id, params[0]!)),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/agreements/${ID}/findings$`),
    handler: async ({ db, user, params, request }) =>
      json(await addManualFinding(db, user.id, params[0]!, parseManualFinding(await readJson(request))), 201),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/findings/${ID}$`),
    handler: async ({ db, user, params, request }) =>
      json(await decideFinding(db, user.id, params[0]!, parseDecision(await readJson(request)))),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/agreements/${ID}/documents$`),
    handler: async ({ db, user, params, request, documents }) => {
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw badRequest("Upload the file as multipart form data.");
      }
      const file = form.get("file");
      if (!(file instanceof File)) throw badRequest("Attach the document in a field named \"file\".");
      const record = await uploadDocument(db, documents, user.id, params[0]!, {
        name: file.name,
        type: file.type,
        data: await file.arrayBuffer(),
      });
      return json(record, 201);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/documents/${ID}$`),
    handler: async ({ db, params, documents }) => {
      const download = await downloadDocument(db, documents, params[0]!);
      return new Response(download.data, {
        headers: {
          "Content-Type": download.contentType,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/reports\/categories$/,
    handler: async ({ db }) => json(await categoryReport(db)),
  },
  {
    method: "GET",
    pattern: /^\/api\/users$/,
    handler: async ({ db }) => json(await listUsers(db)),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/users/${ID}/access$`),
    handler: async ({ db, user, params, request }) =>
      json(await updateUserAccess(db, user.id, params[0]!, parseUserAccess(await readJson(request)))),
  },
];

/** Requests that change data must come from this site, not a page elsewhere riding the cookie. */
function checkSameOrigin(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw forbidden("Cross-site requests are not allowed.");
}

function errorResponse(error: ApiError): Response {
  const body: ApiErrorBody = { error: error.message };
  return json(body, error.status);
}

export function createApiHandler(deps: ApiDependencies) {
  return async function handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      const matches = routes.filter((route) => route.pattern.test(path));
      if (matches.length === 0) throw notFound("That API route");
      const route = matches.find((candidate) => candidate.method === request.method);
      if (!route) {
        return new Response(null, { status: 405, headers: { Allow: matches.map((m) => m.method).join(", ") } });
      }

      checkSameOrigin(request);

      const identity = await deps.authenticate(request);
      if (!identity) throw unauthorized();

      const userId = await resolveAccountId(deps.database, identity, deps.bootstrapAdmins);
      if (!userId) throw forbidden("Your ClausePilot account has been deactivated. Ask an administrator for access.");

      const params = route.pattern.exec(path)!.slice(1);
      return await deps.database.withUser(userId, async (db) => {
        const user = await loadSessionUser(db, userId);
        return route.handler({ request, params, user, db, documents: deps.documents });
      });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.status >= 500) console.error("API request failed", error);
      return errorResponse(apiError);
    }
  };
}
