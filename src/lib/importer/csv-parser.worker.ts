import { parseFileContents } from "./csv-parser-core";
import type { CsvWorkerRequest, CsvWorkerResponse } from "./types";

// Keep DOM and WebWorker lib declarations from conflicting in the Next.js project.
const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CsvWorkerRequest>) => void;
  postMessage: (message: CsvWorkerResponse) => void;
};

workerScope.onmessage = async ({ data }) => {
  if (data.type !== "parse") return;
  try {
    const result = await parseFileContents(data.file, "worker");
    workerScope.postMessage({ type: "result", result });
  } catch {
    // An async rejection does not reliably fire Worker.onerror in the parent.
    // Explicitly settle this request so the parent can retry locally.
    workerScope.postMessage({ type: "failed" });
  }
};

workerScope.postMessage({ type: "ready" });
