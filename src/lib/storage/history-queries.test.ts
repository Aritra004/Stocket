import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase, VERSION_3_STORES } from "./database";
import { queryPurchaseOrderCandidates, querySkuDirectory, querySkuHistory, querySupplierDirectory, querySupplierHistory } from "./history-queries";
import { clearArchive, removeImport, saveImport } from "./repository";

const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"];
const lineHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];
const csv = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
const summary = (po: string, supplier = "Acme", date = "2026-01-15") => ["provisional", po, supplier, date, "USD", "12.30", "10", "2"];
const line = (po: string, sku: string, supplier = "Acme", date = "2026-01-15", id = "L1") => ["provisional", po, id, sku, supplier, date, "USD", "1.23", "10", "2"];

async function input(text: string, name = "orders.csv") {
  const file = new File([text], name, { type: "text/csv", lastModified: 1_700_000_000_000 });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) };
}

function database(context: TestContext) {
  const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange };
  const db = createArchiveDatabase(`stocky-history-${crypto.randomUUID()}`, dependencies);
  context.after(async () => { db.close(); await db.delete(); });
  return { db, dependencies };
}

test("supplier directory distinguishes literal case and whitespace; search does not merge names", async (context) => {
  const { db } = database(context);
  const names = ["Acme", "acme", " Acme", "Acme ", "A cme"];
  await saveImport(db, await input(csv(summaryHeaders, names.map((name, i) => summary(`PO-${i}`, name)))));
  await saveImport(db, await input(csv(lineHeaders, [line("Line-1", "SKU", "Acme"), line("Line-2", "SKU", "Line-only supplier")]), "lines.csv"));
  const directory = await querySupplierDirectory(db);
  assert.equal(directory.total, 6);
  assert.deepEqual(new Set(directory.rows.map((row) => row.name)), new Set([...names, "Line-only supplier"]));
  assert.deepEqual(directory.rows.find((row) => row.name === "Acme"), { name: "Acme", orderCount: 1, lineCount: 1 });
  assert.deepEqual(directory.rows.find((row) => row.name === "Line-only supplier"), { name: "Line-only supplier", orderCount: 0, lineCount: 1 });
  const found = await querySupplierDirectory(db, { search: "aCmE" });
  assert.equal(found.total, 4);
  assert.deepEqual((await querySupplierDirectory(db, { sortDirection: "desc" })).rows, [...directory.rows].reverse());
  assert.equal((await querySupplierHistory(db, { supplier: "Acme" })).orders.total, 1);
  assert.equal((await querySupplierHistory(db, { supplier: "ACME" })).exists, false);
  const lineOnly = await querySupplierHistory(db, { supplier: "Line-only supplier" });
  assert.equal(lineOnly.exists, true);
  assert.equal(lineOnly.orders.total, 0);
  assert.equal(lineOnly.lines.total, 1);
});

test("SKU directory/history use exact literal identity and retain original row evidence", async (context) => {
  const { db } = database(context);
  const skus = ["001", "1", "sku", "SKU", " SKU "];
  await saveImport(db, await input(csv(lineHeaders, [...skus.map((sku, i) => line(`PO-${i}`, sku)), line("PO-extra", "001")]), "original-lines.csv"));
  const directory = await querySkuDirectory(db);
  assert.equal(directory.total, 5);
  assert.deepEqual(new Set(directory.rows.map((row) => row.sku)), new Set(skus));
  assert.equal(directory.rows.find((row) => row.sku === "001")?.lineCount, 2);
  assert.equal((await querySkuDirectory(db, { search: "sKu" })).total, 3);
  assert.deepEqual((await querySkuDirectory(db, { sortDirection: "desc" })).rows, [...directory.rows].reverse());
  for (const sku of skus) {
    const history = await querySkuHistory(db, { sku });
    assert.equal(history.exists, true);
    assert.ok(history.lines.rows.every((row) => row.record.fields.sku.value === sku));
    assert.ok(history.lines.rows.every((row) => row.fileName === "original-lines.csv"));
    for (const row of history.lines.rows) {
      const source = await db.sourceReferences.get(row.record.sourceReferenceId);
      assert.equal(source?.dataRowNumber, row.record.rowNumber);
      assert.equal(source?.recordNumber, row.record.recordNumber);
      assert.equal(source?.source.cells[3].rawValue, sku);
    }
  }
  assert.equal((await querySkuHistory(db, { sku: "Sku" })).exists, false);
});

