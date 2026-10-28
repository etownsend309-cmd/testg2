/**
 * Typed client for the ClausePilot API (netlify/functions/api.mts).
 *
 * The browser's Netlify Identity session travels in the `nf_jwt` cookie, so
 * same-origin requests are authenticated without handling the token here.
 */

import type {
  AgreementDetail,
  AgreementSummary,
  ApiErrorBody,
  CategoryReport,
  DocumentRecord,
  FindingDecisionInput,
  ManagedUser,
  ManualFindingInput,
  NewAgreementInput,
  SessionUser,
  UserAccessInput,
} from "../shared/api";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiRequestError(0, "Couldn't reach ClausePilot. Check your connection and try again.");
  }

  if (!response.ok) {
    let message = `The request failed (${response.status}).`;
    try {
      const body = (await response.json()) as Partial<ApiErrorBody>;
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON (for example a platform error page); keep the generic message.
    }
    throw new ApiRequestError(response.status, message);
  }
  return (await response.json()) as T;
}

const sendJson = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  getSession: () => request<SessionUser>("/api/session"),

  listAgreements: () => request<AgreementSummary[]>("/api/agreements"),
  getAgreement: (id: string) => request<AgreementDetail>(`/api/agreements/${encodeURIComponent(id)}`),
  submitAgreement: (input: NewAgreementInput) => request<AgreementDetail>("/api/agreements", sendJson("POST", input)),
  completeReview: (id: string) =>
    request<AgreementDetail>(`/api/agreements/${encodeURIComponent(id)}/complete`, { method: "POST" }),

  decideFinding: (findingId: string, input: FindingDecisionInput) =>
    request<AgreementDetail>(`/api/findings/${encodeURIComponent(findingId)}`, sendJson("PATCH", input)),
  addManualFinding: (agreementId: string, input: ManualFindingInput) =>
    request<AgreementDetail>(`/api/agreements/${encodeURIComponent(agreementId)}/findings`, sendJson("POST", input)),

  uploadDocument: (agreementId: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<DocumentRecord>(`/api/agreements/${encodeURIComponent(agreementId)}/documents`, {
      method: "POST",
      body: form,
    });
  },
  /** A URL the browser can open to download the file; access is checked when it is requested. */
  documentUrl: (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}`,

  categoryReport: () => request<CategoryReport>("/api/reports/categories"),

  listUsers: () => request<ManagedUser[]>("/api/users"),
  updateUserAccess: (userId: string, input: UserAccessInput) =>
    request<ManagedUser>(`/api/users/${encodeURIComponent(userId)}/access`, sendJson("PUT", input)),
};
