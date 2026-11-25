/// <reference lib="webworker" />

import { createArchiveDatabase } from "./database";
import { exportErrorMessage, generateArchiveZip } from "./zip-export";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let active = false;
worker.onmessage = async (event: MessageEvent<{ type: string }>) => {
  if (event.data.type !== "export" || active) return;
  active = true;
  let db: ReturnType<typeof createArchiveDatabase> | undefined;
  const heartbeat = setInterval(() => worker.postMessage({ type: "heartbeat" }), 2000);
  try {
    db = createArchiveDatabase();
    // The generator verifies the session entitlement before reading archive data.
    const value = await generateArchiveZip(db, (progress) => worker.postMessage({ type: "progress", value: progress }));
    worker.postMessage({ type: "result", value });
  } catch (error) {
    worker.postMessage({ type: "error", message: exportErrorMessage(error) });
  } finally {
    clearInterval(heartbeat);
    db?.close();
  }
};
worker.postMessage({ type: "ready" });
