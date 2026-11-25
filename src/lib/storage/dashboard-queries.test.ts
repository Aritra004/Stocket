import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase, VERSION_2_STORES } from "./database";
import { queryOrderDetail, queryOrders, queryOverview, querySourceReference, querySuppliers } from "./dashboard-queries";
import { clearArchive, removeImport, saveImport } from "./repository";

const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Status", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"];
const lineHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];
const csv = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
const summary = (po: string, supplier = "Acme", date = "2026-01-15", status = "Open") => ["provisional", po, supplier, status, date, "USD", "12.30", "10", "2"];
const line = (po: string, id: string, sku: string, supplier = "Acme") => ["provisional", po, id, sku, supplier, "2026-01-15", "USD", "1.23", "10", "2"];

async function input(text: string, name = "orders.csv") {
  const file = new File([text], name, { type: "text/csv", lastModified: 1_700_000_000_000 });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) };
}

function database(context: TestContext) {
  const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange };
  const name = `stocky-dashboard-${crypto.randomUUID()}`;
  const db = createArchiveDatabase(name, dependencies);
  context.after(async () => { db.close(); await db.delete(); });
  return { db, dependencies };
}

test("dashboard counts stored summary records and exact observed names/SKUs without merging or filling gaps", async (context) => {
  const { db } = database(context);
  assert.deepEqual(await queryOverview(db), { totalOrders: 0, observedSuppliers: 0, uniqueSkus: 0, importCount: 0, lineItemCount: 0 });
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1"), summary("", ""), summary("PO-2", "acme")])));
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1")]), "overlap.csv"));
  await saveImport(db, await input(csv(lineHeaders, [line("PO-1", "L1", "001"), line("PO-1", "L2", "001"), line("PO-3", "L1", "001 ", "Line supplier"), line("PO-4", "L1", "", "")]), "lines.csv"));
  assert.deepEqual(await queryOverview(db), { totalOrders: 4, observedSuppliers: 3, uniqueSkus: 2, importCount: 3, lineItemCount: 4 });
  const orders = await queryOrders(db, { search: "PO-1" });
  assert.equal(orders.total, 2);
  assert.notEqual(orders.rows[0].record.id, orders.rows[1].record.id);
  assert.deepEqual(new Set(orders.rows.map((row) => row.fileName)), new Set(["orders.csv", "overlap.csv"]));
});

test("PO substring search, exact supplier and inclusive observed date bounds compose", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [
    summary("PO-Alpha", "Acme", "2026-01-01"), summary("PO-Beta", "Acme", "2026-01-31"),
    summary("PO-Later", "Acme", "2026-02-01"), summary("PO-Other", "acme", "2026-01-15"),
    summary("PO-Missing", "Acme", ""), summary("PO-Invalid", "Acme", "01/15/2026"),
  ])));
  const page = await queryOrders(db, { search: "po-", supplier: "Acme", dateFrom: "2026-01-01", dateTo: "2026-01-31", sortBy: "orderDate", sortDirection: "desc" });
  assert.deepEqual(page.rows.map(({ record }) => record.fields.purchaseOrderNumber.value), ["PO-Beta", "PO-Alpha"]);
  assert.equal(page.total, 2);
  assert.equal((await queryOrders(db, { search: "aLpHa" })).total, 1);
  assert.equal((await queryOrders(db, { dateFrom: "2026-01-31", dateTo: "2026-01-31" })).total, 1);
  assert.equal((await queryOrders(db, { supplier: "ACME" })).total, 0);
  await assert.rejects(queryOrders(db, { dateFrom: "2026-02-30" }), /valid order date/);
  await assert.rejects(queryOrders(db, { dateFrom: "2026-02-01", dateTo: "2026-01-01" }), /start date/);
});

