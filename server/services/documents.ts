/**
 * Uploading and downloading agreement documents.
 *
 * The metadata row is written first, inside the caller's row-level security
 * scope, so the database decides whether this person may attach a file to
 * this agreement before any bytes are stored. If storing the bytes then fails,
 * the error rolls the row back with the rest of the transaction.
 */

import { createHash, randomUUID } from "node:crypto";

import { LIMITS, type DocumentRecord } from "../../src/shared/api.ts";
import { isUuid, type Queryable } from "../db.ts";
import { documentKey, type DocumentStore } from "../documentStore.ts";
import { badRequest, notFound } from "../errors.ts";
import { recordAudit } from "./audit.ts";

export interface UploadedFile {
  name: string;
  type: string;
  data: ArrayBuffer;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Works out the stored content type from the bytes, not just the name or the browser's claim. */
export function detectContentType(file: UploadedFile): DocumentRecord["contentType"] {
  const bytes = new Uint8Array(file.data);
  if (bytes.length === 0) throw badRequest("The file is empty.");
  if (bytes.length > LIMITS.documentBytes) throw badRequest("Files must be 25 MB or smaller.");

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".pdf") || file.type === "application/pdf") {
    if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) throw badRequest("That file isn't a valid PDF.");
    return "application/pdf";
  }
  if (lowerName.endsWith(".txt") || file.type === "text/plain") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw badRequest("Text files must be UTF-8.");
    }
    return "text/plain";
  }
  throw badRequest("Only PDF and TXT files can be uploaded.");
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // Drop control characters and quotes, which have no place in a download name.
  const cleaned = [...base].filter((ch) => ch !== '"' && ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f).join("").trim().slice(0, 200);
  return cleaned || "agreement";
}

export async function uploadDocument(
  db: Queryable,
  store: DocumentStore,
  userId: string,
  agreementId: string,
  file: UploadedFile,
): Promise<DocumentRecord> {
  if (!isUuid(agreementId)) throw notFound("That agreement");
  const visible = await db.query("SELECT 1 FROM agreements WHERE id = $1", [agreementId]);
  if (!visible.rowCount) throw notFound("That agreement");

  const contentType = detectContentType(file);
  const id = randomUUID();
  const key = documentKey(agreementId, id);
  const fileName = safeFileName(file.name);
  const sha256 = createHash("sha256").update(new Uint8Array(file.data)).digest("hex");

  const { rows } = await db.query<{ uploaded_at: Date }>(
    `INSERT INTO agreement_documents (id, agreement_id, blob_key, file_name, content_type, byte_size, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING uploaded_at`,
    [id, agreementId, key, fileName, contentType, file.data.byteLength, sha256, userId],
  );

  await store.put(key, file.data, { agreementId, contentType, sha256 });
  try {
    await recordAudit(db, userId, agreementId, "document.uploaded", { documentId: id, fileName });
  } catch (error) {
    // The row will roll back, so don't leave its bytes behind.
    await store.delete(key).catch(() => undefined);
    throw error;
  }

  return { id, fileName, contentType, byteSize: file.data.byteLength, uploadedAt: rows[0]!.uploaded_at.toISOString() };
}

export interface DocumentDownload {
  fileName: string;
  contentType: DocumentRecord["contentType"];
  data: ArrayBuffer;
}

export async function downloadDocument(db: Queryable, store: DocumentStore, documentId: string): Promise<DocumentDownload> {
  if (!isUuid(documentId)) throw notFound("That document");
  const { rows } = await db.query<{ blob_key: string; file_name: string; content_type: DocumentRecord["contentType"] }>(
    "SELECT blob_key, file_name, content_type FROM agreement_documents WHERE id = $1",
    [documentId],
  );
  const row = rows[0];
  if (!row) throw notFound("That document");

  const stored = await store.get(row.blob_key);
  if (!stored) throw notFound("That document's file");
  return { fileName: row.file_name, contentType: row.content_type, data: stored.data };
}
