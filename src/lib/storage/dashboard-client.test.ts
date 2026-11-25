import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { dashboardRequest } from "./dashboard-client";
import { createArchiveDatabase } from "./database";
import { executeArchiveRequest } from "./archive-operations";

async function browser(run: () => Promise<void>, worker?: unknown) {
  const prior = ["window", "Worker"].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: worker });
  try { await run(); } finally {
    ["window", "Worker"].forEach((key, i) => {
      if (prior[i]) Object.defineProperty(globalThis, key, prior[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test("dashboard cannot open browser data during server rendering", async () => {
  await assert.rejects(dashboardRequest({ operation: "overview" }), /only in your browser/);
});

test("dashboard uses real IndexedDB when a worker is blocked", async () => {
  await browser(async () => {
    const db = createArchiveDatabase();
    try {
      assert.deepEqual(await dashboardRequest({ operation: "overview" }), { totalOrders: 0, observedSuppliers: 0, uniqueSkus: 0, importCount: 0, lineItemCount: 0 });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(dashboardRequest({ operation: "overview" }, controller.signal), { name: "AbortError" });
    } finally { await db.delete(); }
  }, class { constructor() { throw new Error("Blocked worker"); } });
});

test("obsolete dashboard queries terminate workers and ignore late responses", async () => {
  let terminated = 0;
  let sent = 0;
  let respond: (() => void) | undefined;
  class PendingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage() {
      sent += 1;
      respond = () => this.onmessage?.({ data: { type: "result", value: [] } } as MessageEvent);
    }
    terminate() { terminated += 1; }
  }
  await browser(async () => {
    const controller = new AbortController();
    const request = dashboardRequest({ operation: "orders", query: { search: "old" } }, controller.signal);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    controller.abort();
    respond?.();
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(sent, 1);
    assert.equal(terminated, 1);
  }, PendingWorker);
});

test("dashboard surfaces worker read errors and releases the worker", async () => {
  let terminated = false;
  class ErrorWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { type: "error", message: "Read failed" } } as MessageEvent)); }
    terminate() { terminated = true; }
  }
  await browser(async () => { await assert.rejects(dashboardRequest({ operation: "overview" }), /Read failed/); }, ErrorWorker);
  assert.equal(terminated, true);
});

test("history requests reach the saved IndexedDB records through the browser fallback", async () => {
  const priorMode = process.env.NODE_ENV;
  const priorBypass = process.env.NEXT_PUBLIC_EXPORT_TEST_BYPASS;
  Reflect.set(process.env, "NODE_ENV", "test");
  Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", "true");
  try {
  await browser(async () => {
    const db = createArchiveDatabase();
    try {
      await executeArchiveRequest({ operation: "import", file: new File([
        "__stocky_rescue_po_summary_v1,PO Number,Supplier\nprovisional,PO-1,Acme\n",
      ], "dispatch-summary.csv") });
      await executeArchiveRequest({ operation: "import", file: new File([
        "__stocky_rescue_po_line_item_v1,PO Number,Line ID,SKU,Supplier\nprovisional,PO-1,L1,001,Acme\n",
      ], "dispatch-lines.csv") });
      const suppliers = await dashboardRequest({ operation: "supplier-directory", query: {} });
      assert.deepEqual(suppliers.rows, [{ name: "Acme", orderCount: 1, lineCount: 1 }]);
      assert.deepEqual((await dashboardRequest({ operation: "sku-directory", query: {} })).rows, [{ sku: "001", lineCount: 1 }]);
      const supplier = await dashboardRequest({ operation: "supplier-history", supplier: "Acme", orderPageIndex: 0, linePageIndex: 0 });
      assert.equal(supplier.orders.total, 1);
      assert.equal(supplier.lines.total, 1);
      const sku = await dashboardRequest({ operation: "sku-history", sku: "001", pageIndex: 0 });
      assert.equal(sku.lines.rows[0].record.fields.sku.value, "001");
      assert.equal(sku.lines.rows[0].record.fields.unitCost.state, "missing");
      const costs = await dashboardRequest({ operation: "sku-cost-history", sku: "001", pageIndex: 0 });
      assert.equal(costs.entries.rows[0].record.fields.unitCost.state, "missing");
      const quality = await dashboardRequest({ operation: "data-quality" });
      assert.equal(quality.totals.fileCount, 2);
      assert.equal(quality.totals.analyzedRecords, 2);
      assert.equal(quality.totals.categoryRecordCounts.incomplete, 2);
      assert.ok(quality.sources.some((source) => source.fileName === "dispatch-lines.csv"));
      const archive = await dashboardRequest({ operation: "offline-archive" });
      assert.equal(archive.version, 1);
      assert.equal(archive.records.length, 2);
      assert.equal(archive.sources.length, 2);
      assert.equal(archive.records.find((record) => record.kind === "purchase-order-line-item")?.fields.sku.value, "001");
      const candidates = await dashboardRequest({ operation: "order-candidates", orderNumber: "PO-1", pageIndex: 0 });
      assert.equal(candidates.rows[0].fileName, "dispatch-summary.csv");
      assert.equal((await dashboardRequest({ operation: "order-candidates", orderNumber: "PO", pageIndex: 0 })).total, 0);
    } finally { await db.delete(); }
  });
  } finally {
    if (priorMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", priorMode);
    if (priorBypass === undefined) Reflect.deleteProperty(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS");
    else Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", priorBypass);
  }
});