test("all supported sorts are stable, preserve repeated IDs and put unavailable values last both directions", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [
    summary("PO-A", "Alpha", "2026-01-01", "Closed"), summary("PO-B", "Beta", "2026-01-02", "Open"),
    summary("", "", "", ""), summary("PO-B", "Beta", "2026-01-02", "Open"),
  ])));
  for (const sortBy of ["purchaseOrderNumber", "supplier", "orderDate", "status"] as const) {
    for (const sortDirection of ["asc", "desc"] as const) {
      const all = await queryOrders(db, { sortBy, sortDirection });
      assert.equal(all.rows.length, 4);
      assert.equal(all.rows[3].record.fields[sortBy].state, "missing");
      const pages = await Promise.all([0, 1, 2, 3].map((pageIndex) => queryOrders(db, { sortBy, sortDirection, pageIndex, pageSize: 1 })));
      assert.deepEqual(pages.flatMap((page) => page.rows.map((row) => row.record.id)), all.rows.map((row) => row.record.id));
      assert.deepEqual((await queryOrders(db, { sortBy, sortDirection })).rows.map((row) => row.record.id), all.rows.map((row) => row.record.id));
    }
  }
  const last = await queryOrders(db, { pageIndex: 500, pageSize: 2 });
  assert.equal(last.pageIndex, 1);
  assert.equal(last.rows.length, 2);
});

test("conflicting supplier and date fields remain unavailable rather than picking alternatives", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-Conflict", "Alpha", "2026-01-01"), summary("PO-Conflict", "Beta", "2026-01-02"), summary("PO-Observed", "Gamma")] )));
  const overview = await queryOverview(db);
  assert.equal(overview.totalOrders, 3);
  assert.equal(overview.observedSuppliers, 1);
  assert.deepEqual((await querySuppliers(db)).suppliers, ["Gamma"]);
  assert.equal((await queryOrders(db, { supplier: "Alpha" })).total, 0);
  assert.equal((await queryOrders(db, { dateFrom: "2026-01-01" })).total, 1);
  for (const sortDirection of ["asc", "desc"] as const) {
    const page = await queryOrders(db, { sortBy: "supplier", sortDirection });
    assert.equal(page.rows[0].record.fields.supplier.value, "Gamma");
    assert.deepEqual(page.rows.slice(1).map(({ record }) => record.fields.supplier.state), ["conflicting", "conflicting"]);
  }
});

test("detail shows separate candidate lines and exact file/row evidence, never joining missing PO identifiers", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1"), summary("")]), "summary-original.csv"));
  await saveImport(db, await input(csv(lineHeaders, [line("PO-1", "L1", "SKU-1"), line("PO-1", "L2", ""), line("", "L3", "Unlinked")]), "lines-a.csv"));
  await saveImport(db, await input(csv(lineHeaders, [line("PO-1", "L1", "Different")]), "lines-b.csv"));
  const record = (await queryOrders(db, { search: "PO-1" })).rows[0].record;
  const detail = await queryOrderDetail(db, record.id, 0, 2);
  assert.ok(detail);
  assert.equal(detail.order.fileName, "summary-original.csv");
  assert.equal(detail.source?.source.rowNumber, 1);
  assert.equal(detail.source?.recordNumber, 2);
  assert.equal(detail.source?.source.fileName, "summary-original.csv");
  assert.match(detail.source!.source.rawText, /"PO-1"/);
  assert.equal(detail.lineTotal, 3);
  assert.equal(detail.lines.length, 2);
  const next = await queryOrderDetail(db, record.id, 1, 2);
  assert.equal(next?.lines.length, 1);
  const all = [...detail.lines, ...next!.lines];
  assert.deepEqual(new Set(all.map((row) => row.fileName)), new Set(["lines-a.csv", "lines-b.csv"]));
  for (const row of all) {
    const source = await querySourceReference(db, row.record.sourceReferenceId);
    assert.equal(source?.source.fileName, row.fileName);
    assert.equal(source?.dataRowNumber, row.record.rowNumber);
    assert.equal(source?.recordNumber, row.record.recordNumber);
  }
  const missing = (await queryOrders(db)).rows.find(({ record: row }) => row.fields.purchaseOrderNumber.state === "missing")!;
  assert.equal((await queryOrderDetail(db, missing.record.id))?.lineTotal, 0);
  assert.equal(await queryOrderDetail(db, "deleted-record"), undefined);
});