test("literal identifiers preserve Unicode, punctuation and numeric-looking text without reserving display labels", async (context) => {
  const { db } = database(context);
  const identifiers = ["Café", "Cafe\u0301", "A/B?C#D+E&F=G%20", "001e3", "1e3", "1000", "Supplier unavailable"];
  await saveImport(db, await input(csv(summaryHeaders, [
    ...identifiers.map((name, i) => summary(`PO-${i}`, name)),
    summary("PO-unavailable", ""),
  ])));
  await saveImport(db, await input(csv(lineHeaders, identifiers.map((sku, i) => line(`PO-${i}`, sku, sku))), "literal-lines.csv"));
  assert.deepEqual(new Set((await querySupplierDirectory(db)).rows.map((row) => row.name)), new Set(identifiers));
  assert.deepEqual(new Set((await querySkuDirectory(db)).rows.map((row) => row.sku)), new Set(identifiers));
  for (const identifier of identifiers) {
    const supplier = await querySupplierHistory(db, { supplier: identifier });
    const sku = await querySkuHistory(db, { sku: identifier });
    assert.equal(supplier.orders.total, 1);
    assert.equal(supplier.lines.total, 1);
    assert.equal(sku.lines.total, 1);
    assert.equal(sku.lines.rows[0].record.fields.sku.value, identifier);
    assert.equal(supplier.orders.rows[0].record.fields.supplier.value, identifier);
  }
  const unavailable = await querySupplierHistory(db, { supplier: null });
  assert.equal(unavailable.orders.total, 1);
  assert.equal(unavailable.orders.rows[0].record.fields.purchaseOrderNumber.value, "PO-unavailable");
});

test("missing, invalid and conflicting suppliers stay in the unavailable bucket and never inherit values", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1", "Summary supplier"), summary("PO-2", ""), summary("PO-conflict", "Alpha"), summary("PO-conflict", "Beta")])));
  const lines = await input(csv(lineHeaders, [line("PO-1", "SKU", ""), line("PO-invalid", "SKU-invalid", "Invalid source"), line("PO-line-conflict", "SKU-A", "First", "2026-01-15", "L1"), line("PO-line-conflict", "SKU-B", "Second", "2026-01-15", "L2")]), "lines.csv");
  // Simulate a future adapter rejecting a literal without rewriting its source.
  const invalid = lines.result.normalized.records[1].fields.supplier;
  lines.result.normalized.records[1].fields.supplier = { state: "invalid", value: null, reason: "Unusable supplier literal", sources: invalid.sources };
  await saveImport(db, lines);
  const directory = await querySupplierDirectory(db);
  assert.deepEqual(directory.rows.map((row) => row.name), ["Summary supplier"]);
  assert.equal(directory.unavailableOrderCount, 3);
  assert.equal(directory.unavailableLineCount, 4);
  const named = await querySupplierHistory(db, { supplier: "Summary supplier" });
  assert.equal(named.orders.total, 1);
  assert.equal(named.lines.total, 0);
  const unavailable = await querySupplierHistory(db, { supplier: null });
  assert.equal(unavailable.exists, true);
  assert.equal(unavailable.orders.total, 3);
  assert.equal(unavailable.lines.total, 4);
  assert.deepEqual(new Set(unavailable.lines.rows.map((row) => row.record.fields.supplier.state)), new Set(["missing", "invalid", "conflicting"]));
  const candidate = await queryPurchaseOrderCandidates(db, "PO-1");
  assert.equal(candidate.rows[0].record.fields.supplier.value, "Summary supplier");
  const sku = await querySkuHistory(db, { sku: "SKU" });
  assert.equal(sku.lines.rows[0].record.fields.supplier.state, "missing");
  assert.equal(sku.lines.rows[0].record.fields.supplier.value, null);
});

test("conflicting, missing and invalid SKUs never become directory identities", async (context) => {
  const { db } = database(context);
  const incoming = await input(csv(lineHeaders, [line("PO-conflict", "A"), line("PO-conflict", "B"), line("PO-missing", ""), line("PO-invalid", "INVALID"), line("PO-valid", "VALID")]), "lines.csv");
  const record = incoming.result.normalized.records[3];
  assert.equal(record.kind, "purchase-order-line-item");
  if (record.kind === "purchase-order-line-item") record.fields.sku = { state: "invalid", value: null, reason: "Unusable SKU", sources: record.fields.sku.sources };
  await saveImport(db, incoming);
  assert.deepEqual((await querySkuDirectory(db)).rows, [{ sku: "VALID", lineCount: 1 }]);
  for (const sku of ["A", "B", "", "INVALID"]) assert.equal((await querySkuHistory(db, { sku })).exists, false);
  const source = await db.sourceReferences.where("importId").equals((await db.importedFiles.toCollection().first())!.id).toArray();
  assert.ok(source.some((row) => row.source.cells[3].rawValue === "INVALID"));
});

