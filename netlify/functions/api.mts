/**
 * ClausePilot API: every route under /api.
 *
 * The routing, authentication and data access live in server/; this file only
 * wires them to Netlify's database, Blobs store and Identity service.
 */

import type { Config } from "@netlify/functions";

import { createApiHandler } from "../../server/api.ts";
import { getDefaultDatabase } from "../../server/db.ts";
import { createNetlifyDocumentStore } from "../../server/documentStore.ts";
import { netlifyIdentityAuthenticate, parseBootstrapAdmins } from "../../server/session.ts";

let handler: ((request: Request) => Promise<Response>) | undefined;

export default async (request: Request) => {
  handler ??= createApiHandler({
    database: await getDefaultDatabase(),
    documents: await createNetlifyDocumentStore(),
    authenticate: netlifyIdentityAuthenticate,
    bootstrapAdmins: parseBootstrapAdmins(process.env.BOOTSTRAP_ADMIN_EMAILS),
  });
  return handler(request);
};

export const config: Config = {
  path: "/api/*",
};
