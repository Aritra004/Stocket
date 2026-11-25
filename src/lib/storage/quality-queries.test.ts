import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase } from "./database";
import { queryDataQuality } from "./quality-queries";
import { clearArchive, removeImport, saveImport } from "./repository";

const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"];
const lineHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];
const csv = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
const summary = (po: string, supplier = "Supplier") => ["provisional", po, supplier, "2026-01-15", "USD", "12.30", "10", "2"];
const line = (po: string, sku = "001") => ["provisional", po, "L1", sku, "Supplier", "2026-01-15", "USD", "1.23", "10", "2"];

async function input(text: string, name = "orders.csv") {
  const file = new File([text], name, { type: "text/csv", lastModified: 1_700_000_000_000 });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) };
}

function database(context: TestContext) {
  const db = createArchiveDatabase(`stocky-quality-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
  context.after(async () => { db.close(); await db.delete(); });
  return db;
}

test("empty and summary-only archives report actual coverage without requiring optional fields or SKUs", async (context) => {
  const db = database(context);
  const empty = await queryDataQuality(db);
  assert.equal(empty.totals.fileCount, 0);
  assert.deepEqual(empty.findings, []);
  assert.ok(Number.isFinite(Date.parse(empty.generatedAt)));
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1")])));
  const report = await queryDataQuality(db);
  assert.equal(report.files[0].schemaStatus, "matched");
  assert.equal(report.files[0].analyzedRecords, 1);
  assert.equal(report.totals.categoryRecordCounts.incomplete, 0);
  assert.equal(report.findings.some((finding) => finding.fields.includes("sku")), false);
  assert.match(report.coverageNotes.join(" "), /Summary records are not expected to contain SKUs/);
});

test("missing history fields are grouped per record and never inferred from another record", async (context) => {
  const db = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-shared")])));
  const sparse = line("PO-shared", "001");
  for (const index of [4, 5, 6, 7, 8, 9]) sparse[index] = "";
  await saveImport(db, await input(csv(lineHeaders, [sparse]), "sparse.csv"));
  const before = await db.lineItems.toArray();
  const report = await queryDataQuality(db);
  const findings = report.findings.filter((finding) => finding.category === "incomplete");
  assert.equal(findings.length, 1);
  assert.equal(report.totals.categoryRecordCounts.incomplete, 1);
  assert.deepEqual(findings[0].fields, ["supplier", "orderDate", "currency", "unitCost", "orderedQuantity", "receivedQuantity"]);
  assert.deepEqual(findings[0].columns.map((column) => column.rawValue), ["", "", "", "", "", ""]);
  assert.equal(report.sources.find((source) => source.sourceReferenceId === findings[0].sourceReferenceId)?.columns[3].rawValue, "001");
  assert.deepEqual(await db.lineItems.toArray(), before);
});

test("exact duplicates use all preserved cells and remain distinct from repeated identifiers and differing unmapped values", async (context) => {
  const db = database(context);
  const original = [...line("PO-repeat", "001"), "Original"];
  const differentCost = [...original];
  differentCost[7] = "1.230";
  const differentExtra = [...original];
  differentExtra[10] = "original";
  await saveImport(db, await input(csv([...lineHeaders, "Unmapped note"], [original, [...original], differentCost, differentExtra]), "duplicates.csv"));
  const report = await queryDataQuality(db);
  assert.equal(report.totals.exactDuplicateGroupCount, 1);
  assert.equal(report.totals.exactDuplicateRecordCount, 2);
  assert.equal(report.totals.categoryRecordCounts["exact-duplicate"], 2);
  assert.equal(report.duplicateGroups[0].recordIds.length, 2);
  assert.deepEqual(report.findings.filter((finding) => finding.category === "exact-duplicate").map((finding) => finding.dataRowNumber), [1, 2]);
  assert.deepEqual(report.files[0].unmappedColumns, [{ column: 11, header: "Unmapped note" }]);
  assert.match(report.files[0].coverageNotes.join(" "), /unmapped column/);
  assert.equal(await db.lineItems.count(), 4);
});

test("exact duplicates can span imports while ambiguous shared identifiers alone never become exact duplicates", async (context) => {
  const db = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1")]), "first.csv"));
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1"), summary("PO-2")]), "second.csv"));
  const report = await queryDataQuality(db);
  assert.equal(report.duplicateGroups.length, 1);
  assert.equal(report.duplicateGroups[0].importIds.length, 2);
  assert.equal(report.totals.categoryRecordCounts["ambiguous-overlap"], 2);
  assert.equal(report.totals.categoryRecordCounts["exact-duplicate"], 2);
  assert.equal(report.totals.affectedRecordCount, 2);
  assert.ok(report.files.every((file) => file.categoryRecordCounts["exact-duplicate"] === 1));
});

test("invalid dates, invalid costs and conflicts retain source values and count affected records distinctly", async (context) => {
  const db = database(context);
  const bad = line("PO-bad", "<svg onload=alert(1)>");
  bad[5] = "02/30/2026";
  bad[7] = "$1.23";
  bad[8] = "-1";
  const conflictA = line("PO-conflict", "SKU-A");
  const conflictB = line("PO-conflict", "SKU-B");
  conflictB[7] = "2.5";
  await saveImport(db, await input(csv(lineHeaders, [bad, conflictA, conflictB]), "original<script>.csv"));
  const before = await Promise.all(db.tables.map(async (table) => ({ table: table.name, rows: await table.toArray() })));
  const report = await queryDataQuality(db);
  assert.equal(report.totals.categoryRecordCounts["invalid-date"], 1);
  assert.equal(report.totals.categoryRecordCounts["invalid-value"], 1);
  assert.equal(report.totals.categoryRecordCounts.conflict, 2);
  assert.equal(report.totals.affectedRecordCount, 3);
  const date = report.findings.find((finding) => finding.category === "invalid-date")!;
  assert.equal(date.recordNumber, 2);
  assert.equal(date.dataRowNumber, 1);
  assert.deepEqual(date.columns, [{ column: 6, header: "Order Date", rawValue: "02/30/2026" }]);
  const source = report.sources.find((entry) => entry.sourceReferenceId === date.sourceReferenceId)!;
  assert.equal(source.columns[3].rawValue, "<svg onload=alert(1)>");
  assert.match(source.rawText, /02\/30\/2026/);
  assert.ok(report.findings.filter((finding) => finding.category === "conflict").every((finding) => finding.columns.some((column) => column.header === "SKU")));
  assert.equal(new Set(report.sources.map((entry) => entry.sourceReferenceId)).size, report.sources.length);
  assert.deepEqual(await Promise.all(db.tables.map(async (table) => ({ table: table.name, rows: await table.toArray() }))), before);
});

test("cross-import conflicts identify every affected local candidate record without resolving identities", async (context) => {
  const db = database(context);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-shared", "Alpha"), summary("PO-shared", "Alpha")]), "alpha.csv"));
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-shared", "Beta")]), "beta.csv"));
  const report = await queryDataQuality(db);
  const overlap = report.findings.filter((finding) => finding.code === "ConflictingOrderRecords");
  assert.equal(overlap.length, 2);
  assert.equal(report.totals.categoryRecordCounts.conflict, 3);
  assert.equal(report.totals.categoryFindingCounts.conflict, 2);
  assert.equal(report.files.find((file) => file.fileName === "alpha.csv")?.categoryRecordCounts.conflict, 2);
  assert.ok(overlap.every((finding) => finding.affectedRecordIds?.length === finding.relatedSourceReferenceIds?.length));
  assert.ok(overlap.every((finding) => finding.fields.includes("supplier")));
  assert.match(report.coverageNotes.join(" "), /different stores or orders/);
});

test("unsupported schemas, file errors and capped parser diagnostics disclose incomplete coverage", async (context) => {
  const db = database(context);
  await saveImport(db, await input("Unrecognized,Another\nvalue,data\n", "unknown.csv"));
  await saveImport(db, await input("", "empty.csv"));
  const capped = await input(csv(summaryHeaders, [summary("PO-capped")]), "capped.csv");
  capped.result.warningCount = capped.result.warnings.length + 125;
  await saveImport(db, capped);
  const report = await queryDataQuality(db);
  const unsupported = report.files.find((file) => file.fileName === "unknown.csv")!;
  assert.equal(unsupported.schemaStatus, "unknown");
  assert.equal(unsupported.analyzedRecords, 0);
  assert.match(unsupported.coverageNotes.join(" "), /no supported field mapping/);
  assert.ok(report.findings.some((finding) => finding.fileName === "unknown.csv" && finding.category === "schema-issue"));
  assert.ok(report.findings.some((finding) => finding.fileName === "empty.csv" && finding.severity === "error" && finding.category === "csv-issue"));
  const limited = report.files.find((file) => file.fileName === "capped.csv")!;
  assert.match(limited.coverageNotes.join(" "), /capped/);
  assert.equal(limited.parserDiagnosticCounts?.warning, 125);
});

test("withheld malformed rows retain CSV row evidence without becoming mapped records", async (context) => {
  const db = database(context);
  const headers = summaryHeaders.join(",");
  await saveImport(db, await input(`${headers}\n${summary("PO-1").join(",")},extra\n`, "malformed.csv"));
  const report = await queryDataQuality(db);
  assert.equal(report.files[0].analyzedRecords, 0);
  assert.equal(report.files[0].withheldRecords, 1);
  assert.equal(report.totals.categoryRecordCounts["csv-issue"], 1);
  const rowIssue = report.findings.find((finding) => finding.category === "csv-issue" && finding.dataRowNumber === 1)!;
  assert.equal(rowIssue.recordId, undefined);
  assert.equal(rowIssue.recordNumber, 2);
  const source = report.sources.find((entry) => entry.sourceReferenceId === rowIssue.sourceReferenceId)!;
  assert.deepEqual(source.columns.at(-1), { column: 9, header: null, rawValue: "extra" });
  assert.equal(report.totals.exactDuplicateGroupCount, 0);
});

test("quality snapshots refresh after replacement, removal and clear without writing or caching findings", async (context) => {
  const db = database(context);
  const saved = await saveImport(db, await input(csv(summaryHeaders, [summary("PO-1", ""), summary("PO-1", "")])));
  const initial = await queryDataQuality(db);
  assert.equal(initial.totals.exactDuplicateRecordCount, 2);
  assert.equal(initial.totals.categoryRecordCounts.incomplete, 2);
  await saveImport(db, { ...await input(csv(summaryHeaders, [summary("PO-new")]), "orders.csv"), replaceId: saved.file.id, expectedHash: saved.file.sha256 });
  const replaced = await queryDataQuality(db);
  assert.equal(replaced.totals.exactDuplicateRecordCount, 0);
  assert.equal(replaced.totals.categoryRecordCounts.incomplete, 0);
  await removeImport(db, saved.file.id);
  assert.equal((await queryDataQuality(db)).files.length, 0);
  await saveImport(db, await input(csv(summaryHeaders, [summary("PO-final", "")])));
  await clearArchive(db);
  assert.deepEqual((await queryDataQuality(db)).findings, []);
});
