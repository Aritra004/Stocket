import type { CsvImportResult } from "../importer/types";
import type { StoredImport, StoredValidationIssue } from "./types";
import type { ArchiveRequest, ArchiveResponse, LocalImportReview, SavedImportResult } from "./archive-operations";

async function localFallback(request: ArchiveRequest): Promise<ArchiveResponse> {
  const { executeArchiveRequest, storageErrorMessage } = await import("./archive-operations");
  // Let a pending loading indicator paint before entering the fallback.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    return await executeArchiveRequest(request);
  } catch (error) {
    throw new Error(storageErrorMessage(error));
  }
}

/** Lazy access: no browser database is created during Next.js server rendering. */
export async function archiveRequest(request: ArchiveRequest): Promise<ArchiveResponse> {
  if (typeof window === "undefined") throw new Error("The local archive can only be opened in your browser.");
  if (typeof Worker === "undefined") return localFallback(request);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    let started = false;
    let settled = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (startupTimer) clearTimeout(startupTimer);
      worker?.terminate();
    };
    const startupFailure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (started) {
        // Do not retry a write whose commit status is uncertain.
        reject(new Error("The local storage worker stopped unexpectedly. Refresh the archive to check whether the operation completed before trying again."));
      } else {
        localFallback(request).then(resolve, reject);
      }
    };
    try {
      worker = new Worker(new URL("./archive.worker.ts", import.meta.url), { type: "module" });
      worker.onerror = startupFailure;
      worker.onmessageerror = startupFailure;
      worker.onmessage = (event: MessageEvent<{ type: "ready" } | { type: "result"; value: ArchiveResponse } | { type: "error"; message: string }>) => {
        if (settled) return;
        if (event.data.type === "ready") {
          if (started) return;
          if (startupTimer) clearTimeout(startupTimer);
          started = true;
          try { worker.postMessage(request); } catch { startupFailure(); }
        } else if (event.data.type === "result") {
          settled = true;
          cleanup();
          resolve(event.data.value);
        } else if (event.data.type === "error") {
          settled = true;
          cleanup();
          reject(new Error(event.data.message));
        }
      };
      startupTimer = setTimeout(startupFailure, 5000);
    } catch {
      startupFailure();
    }
  });
}

export async function listLocalImports(): Promise<StoredImport[]> {
  return await archiveRequest({ operation: "list" }) as StoredImport[];
}
export async function loadLocalImport(id: string): Promise<CsvImportResult | undefined> {
  return await archiveRequest({ operation: "load", id }) as CsvImportResult | undefined;
}
export async function loadLocalReview(id: string): Promise<LocalImportReview | undefined> {
  return await archiveRequest({ operation: "review", id }) as LocalImportReview | undefined;
}
export async function getLocalImportIssues(id: string): Promise<StoredValidationIssue[]> {
  return await archiveRequest({ operation: "issues", id }) as StoredValidationIssue[];
}
export async function importAndSaveFile(file: File, replaceId?: string, expectedHash?: string): Promise<SavedImportResult> {
  return await archiveRequest({ operation: "import", file, replaceId, expectedHash }) as SavedImportResult;
}
export async function removeLocalImport(id: string, expectedHash?: string): Promise<void> {
  await archiveRequest({ operation: "remove", id, expectedHash });
}
export async function clearLocalArchive(): Promise<void> {
  await archiveRequest({ operation: "clear" });
}