test("histories paginate newest observed dates first and unavailable dates last without synthesizing quantities or costs", async (context) => {
  const { db } = database(context);
  const dates = ["2026-01-01", "", "2026-03-01", "01/05/2026", "2026-02-01"];
  await saveImport(db, await input(csv(summaryHeaders, dates.map((date, i) => summary(`PO-${i}`, "Acme", date)))));
  const lineRows = dates.map((date, i) => line(`PO-${i}`, "SKU", "Acme", date));
  lineRows[0][7] = "999999999999999999999.00001";
  lineRows[0][8] = "0";
  lineRows[1][7] = "";
  lineRows[1][8] = "";
  await saveImport(db, await input(csv(lineHeaders, lineRows), "lines.csv"));
  const supplier = await querySupplierHistory(db, { supplier: "Acme", orderPageSize: 2, linePageSize: 3 });
  assert.deepEqual(supplier.orders.rows.map((row) => row.record.fields.orderDate.value), ["2026-03-01", "2026-02-01"]);
  assert.deepEqual(supplier.lines.rows.map((row) => row.record.fields.orderDate.value), ["2026-03-01", "2026-02-01", "2026-01-01"]);
  const linePage = await querySkuHistory(db, { sku: "SKU", pageIndex: 1, pageSize: 3 });
  assert.equal(linePage.lines.rows.length, 2);
  assert.ok(linePage.lines.rows.every((row) => row.record.fields.orderDate.state !== "observed"));
  const exact = supplier.lines.rows.find((row) => row.record.fields.orderDate.value === "2026-01-01")!.record;
  assert.equal(exact.fields.unitCost.value, "999999999999999999999.00001");
  assert.equal(exact.fields.orderedQuantity.value, "0");
  const missing = linePage.lines.rows.find((row) => row.record.fields.orderDate.state === "missing")!.record;
  assert.equal(missing.fields.unitCost.state, "missing");
  assert.equal(missing.fields.unitCost.value, null);
  assert.equal(missing.fields.orderedQuantity.value, null);
  const clamped = await querySupplierHistory(db, { supplier: "Acme", orderPageIndex: 999, orderPageSize: 2, linePageIndex: 999, linePageSize: 3 });
  assert.equal(clamped.orders.pageIndex, 2);
  assert.equal(clamped.orders.rows.length, 1);
  assert.equal(clamped.lines.pageIndex, 1);
});

test("SKU history never fills absent line facts from a matching summary or another import", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-shared", "Summary supplier", "2026-05-01")])));
  await saveImport(db, await input(csv(lineHeaders, [line("PO-shared", "SHARED", "Earlier supplier", "2026-04-01")]), "complete-lines.csv"));
  const sparseLine = line("PO-shared", "SHARED", "", "");
  sparseLine[6] = "";
  sparseLine[7] = "";
  sparseLine[8] = "";
  sparseLine[9] = "3";
  await saveImport(db, await input(csv(lineHeaders, [sparseLine]), "sparse-lines.csv"));
  const history = await querySkuHistory(db, { sku: "SHARED" });
  assert.equal(history.lines.total, 2);
  const sparse = history.lines.rows.find((row) => row.fileName === "sparse-lines.csv")!.record;
  for (const field of ["supplier", "orderDate", "currency", "unitCost", "orderedQuantity", "outstandingQuantity"] as const) {
    assert.equal(sparse.fields[field].state, "missing", `${field} must remain missing`);
    assert.equal(sparse.fields[field].value, null, `${field} must not borrow or infer a value`);
  }
  assert.equal(sparse.fields.receivedQuantity.value, "3");
  assert.equal((await querySupplierHistory(db, { supplier: "Summary supplier" })).lines.total, 0);
  assert.equal((await querySupplierHistory(db, { supplier: null })).lines.total, 1);
});