test("large result sets return bounded pages and supplier choices; search can reach beyond the first choices", async (context) => {
  const { db } = database(context);
  const rows = Array.from({ length: 1200 }, (_, index) => summary(`PO-${String(index).padStart(4, "0")}`, `Supplier ${String(index).padStart(4, "0")}`));
  await saveImport(db, await input(csv(summaryHeaders, rows)));
  const page = await queryOrders(db, { sortBy: "purchaseOrderNumber", pageIndex: 30, pageSize: 25 });
  assert.equal(page.total, 1200);
  assert.equal(page.rows.length, 25);
  assert.equal(page.rows[0].record.fields.purchaseOrderNumber.value, "PO-0750");
  assert.equal((await queryOrders(db, { pageSize: 10000 })).rows.length, 100);
  const choices = await querySuppliers(db);
  assert.equal(choices.suppliers.length, 100);
  assert.equal(choices.total, 1200);
  assert.deepEqual((await querySuppliers(db, "Supplier 1199")).suppliers, ["Supplier 1199"]);
  assert.equal((await queryOverview(db)).observedSuppliers, 1200);
});

test("queries reflect replacement, removal and clear without stale aggregate or payload caches", async (context) => {
  const { db } = database(context);
  const saved = await saveImport(db, await input(csv(summaryHeaders, [summary("PO-Old")])));
  assert.equal((await queryOrders(db, { search: "Old" })).total, 1);
  await saveImport(db, { ...await input(csv(summaryHeaders, [summary("PO-New", "New supplier")])), replaceId: saved.file.id, expectedHash: saved.file.sha256 });
  assert.equal((await queryOrders(db, { search: "Old" })).total, 0);
  assert.equal((await queryOrders(db, { search: "New" })).total, 1);
  assert.deepEqual((await querySuppliers(db)).suppliers, ["New supplier"]);
  await removeImport(db, saved.file.id);
  assert.equal((await queryOverview(db)).totalOrders, 0);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-Final")])));
  await clearArchive(db);
  assert.deepEqual(await queryOverview(db), { totalOrders: 0, observedSuppliers: 0, uniqueSkus: 0, importCount: 0, lineItemCount: 0 });
});

test("v2 archives gain dashboard indexes without changing source records or loading canonical payloads", async (context) => {
  const { db, dependencies } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-Existing")])));
  const snapshot = await Promise.all(db.tables.map(async (table) => ({ name: table.name, rows: await table.toArray() })));
  const name = `stocky-dashboard-v2-${crypto.randomUUID()}`;
  const legacy = new Dexie(name, dependencies);
  legacy.version(2).stores(VERSION_2_STORES);
  await legacy.open();
  for (const table of snapshot) if (table.name in VERSION_2_STORES) await legacy.table(table.name).bulkPut(table.rows);
  legacy.close();
  const upgraded = createArchiveDatabase(name, dependencies);
  context.after(async () => { upgraded.close(); await upgraded.delete(); });
  await upgraded.open();
  for (const table of snapshot) assert.deepEqual(await upgraded.table(table.name).toArray(), table.rows);
  // The dashboard relies only on indexed projections and source references.
  await upgraded.importPayloads.clear();
  const page = await queryOrders(upgraded, { supplier: "Acme" });
  assert.equal(page.total, 1);
  assert.equal((await queryOverview(upgraded)).observedSuppliers, 1);
  assert.equal((await queryOrderDetail(upgraded, page.rows[0].record.id))?.source?.source.fileName, "orders.csv");
});
