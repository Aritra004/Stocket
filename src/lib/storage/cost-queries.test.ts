import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase } from "./database";
import { querySkuCostHistory } from "./cost-queries";
import { removeImport, saveImport } from "./repository";

const headers = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity"];
const line = (id: string, date: string, currency: string, cost: string, quantity = "2", sku = "00123") => ["provisional", `PO-${id}`, id, sku, "Exact Supplier", date, currency, cost, quantity];
const csv = (columns: string[], rows: string[][]) => [columns, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";

async function input(contents: string, name = "cost-lines.csv") {
  const file = new File([contents], name, { type: "text/csv", lastModified: 1_700_000_000_000 });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) };
}

function database(context: TestContext) {
  const db = createArchiveDatabase(`stocky-costs-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
  context.after(async () => { db.close(); await db.delete(); });
  return db;
}

test("cost history preserves exact decimals and currencies as separate line observations", async (context) => {
  const db = database(context);
  const preciseCost = "12345678901234567890.0000000000000001";
  await saveImport(db, await input(csv(headers, [
    line("usd", "2026-02-01", "USD", preciseCost),
    line("inr", "2026-03-01", "INR", "0", "0"),
    line("no-currency", "2026-01-01", "", "1.25"),
    line("other-sku", "2026-04-01", "USD", "999", "9", "123"),
    line("spaced-sku", "2026-04-01", "USD", "888", "8", "00123 "),
  ])));
  const history = await querySkuCostHistory(db, { sku: "00123" });
  assert.equal(history.sku, "00123");
  assert.equal(history.entries.total, 3);
  const fields = history.entries.rows.map((row) => row.record.fields);
  assert.deepEqual(fields.map((row) => [row.unitCost.value, row.currency.value]), [["0", "INR"], [preciseCost, "USD"], ["1.25", null]]);
  assert.equal(fields[0].orderedQuantity.value, "0");
  assert.equal(fields[2].currency.state, "missing");
  assert.ok(history.entries.rows.every((row) => row.fileName === "cost-lines.csv"));
  const source = await db.sourceReferences.get(history.entries.rows[1].record.sourceReferenceId);
  assert.equal(source?.source.cells[7].rawValue, preciseCost);
  assert.equal(source?.source.cells[3].rawValue, "00123");
});

test("cost history keeps missing, invalid, conflicting and calculated costs visible without borrowing values", async (context) => {
  const db = database(context);
  const incoming = await input(csv(headers, [
    line("missing", "2026-01-01", "", "", ""),
    line("invalid", "2026-02-01", "USD", "free"),
    line("conflicting", "2026-03-01", "EUR", "3"),
    line("derived", "2026-04-01", "USD", "4"),
  ]));
  const conflict = incoming.result.normalized.records[2];
  const derived = incoming.result.normalized.records[3];
  assert.equal(conflict.kind, "purchase-order-line-item");
  assert.equal(derived.kind, "purchase-order-line-item");
  if (conflict.kind !== "purchase-order-line-item" || derived.kind !== "purchase-order-line-item") throw new Error("Expected line fixtures");
  conflict.fields.unitCost = { state: "conflicting", value: null, sources: conflict.fields.unitCost.sources, reason: "Conflicting observed costs", alternatives: [] };
  assert.equal(derived.fields.unitCost.state, "observed");
  derived.fields.unitCost = { ...derived.fields.unitCost, state: "derived", value: derived.fields.unitCost.value!, rule: "Synthetic future-adapter calculation" };
  await saveImport(db, incoming);
  await saveImport(db, await input("__stocky_rescue_po_summary_v1,PO Number,Supplier,Currency,Total Cost,Ordered Quantity\nprovisional,PO-missing,Summary supplier,GBP,100,10\n", "summary.csv"));
  const history = await querySkuCostHistory(db, { sku: "00123" });
  assert.equal(history.entries.total, 4);
  assert.deepEqual(history.entries.rows.map((row) => row.record.fields.unitCost.state), ["derived", "conflicting", "invalid", "missing"]);
  const missing = history.entries.rows[3].record.fields;
  assert.equal(missing.unitCost.value, null);
  assert.equal(missing.currency.value, null);
  assert.equal(missing.orderedQuantity.value, null);
  assert.equal(missing.supplier.value, "Exact Supplier");
});

test("cost chronology paginates across unavailable dates without dropping records or price states", async (context) => {
  const db = database(context);
  await saveImport(db, await input(csv(headers, [
    line("old", "2026-01-01", "USD", "1"),
    line("missing-date", "", "USD", "2"),
    line("new", "2026-03-01", "EUR", ""),
    line("invalid-date", "01/02/2026", "INR", "3"),
    line("middle", "2026-02-01", "USD", "4"),
  ])));
  const all = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = await querySkuCostHistory(db, { sku: "00123", pageIndex, pageSize: 2 });
    assert.equal(page.entries.total, 5);
    all.push(...page.entries.rows);
  }
  assert.equal(new Set(all.map((row) => row.record.id)).size, 5);
  assert.deepEqual(all.map((row) => row.record.fields.orderDate.value), ["2026-03-01", "2026-02-01", "2026-01-01", null, null]);
  assert.equal(all[0].record.fields.unitCost.state, "missing");
  assert.equal((await querySkuCostHistory(db, { sku: "00123", pageIndex: 99, pageSize: 2 })).entries.pageIndex, 2);
});

test("summary totals never create SKU unit costs and removed lines disappear from cost history", async (context) => {
  const db = database(context);
  await saveImport(db, await input("__stocky_rescue_po_summary_v1,PO Number,Total Cost,Ordered Quantity\nprovisional,PO-summary,100,10\n", "summary-only.csv"));
  assert.equal((await querySkuCostHistory(db, { sku: "00123" })).exists, false);
  const saved = await saveImport(db, await input(csv(headers, [line("one", "2026-01-01", "USD", "0")])));
  assert.equal((await querySkuCostHistory(db, { sku: "00123" })).entries.total, 1);
  await removeImport(db, saved.file.id);
  const removed = await querySkuCostHistory(db, { sku: "00123" });
  assert.equal(removed.exists, false);
  assert.deepEqual(removed.entries.rows, []);
});