test("history pagination crosses the observed/unavailable date boundary without losing or duplicating records", async (context) => {
  const { db } = database(context);
  const dates = ["2026-03-01", "2026-01-01", "2026-03-01", "", "invalid-date", "2026-02-01", ""];
  await saveImport(db, await input(csv(summaryHeaders, dates.map((date, i) => summary(`PO-${i}`, "", date)))));
  await saveImport(db, await input(csv(lineHeaders, dates.map((date, i) => line(`PO-${i}`, "SKU", "", date))), "lines.csv"));
  const orderIds: string[] = [];
  const lineIds: string[] = [];
  const skuIds: string[] = [];
  const dateValues: Array<string | null> = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const supplier = await querySupplierHistory(db, { supplier: null, orderPageIndex: pageIndex, orderPageSize: 3, linePageIndex: pageIndex, linePageSize: 3 });
    const sku = await querySkuHistory(db, { sku: "SKU", pageIndex, pageSize: 3 });
    orderIds.push(...supplier.orders.rows.map((row) => row.record.id));
    lineIds.push(...supplier.lines.rows.map((row) => row.record.id));
    skuIds.push(...sku.lines.rows.map((row) => row.record.id));
    dateValues.push(...sku.lines.rows.map((row) => row.record.fields.orderDate.value));
  }
  assert.equal(orderIds.length, dates.length);
  assert.equal(lineIds.length, dates.length);
  assert.equal(skuIds.length, dates.length);
  assert.equal(new Set(orderIds).size, dates.length);
  assert.equal(new Set(lineIds).size, dates.length);
  assert.equal(new Set(skuIds).size, dates.length);
  assert.deepEqual(new Set(lineIds), new Set(skuIds));
  assert.deepEqual(dateValues, ["2026-03-01", "2026-03-01", "2026-02-01", "2026-01-01", null, null, null]);
});

test("PO candidates require exact observed numbers and retain repeated summaries separately", async (context) => {
  const { db } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1"), summary("PO-10"), summary(" PO-1"), summary("")]), "summary-a.csv"));
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1", "Other observation")]), "summary-b.csv"));
  const candidates = await queryPurchaseOrderCandidates(db, "PO-1");
  assert.equal(candidates.total, 2);
  assert.deepEqual(new Set(candidates.rows.map((row) => row.fileName)), new Set(["summary-a.csv", "summary-b.csv"]));
  assert.equal((await queryPurchaseOrderCandidates(db, "po-1")).total, 0);
  assert.equal((await queryPurchaseOrderCandidates(db, "PO-")).total, 0);
  assert.equal((await queryPurchaseOrderCandidates(db, null)).total, 0);
  assert.equal((await queryPurchaseOrderCandidates(db, "")).total, 0);
  assert.equal((await queryPurchaseOrderCandidates(db, "PO-1", 99, 1)).pageIndex, 1);
});

test("empty, summary-only and line-only archives produce truthful histories", async (context) => {
  const { db } = database(context);
  assert.equal((await querySupplierDirectory(db)).total, 0);
  assert.equal((await querySkuDirectory(db)).total, 0);
  assert.equal((await querySupplierHistory(db, { supplier: null })).exists, false);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1")])));
  assert.equal((await querySkuDirectory(db)).total, 0);
  assert.equal((await querySupplierHistory(db, { supplier: "Acme" })).lines.total, 0);
  await clearArchive(db);
  await saveImport(db, await input(csv(lineHeaders, [line("PO-1", "SKU")]), "lines.csv"));
  const history = await querySupplierHistory(db, { supplier: "Acme" });
  assert.equal(history.orders.total, 0);
  assert.equal(history.lines.total, 1);
  assert.equal((await queryPurchaseOrderCandidates(db, "PO-1")).total, 0);
});

