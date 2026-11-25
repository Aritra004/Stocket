import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createArchiveDatabase } from "./storage/database";
import { saveImport } from "./storage/repository";
import { queryDataQuality } from "./storage/quality-queries";
import { parseFileContents } from "./importer/csv-parser-core";
import { renderDataQualityReport } from "./quality-report";

function database(context: TestContext) {
  const db = createArchiveDatabase(`quality-report-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
  context.after(async () => { db.close(); await db.delete(); });
  return db;
}

const headers = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Product Name", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];

async function saveRows(db: ReturnType<typeof database>, rows: string[][], name = "quality.csv") {
  const text = [headers, ...rows].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n");
  const file = new File([text], name, { type: "text/csv" });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (value) => value.toString(16).padStart(2, "0")).join("");
  await saveImport(db, { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) });
}

test("empty quality exports are complete standalone documents without invented findings", async (context) => {
  const html = renderDataQualityReport(await queryDataQuality(database(context)));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Stocky History Rescue/);
  assert.match(html, /No saved imports/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<(?:script|iframe|img|link)\b/i);
});

test("HTML quality report escapes imported text and retains original source values and per-file quality", async (context) => {
  const db = database(context);
  const precise = "123456789012345678901.00000000000000001";
  const malicious = '<script>alert("literal")</script><img src="https://example.invalid/x">';
  await saveRows(db, [
    ["provisional", "PO-1", "L1", "0007", malicious, "<Supplier & Co>", "bad-date", "USD", precise, "1", "0"],
    ["provisional", "PO-2", "L2", "0007", "Missing cost", "", "", "INR", "", "", ""],
  ], 'source<&".csv');
  const snapshot = await queryDataQuality(db);
  const html = renderDataQualityReport(snapshot);
  assert.match(html, /Import quality by file/);
  assert.match(html, /Invalid dates/);
  assert.match(html, /Incomplete records/);
  assert.ok(html.includes(precise));
  assert.ok(html.includes("USD") && html.includes("INR") && html.includes("0007"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;literal&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("source&lt;&amp;&quot;.csv"));
  assert.ok(html.includes("&lt;Supplier &amp; Co&gt;"));
  assert.match(html, /Data row 1/);
  assert.match(html, /CSV record 2/);
  assert.match(html, /Original CSV record/);
  assert.match(html, /Empty string/);
  assert.doesNotMatch(html, /<(?:script|iframe|img|link)\b/i);
  assert.doesNotMatch(html, /(?:href|src)="(?:https?:|javascript:|\/)/i);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const match of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(match[1]), `source link ${match[1]} must resolve offline`);
});

test("quality export includes all findings and source rows beyond the visible page", async (context) => {
  const db = database(context);
  await saveRows(db, Array.from({ length: 31 }, (_, index) => ["provisional", `PO-${index}`, `L${index}`, "SKU", `item-${index}`, "Supplier", "bad-date", "USD", "0", "1", "0"]));
  const snapshot = await queryDataQuality(db);
  const html = renderDataQualityReport(snapshot);
  assert.ok(html.includes("item-30"));
  assert.match(html, /Data row 31/);
  assert.match(html, /CSV record 32/);
  assert.equal([...html.matchAll(/data-quality-finding="true"/g)].length, snapshot.findings.length);
});

test("duplicate report references grow with the records instead of repeating the full group per finding", async (context) => {
  const db = database(context);
  const count = 60;
  await saveRows(db, Array.from({ length: count }, () => ["provisional", "REPEATED", "L1", "SKU", "Exact copy", "Supplier", "2026-01-01", "USD", "0", "1", "0"]));
  const snapshot = await queryDataQuality(db);
  const html = renderDataQualityReport(snapshot);
  assert.equal(snapshot.totals.exactDuplicateRecordCount, count);
  assert.equal([...html.matchAll(/id="duplicate-group-/g)].length, 1);
  assert.equal([...html.matchAll(/href="#duplicate-group-/g)].length, count);
  assert.equal([...html.matchAll(/href="#source-/g)].length, count * 2);
});
