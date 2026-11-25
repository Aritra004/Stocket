import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase } from "./database";
import { queryOfflineArchive } from "./offline-export";
import { queryDataQuality } from "./quality-queries";
import { saveImport } from "./repository";

const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"];
const lineHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];
const csv = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
const summary = (po: string) => ["provisional", po, "Supplier", "2026-01-15", "USD", "12.30", "10", "2"];
const line = (po: string, sku = "001") => ["provisional", po, "L1", sku, "Supplier", "2026-01-15", "USD", "1.23", "10", "2"];
async function save(db: ReturnType<typeof createArchiveDatabase>, text: string, name: string) {
  const file = new File([text], name, { type: "text/csv" });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return saveImport(db, { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) });
}
function database(context: TestContext) {
  const db = createArchiveDatabase(`offline-export-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
  context.after(async () => { db.close(); await db.delete(); });
  return db;
}

test("empty, summary-only and line-only archives export independently without inventing relationships", async (context) => {
  const empty = await queryOfflineArchive(database(context));
  assert.deepEqual(empty.records, []);
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.version, 1);
  const summaryDb = database(context);
  await save(summaryDb, csv(summaryHeaders, [summary("PO-summary")]), "summary.csv");
  const summaries = await queryOfflineArchive(summaryDb);
  assert.equal(summaries.records.length, 1);
  assert.equal(summaries.records[0].kind, "purchase-order-summary");
  assert.equal(Object.hasOwn(summaries.records[0].fields, "sku"), false);
  const lineDb = database(context);
  await save(lineDb, csv(lineHeaders, [line("PO-line")]), "line.csv");
  const lines = await queryOfflineArchive(lineDb);
  assert.equal(lines.records.length, 1);
  assert.equal(lines.records[0].kind, "purchase-order-line-item");
  assert.equal(lines.records[0].fields.sku.value, "001");
});

test("archive export includes clean source rows beyond quality evidence and retains precision, currencies and hostile strings", async (context) => {
  const db = database(context);
  const precise = line("PO-1", "0007");
  precise[4] = "</script><img src=x onerror=alert(1)>";
  precise[7] = "123456789012345678901.00000000000000001";
  const second = line("PO-2", "__proto__");
  second[6] = "INR";
  second[7] = "0";
  await save(db, csv(lineHeaders, [precise, second]), "source<&>.csv");
  const quality = await queryDataQuality(db);
  assert.equal(quality.sources.length, 0);
  const before = await Promise.all(db.tables.map(async (table) => ({ name: table.name, records: await table.toArray() })));
  const exported = await queryOfflineArchive(db);
  assert.equal(exported.sources.length, 2);
  assert.equal(exported.records.length, 2);
  assert.equal(exported.files[0].name, "source<&>.csv");
  assert.equal(exported.records[0].fields.unitCost.value, "123456789012345678901.00000000000000001");
  assert.deepEqual(new Set(exported.records.map((record) => record.fields.currency.value)), new Set(["USD", "INR"]));
  assert.ok(exported.sources.some((source) => source.cells.some((cell) => cell.rawValue === "</script><img src=x onerror=alert(1)>")));
  assert.ok(exported.records.some((record) => record.fields.sku.value === "__proto__"));
  assert.deepEqual(await Promise.all(db.tables.map(async (table) => ({ name: table.name, records: await table.toArray() }))), before);
});

test("archive export retains missing/invalid/conflicting states and file-consistent quality references", async (context) => {
  const db = database(context);
  const sparse = line("PO-sparse");
  sparse[4] = "";
  sparse[5] = "bad-date";
  sparse[7] = "";
  const conflictA = line("PO-conflict", "SKU-A");
  const conflictB = line("PO-conflict", "SKU-B");
  await save(db, csv(lineHeaders, [sparse, conflictA, conflictB]), "states.csv");
  await save(db, "Unknown,Columns\none,two\n", "unknown.csv");
  const exported = await queryOfflineArchive(db);
  const row = exported.records.find((record) => record.fields.purchaseOrderNumber.value === "PO-sparse")!;
  assert.deepEqual(row.fields.supplier, { state: "missing", value: null });
  assert.deepEqual(row.fields.orderDate, { state: "invalid", value: null });
  assert.deepEqual(row.fields.unitCost, { state: "missing", value: null });
  assert.equal(exported.records.filter((record) => record.fields.sku.state === "conflicting").length, 2);
  const records = new Map(exported.records.map((record) => [record.id, record]));
  const sources = new Map(exported.sources.map((source) => [source.id, source]));
  for (const finding of exported.findings) {
    assert.ok(finding.recordIds.every((id) => records.get(id)?.fileId === finding.fileId));
    assert.ok(finding.sourceIds.every((id) => sources.get(id)?.fileId === finding.fileId));
  }
  assert.ok(exported.findings.some((finding) => finding.recordIds.length === 0 && finding.sourceIds.length === 0));
});

test("archive export includes malformed unnormalized source rows and rejects missing normalized sources clearly", async (context) => {
  const db = database(context);
  await save(db, `${summaryHeaders.join(",")}\n${summary("PO-bad").join(",")},extra\n`, "malformed.csv");
  const malformed = await queryOfflineArchive(db);
  assert.equal(malformed.records.length, 0);
  assert.equal(malformed.sources.length, 1);
  assert.equal(malformed.sources[0].cells.at(-1)?.rawValue, "extra");
  const valid = await save(db, csv(summaryHeaders, [summary("PO-valid")]), "valid.csv");
  const record = await db.purchaseOrders.where("importId").equals(valid.file.id).first();
  await db.sourceReferences.delete(record!.sourceReferenceId);
  await assert.rejects(queryOfflineArchive(db), /could not be exported without losing reference integrity.*sourceId: references an unknown source ID/);
});