test("large directories and histories stay bounded, including late pages and deleted-page clamps", async (context) => {
  const { db } = database(context);
  const count = 1200;
  await saveImport(db, await input(csv(lineHeaders, Array.from({ length: count }, (_, i) => line(`PO-${i}`, `SKU-${String(i).padStart(4, "0")}`, `Supplier-${String(i).padStart(4, "0")}`))), "many-lines.csv"));
  const suppliers = await querySupplierDirectory(db, { pageIndex: 30, pageSize: 25 });
  const skus = await querySkuDirectory(db, { pageIndex: 30, pageSize: 25 });
  assert.equal(suppliers.total, count);
  assert.equal(suppliers.rows.length, 25);
  assert.equal(suppliers.rows[0].name, "Supplier-0750");
  assert.equal(skus.rows[0].sku, "SKU-0750");
  assert.equal((await querySupplierDirectory(db, { pageSize: 10000 })).rows.length, 100);
  assert.equal((await querySkuDirectory(db, { pageSize: 10000 })).rows.length, 100);
  const last = await querySkuDirectory(db, { search: "SKU-11", pageIndex: 999, pageSize: 30 });
  assert.equal(last.total, 100);
  assert.equal(last.pageIndex, 3);
  assert.equal(last.rows.length, 10);
  assert.equal(last.rows[0].sku, "SKU-1190");
  assert.equal((await querySupplierDirectory(db, { search: "not present", pageIndex: 999 })).pageIndex, 0);
  // The same literal has many observations without becoming many identities.
  await saveImport(db, await input(csv(lineHeaders, Array.from({ length: 220 }, (_, i) => line(`More-${i}`, "REPEATED", "REPEATED"))), "repeated.csv"));
  assert.equal((await querySupplierHistory(db, { supplier: "REPEATED", linePageSize: 10000 })).lines.rows.length, 100);
  assert.equal((await querySkuHistory(db, { sku: "REPEATED", pageIndex: 10, pageSize: 20 })).lines.rows.length, 20);
  await saveImport(db, await input(csv(summaryHeaders, Array.from({ length: 220 }, () => summary("REPEATED", "REPEATED"))), "repeated-summaries.csv"));
  const candidates = await queryPurchaseOrderCandidates(db, "REPEATED", 0, 10000);
  assert.equal(candidates.total, 220);
  assert.equal(candidates.rows.length, 100);
  const finalCandidates = await queryPurchaseOrderCandidates(db, "REPEATED", 999, 100);
  assert.equal(finalCandidates.pageIndex, 2);
  assert.equal(finalCandidates.rows.length, 20);
});

test("history queries reflect replacement, removal and clear without cached identities", async (context) => {
  const { db } = database(context);
  const saved = await saveImport(db, await input(csv(lineHeaders, [line("PO-1", "OLD", "Old supplier")]), "lines.csv"));
  await saveImport(db, { ...await input(csv(lineHeaders, [line("PO-2", "NEW", "New supplier")]), "lines.csv"), replaceId: saved.file.id, expectedHash: saved.file.sha256 });
  assert.equal((await querySupplierHistory(db, { supplier: "Old supplier" })).exists, false);
  assert.equal((await querySkuHistory(db, { sku: "OLD" })).exists, false);
  assert.equal((await querySkuHistory(db, { sku: "NEW" })).exists, true);
  assert.deepEqual((await querySupplierDirectory(db)).rows.map((row) => row.name), ["New supplier"]);
  await removeImport(db, saved.file.id);
  assert.equal((await querySkuDirectory(db)).total, 0);
  await saveImport(db, await input(csv(lineHeaders, [line("PO-3", "FINAL", "Final supplier")]), "final.csv"));
  await clearArchive(db);
  assert.equal((await querySupplierDirectory(db)).total, 0);
  assert.equal((await querySkuHistory(db, { sku: "FINAL" })).exists, false);
});

test("v3 migration builds history indexes without changing archived records or requiring payload reads", async (context) => {
  const { db, dependencies } = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1")])));
  await saveImport(db, await input(csv(lineHeaders, [line("PO-1", "SKU", "Acme", "")]), "lines.csv"));
  const snapshot = await Promise.all(db.tables.map(async (table) => ({ name: table.name, rows: await table.toArray() })));
  const name = `stocky-history-v3-${crypto.randomUUID()}`;
  const legacy = new Dexie(name, dependencies);
  legacy.version(3).stores(VERSION_3_STORES);
  await legacy.open();
  for (const table of snapshot) if (table.name in VERSION_3_STORES) await legacy.table(table.name).bulkPut(table.rows);
  legacy.close();
  const upgraded = createArchiveDatabase(name, dependencies);
  context.after(async () => { upgraded.close(); await upgraded.delete(); });
  await upgraded.open();
  for (const table of snapshot) assert.deepEqual(await upgraded.table(table.name).toArray(), table.rows);
  await upgraded.importPayloads.clear();
  assert.equal((await querySupplierDirectory(upgraded)).rows[0].lineCount, 1);
  const supplier = await querySupplierHistory(upgraded, { supplier: "Acme" });
  assert.equal(supplier.orders.total, 1);
  assert.equal(supplier.lines.total, 1);
  assert.equal(supplier.lines.rows[0].record.fields.orderDate.state, "missing");
  assert.equal((await querySkuHistory(upgraded, { sku: "SKU" })).lines.total, 1);
  assert.equal((await queryPurchaseOrderCandidates(upgraded, "PO-1")).total, 1);
});
