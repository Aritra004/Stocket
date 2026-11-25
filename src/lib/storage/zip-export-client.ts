import { assertArchiveExportEnabled } from "../export-access";
import type { ExportProgress } from "./zip-export";

export interface ArchiveZipResult { blob: Blob; fileName: string }
export interface ArchiveZipOptions { signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void }

/** All compression and rendering stays off the UI thread. No synchronous fallback. */
export async function startArchiveZipExport({ signal, onProgress }: ArchiveZipOptions = {}): Promise<ArchiveZipResult> {
  if (typeof window === "undefined") throw new Error("Offline ZIP export can only run in your browser.");
  signal?.throwIfAborted();
  await assertArchiveExportEnabled(signal);
  if (typeof Worker === "undefined") throw new Error("This browser cannot start background ZIP processing. Enable web workers or use a current browser, then retry.");
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let started = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker?.terminate();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("Archive export cancelled.", "AbortError"));
    const failure = () => fail(new Error(started
      ? "Background ZIP processing stopped unexpectedly. The browser may have run out of memory. Close other tabs, reload, and retry on a device with more memory. Your saved imports have not been changed."
      : "The background ZIP worker could not start. Reload and check that your browser allows web workers. No export was created."));
    const armTimeout = (milliseconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(started
        ? "ZIP processing stopped responding, possibly because browser memory or storage is unavailable. Close other tabs, check free device space, reload, and retry. Your saved imports have not been changed."
        : "The background ZIP worker did not start. Reload and check browser permissions, then retry.")), milliseconds);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      worker = new Worker(new URL("./zip-export.worker.ts", import.meta.url), { type: "module" });
      worker.onerror = failure;
      worker.onmessageerror = failure;
      worker.onmessage = (event: MessageEvent<
        { type: "ready" | "heartbeat" } | { type: "progress"; value: ExportProgress } |
        { type: "result"; value: ArchiveZipResult } | { type: "error"; message: string }
      >) => {
        if (settled) return;
        const message = event.data;
        if (message.type === "ready" && !started) {
          started = true;
          armTimeout(120_000);
          try { worker!.postMessage({ type: "export" }); } catch { failure(); }
        } else if (message.type === "heartbeat" || message.type === "progress") {
          if (!started) return;
          armTimeout(120_000);
          if (message.type === "progress") onProgress?.(message.value);
        } else if (message.type === "error") {
          fail(new Error(message.message));
        } else if (message.type === "result" && started) {
          settled = true;
          cleanup();
          resolve(message.value);
        }
      };
      armTimeout(10_000);
      if (signal?.aborted) abort();
    } catch { failure(); }
  });
}
