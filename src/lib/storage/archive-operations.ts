import { parseFileContents } from "../importer/csv-parser-core";
import type { CsvImportResult } from "../importer/types";
import { createArchiveDatabase, type ArchiveDatabase } from "./database";
import { hashFile } from "./hash";
import { clearArchive, findImportByHash, getImportResult, listImportIssues, listImports, removeImport, saveImport } from "./repository";
import type { StoredImport, StoredValidationIssue } from "./types";

export type ArchiveRequest =
  | { operation: "list" }
  | { operation: "load"; id: string }
  | { operation: "review"; id: string }
  | { operation: "issues"; id: string }
  | { operation: "import"; file: File; replaceId?: string; expectedHash?: string }
  | { operation: "remove"; id: string; expectedHash?: string }
  | { operation: "clear" };

export interface SavedImportResult {
  kind: "saved" | "duplicate";
  file: StoredImport;
  result: CsvImportResult;
}

export interface LocalImportReview {
  file: StoredImport;
  result: CsvImportResult;
  issues: StoredValidationIssue[];
}

export interface ArchiveResponses {
  list: StoredImport[];
  load: CsvImportResult | undefined;
  review: LocalImportReview | undefined;
  issues: StoredValidationIssue[];
  import: SavedImportResult;
  remove: undefined;
  clear: undefined;
}

export type ArchiveResponse = ArchiveResponses[keyof ArchiveResponses];

async function duplicateSnapshot(db: ArchiveDatabase, sha256: string, verifiedOriginal: Blob): Promise<SavedImportResult | undefined> {
  return db.transaction("rw", db.importedFiles, db.importPayloads, db.originalFiles, async () => {
    const file = await findImportByHash(db, sha256);
    if (!file) return undefined;
    const result = await getImportResult(db, file.id);
    if (!result) throw new Error("The saved review is unavailable. Refresh the archive before trying again.");
    if (verifiedOriginal.size !== file.fileSize) throw new Error("The saved import's file size does not match its original CSV. No changes were saved.");
    // Reselecting matching bytes also repairs a truncated/corrupt preserved Blob.
    // Identity, metadata and normalized evidence remain unchanged.
    await db.originalFiles.put({ importId: file.id, blob: verifiedOriginal });
    return { kind: "duplicate", file, result };
  });
}

/** No server calls. Shared by a dedicated browser worker and its local fallback. */
export async function executeArchiveRequest(request: ArchiveRequest, databaseName?: string): Promise<ArchiveResponse> {
  const db = createArchiveDatabase(databaseName);
  try {
    switch (request.operation) {
      case "list": return await listImports(db);
      case "load": return await getImportResult(db, request.id);
      case "review": return await db.transaction("r", db.importedFiles, db.importPayloads, db.validationIssues, async () => {
        const file = await db.importedFiles.get(request.id);
        const result = await getImportResult(db, request.id);
        if (!file || !result) return undefined;
        return { file, result, issues: await listImportIssues(db, request.id) };
      });
      case "issues": return await listImportIssues(db, request.id);
      case "remove": await removeImport(db, request.id, request.expectedHash); return undefined;
      case "clear": await clearArchive(db); return undefined;
      case "import": {
        // Hashing and parsing happen before the write transaction. No hashing,
        // timers or unrelated promises can close an IndexedDB transaction early.
        const sha256 = await hashFile(request.file);
        const existing = await duplicateSnapshot(db, sha256, request.file);
        if (existing) return existing;
        const result = await parseFileContents(request.file, typeof window === "undefined" ? "worker" : "main-thread");
        if (request.replaceId && (result.status === "error" || result.status === "unsupported")) {
          throw new Error("The replacement CSV could not be read reliably. The saved import has not been changed. Import the new file separately to review its errors.");
        }
        const saved = await saveImport(db, {
          file: { name: request.file.name, size: request.file.size, type: request.file.type, lastModified: request.file.lastModified },
          sha256, result, originalFile: request.file, replaceId: request.replaceId, expectedHash: request.expectedHash,
        });
        // Another tab can have committed the same hash while this file parsed.
        if (saved.kind === "duplicate") {
          const duplicate = await duplicateSnapshot(db, sha256, request.file);
          if (!duplicate) throw new Error("The matching import was changed in another tab. Refresh the archive before trying again.");
          return duplicate;
        }
        return { ...saved, result };
      }
    }
  } finally {
    db.close();
  }
}

export function storageErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (/QuotaExceeded/i.test(name)) return "This browser has no storage space available. Nothing from this save was committed. Remove an old import or free space, then try again.";
  if (/MissingAPI|Security|InvalidState|DatabaseClosed/i.test(name)) return "Local browser storage is unavailable or blocked. Your file can still be reviewed for this session, but it has not been saved.";
  if (error instanceof Error && name === "Error") return error.message;
  return "The local archive could not complete this operation. Refresh its list to check the saved imports, then try again.";
}
