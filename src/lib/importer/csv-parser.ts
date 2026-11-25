import { parseFileContents } from "./csv-parser-core";
import type { CsvImportResult, CsvWorkerRequest, CsvWorkerResponse } from "./types";
import { addIssue, finalizeResult, unexpectedFailureResult, validateFile } from "./validators";

/** A failed/blocked worker returns null so the same local file can be retried. */
function parseInWorker(file: File): Promise<CsvImportResult | null> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: CsvImportResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      try { worker?.terminate(); } catch { /* A failed worker must not block settlement. */ }
      resolve(result);
    };

    try {
      worker = new Worker(new URL("./csv-parser.worker.ts", import.meta.url), { type: "module" });
      // Limit worker startup only. Large files have no arbitrary parsing timeout.
      readyTimer = setTimeout(() => finish(null), 10_000);
      worker.onerror = (event) => {
        event.preventDefault();
        finish(null);
      };
      worker.onmessageerror = () => finish(null);
      worker.onmessage = ({ data }: MessageEvent<CsvWorkerResponse>) => {
        if (!data || data.type === "failed") {
          finish(null);
        } else if (data.type === "ready") {
          clearTimeout(readyTimer);
          try {
            worker?.postMessage({ type: "parse", file } satisfies CsvWorkerRequest);
          } catch {
            finish(null);
          }
        } else if (data.type === "result") {
          finish(data.result);
        }
      };
    } catch {
      finish(null);
    }
  });
}

/** Call from a browser event handler. No upload, fetch, server action, or persistence. */
export async function parseCsvFile(file: File): Promise<CsvImportResult> {
  try {
    return await parseBrowserFile(file);
  } catch {
    return unexpectedFailureResult(file);
  }
}

async function parseBrowserFile(file: File): Promise<CsvImportResult> {
  const preflight = validateFile(file);
  if (preflight.errorCount) return preflight;

  if (typeof window === "undefined") {
    addIssue(preflight, { severity: "error", category: "environment", code: "BrowserRequired", message: "Open this app in a browser to import files locally." });
    return finalizeResult(preflight);
  }

  if (typeof Worker !== "undefined") {
    const result = await parseInWorker(file);
    if (result) return result;
  }

  const result = await parseFileContents(file);
  addIssue(result, { severity: "warning", category: "environment", code: "WorkerUnavailable", message: "Background processing is unavailable. The file was still read on your device, with short pauses to keep the page responsive." });
  return finalizeResult(result);
}

/** Sequential files bound memory use and preserve selection order, even on failures. */
export async function parseCsvFiles(
  files: Iterable<File> | ArrayLike<File>,
  onResult?: (result: CsvImportResult, index: number) => void,
): Promise<CsvImportResult[]> {
  const results: CsvImportResult[] = [];
  for (const file of Array.from(files)) {
    const result = await parseCsvFile(file);
    results.push(result);
    onResult?.(result, results.length - 1);
  }
  return results;
}
