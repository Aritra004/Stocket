/// <reference lib="webworker" />

import { executeArchiveRequest, storageErrorMessage, type ArchiveRequest } from "./archive-operations";

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<ArchiveRequest>) => {
  try {
    worker.postMessage({ type: "result", value: await executeArchiveRequest(event.data) });
  } catch (error) {
    worker.postMessage({ type: "error", message: storageErrorMessage(error) });
  }
};
// The client sends work only after this handshake. A failed startup can safely
// fall back without retrying an operation that may already have committed.
worker.postMessage({ type: "ready" });
