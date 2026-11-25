import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { archiveRequest } from "./archive-client";
import { executeArchiveRequest, type ArchiveRequest } from "./archive-operations";
import { createArchiveDatabase } from "./database";
import { hashFile } from "./hash";

const contents = "__stocky_rescue_po_summary_v1,PO Number,Supplier\nprovisional,PO-1,Original Supplier\n";

test("SHA-256 fingerprints exact file bytes independently of name and metadata", async () => {
  assert.equal(await hashFile(new Blob(["abc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const first = await hashFile(new File([contents], "one.csv", { lastModified: 1 }));
  assert.equal(first, await hashFile(new File([contents], "renamed.csv", { lastModified: 99 })));
  assert.notEqual(first, await hashFile(new File(["\uFEFF", contents], "one.csv")));
  assert.notEqual(first, await hashFile(new File([contents.replaceAll("\n", "\r\n")], "one.csv")));
});

test("local operations skip exact duplicates and preserve the old import after invalid replacement", async () => {
  const name = `operations-${crypto.randomUUID()}`;
  const db = createArchiveDatabase(name);
  try {
    const saved = await executeArchiveRequest({ operation: "import", file: new File([contents], "one.csv") }, name);
    assert.ok(saved && "kind" in saved && saved.kind === "saved");
    const duplicate = await executeArchiveRequest({ operation: "import", file: new File([contents], "renamed.csv") }, name);
    assert.ok(duplicate && "kind" in duplicate && duplicate.kind === "duplicate");
    assert.equal(duplicate.file.id, saved.file.id);
    await assert.rejects(executeArchiveRequest({ operation: "import", file: new File(['a,b\n"broken'], "bad.csv"), replaceId: saved.file.id }, name), /replacement CSV could not be read/);
    assert.equal(await db.importedFiles.count(), 1);
    const result = await executeArchiveRequest({ operation: "load", id: saved.file.id }, name);
    assert.ok(result && "normalized" in result);
    assert.equal(result.normalized.records[0].fields.supplier.value, "Original Supplier");
    const review = await executeArchiveRequest({ operation: "review", id: saved.file.id }, name);
    assert.ok(review && "issues" in review && "file" in review);
    assert.equal(review.file.sha256, saved.file.sha256);
    assert.deepEqual(review.result, result);
    assert.ok(review.issues.some((item) => item.issue.code === "ProvisionalStockySchema"));
    await executeArchiveRequest({ operation: "clear" }, name);
    assert.equal(await db.importedFiles.count(), 0);
  } finally { await db.delete(); }
});

async function withBrowser(run: () => Promise<void>, worker?: unknown) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: worker });
  try { await run(); } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
}

test("public archive API rejects server-side invocation before reading any file bytes", async () => {
  const file = new File([contents], "private.csv");
  Object.defineProperty(file, "arrayBuffer", { value: () => assert.fail("Server must not read local purchasing data") });
  await assert.rejects(archiveRequest({ operation: "import", file }), /only be opened in your browser/);
});

test("a blocked worker falls back to real local IndexedDB", async () => {
  await withBrowser(async () => {
    const db = createArchiveDatabase();
    try { assert.deepEqual(await archiveRequest({ operation: "list" }), []); }
    finally { await db.delete(); }
  }, class BlockedWorker { constructor() { throw new Error("Worker blocked"); } });
});

test("worker requests start after readiness and terminate after their result", async () => {
  let terminated = false;
  let sent = 0;
  class SuccessfulWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage(request: ArchiveRequest) {
      sent += 1;
      assert.equal(request.operation, "list");
      queueMicrotask(() => this.onmessage?.({ data: { type: "result", value: [] } } as MessageEvent));
    }
    terminate() { terminated = true; }
  }
  await withBrowser(async () => assert.deepEqual(await archiveRequest({ operation: "list" }), []), SuccessfulWorker);
  assert.equal(sent, 1);
  assert.equal(terminated, true);
});

test("an interrupted write is not retried after the worker accepted it", async () => {
  let terminated = false;
  let sent = 0;
  class InterruptedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage() { sent += 1; queueMicrotask(() => this.onerror?.()); }
    terminate() { terminated = true; }
  }
  await withBrowser(async () => {
    await assert.rejects(archiveRequest({ operation: "clear" }), /check whether the operation completed/);
  }, InterruptedWorker);
  assert.equal(sent, 1);
  assert.equal(terminated, true);
});
