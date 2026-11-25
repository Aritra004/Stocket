import assert from "node:assert/strict";
import test from "node:test";
import { startArchiveZipExport } from "./zip-export-client";
import { zipExportErrorMessage } from "./zip-export-errors";
import type { ExportProgress } from "./zip-export";

async function browser(run: () => Promise<void>, worker?: unknown, mode = "test") {
  const descriptors = ["window", "Worker"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const priorMode = process.env.NODE_ENV;
  const priorBypass = process.env.NEXT_PUBLIC_EXPORT_TEST_BYPASS;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: worker });
  Reflect.set(process.env, "NODE_ENV", mode);
  Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", "true");
  try { await run(); } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (priorMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", priorMode);
    if (priorBypass === undefined) Reflect.deleteProperty(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS");
    else Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", priorBypass);
  }
}

test("unauthorized production export rejects before constructing a worker", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ status: "none", mode: "live" }));
  await browser(async () => assert.rejects(startArchiveZipExport(), /verified one-time license/), class { constructor() { assert.fail("Unauthorized export must not create a worker"); } }, "production");
});

test("unsupported and blocked workers fail without running ZIP work on the UI thread", async () => {
  await browser(async () => assert.rejects(startArchiveZipExport(), /Enable web workers/));
  await browser(async () => assert.rejects(startArchiveZipExport(), /worker could not start/), class { constructor() { throw new Error("Blocked by CSP"); } });
});

test("the client waits for readiness, forwards progress and releases its worker after a Blob result", async () => {
  const blob = new Blob([new Uint8Array([80, 75, 3, 4])], { type: "application/zip" });
  const progress: ExportProgress = { phase: "zip", completed: 2, total: 4, percent: 50, message: "Packing original CSV files" };
  const seen: ExportProgress[] = [];
  let sent = 0;
  let terminated = 0;
  class SuccessfulWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage(request: unknown) {
      assert.deepEqual(request, { type: "export" });
      sent += 1;
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: "progress", value: progress } } as MessageEvent);
        this.onmessage?.({ data: { type: "result", value: { blob, fileName: "archive.zip" } } } as MessageEvent);
      });
    }
    terminate() { terminated += 1; }
  }
  await browser(async () => {
    const result = await startArchiveZipExport({ onProgress: (value) => seen.push(value) });
    assert.equal(result.blob, blob);
    assert.equal(result.fileName, "archive.zip");
  }, SuccessfulWorker);
  assert.deepEqual(seen, [progress]);
  assert.equal(sent, 1);
  assert.equal(terminated, 1);
});

test("cancellation terminates active work and discards late output", async () => {
  const controller = new AbortController();
  let terminated = 0;
  class CancellableWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage() {
      queueMicrotask(() => {
        controller.abort();
        this.onmessage?.({ data: { type: "result", value: { blob: new Blob(), fileName: "too-late.zip" } } } as MessageEvent);
      });
    }
    terminate() { terminated += 1; }
  }
  await browser(async () => assert.rejects(startArchiveZipExport({ signal: controller.signal }), { name: "AbortError" }), CancellableWorker);
  assert.equal(terminated, 1);
  await browser(async () => assert.rejects(startArchiveZipExport({ signal: controller.signal }), { name: "AbortError" }), class { constructor() { assert.fail("Already cancelled work must not start"); } });
});

test("worker memory failures and validation errors reach the caller without retry", async () => {
  let terminated = 0;
  class FailedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage() { queueMicrotask(() => this.onerror?.()); }
    terminate() { terminated += 1; }
  }
  await browser(async () => assert.rejects(startArchiveZipExport(), /may have run out of memory/), FailedWorker);
  assert.equal(terminated, 1);
  class ValidationWorker extends FailedWorker {
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { type: "error", message: "Original CSV bytes are unavailable. Reimport the file." } } as MessageEvent)); }
  }
  await browser(async () => assert.rejects(startArchiveZipExport(), /Reimport the file/), ValidationWorker);
  assert.equal(terminated, 2);
});

test("resource errors explain memory and browser storage recovery", () => {
  assert.match(zipExportErrorMessage(new RangeError("Invalid array length")), /not enough browser memory/);
  assert.match(zipExportErrorMessage(new Error("Array buffer allocation failed")), /not enough browser memory/);
  assert.match(zipExportErrorMessage(new DOMException("Full", "QuotaExceededError")), /Free device space/);
  assert.match(zipExportErrorMessage(new DOMException("Blocked", "SecurityError")), /storage permissions/);
  assert.equal(zipExportErrorMessage(new Error("Original bytes failed checksum.")), "Original bytes failed checksum.");
});
