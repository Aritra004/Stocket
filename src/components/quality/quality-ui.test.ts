import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../../lib/importer/csv-parser-core";
import { createArchiveDatabase } from "../../lib/storage/database";
import { queryDataQuality } from "../../lib/storage/quality-queries";
import { saveImport } from "../../lib/storage/repository";
import type { DataQualityFinding } from "../../lib/storage/quality-types";
import { DataQualityResults, ImportQualityTable, QualityFindingsTable } from "./data-quality-dashboard";

const render = renderToStaticMarkup;
const headers = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity", "Extra <column>"];
const csv = (columns: string[], rows: string[][]) => [columns, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";

async function input(contents: string, name: string) {
  const file = new File([contents], name, { type: "text/csv", lastModified: 1_700_000_000_000 });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { file: { name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) };
}

function database(context: TestContext) {
  const db = createArchiveDatabase(`stocky-quality-ui-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
  context.after(async () => { db.close(); await db.delete(); });
  return db;
}

async function fixture(context: TestContext) {
  const db = database(context);
  const duplicate = ["provisional", "PO-1", "L1", "00123", "Supplier", "2026-01-01", "USD", "0", "0", "0", "<script>source-only</script>"];
  const sparse = ["provisional", "PO-2", "L2", "00124", "", "02/30/2026", "", "", "", "", ""];
  await saveImport(db, await input(csv(headers, [duplicate, duplicate, sparse]), "lines<script>.csv"));
  await saveImport(db, await input("Unsupported,Description\n1,Unmapped source\n", "unsupported.csv"));
  return { db, snapshot: await queryDataQuality(db) };
}

test("per-file quality shows distinct affected-record counts alongside parsed and mapped coverage", async (context) => {
  const { snapshot } = await fixture(context);
  const file = snapshot.files.find((entry) => entry.fileName === "lines<script>.csv")!;
  assert.equal(file.totalRows, 3);
  assert.equal(file.analyzedRecords, 3);
  assert.equal(file.affectedRecordCount, 3);
  assert.equal(file.categoryRecordCounts.incomplete, 1);
  assert.equal(file.categoryRecordCounts["exact-duplicate"], 2);
  assert.equal(file.categoryRecordCounts["invalid-date"], 1);
  const html = render(createElement(ImportQualityTable, { snapshot }));
  assert.match(html, /aria-label="Import quality by file"/);
  assert.match(html, /role="region" aria-label="Import quality table scroll area" tabindex="0"/);
  assert.match(html, /Mapped records checked/);
  assert.match(html, /Records with findings/);
  assert.match(html, /lines&lt;script&gt;\.csv/);
  assert.match(html, /Extra &lt;column&gt;/);
  assert.match(html, /Mapping: matched/);
  assert.match(html, /Mapping: unknown/);
  assert.match(html, /Diagnostic totals count messages, not affected records/);
  assert.match(html, /no supported field mapping/);
  assert.doesNotMatch(html, /<script>/);
  const body = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)![1];
  const row = Array.from(body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g), (match) => match[1]).find((entry) => entry.includes("lines&lt;script&gt;.csv"))!;
  const numericCells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g), (match) => match[1]).slice(1);
  assert.deepEqual(numericCells, ["3", "3", "3", "1", "2", "1", "0", String(file.findingCount)]);
});

test("exact duplicate findings preserve both original row locations and separate evidence disclosures", async (context) => {
  const { snapshot } = await fixture(context);
  const findings = snapshot.findings.filter((finding) => finding.category === "exact-duplicate");
  assert.equal(findings.length, 2);
  assert.equal(new Set(findings.map((finding) => finding.sourceReferenceId)).size, 2);
  const html = render(createElement(QualityFindingsTable, { snapshot, findings }));
  assert.equal((html.match(/>Exact duplicate records<\/p>/g) ?? []).length, 2);
  assert.equal((html.match(/>View source evidence<\/summary>/g) ?? []).length, 2);
  assert.match(html, /Data row 1 · CSV record 2/);
  assert.match(html, /Data row 2 · CSV record 3/);
  assert.match(html, /Records remain separate/);
  assert.match(html, /not proof that a business order was duplicated/);
  // Evidence is mounted only when a disclosure opens, even for large groups.
  assert.doesNotMatch(html, /source-only|Original CSV record|<script>/);
});

test("findings escape imported descriptions and distinguish missing row references from retained evidence", async (context) => {
  const { snapshot } = await fixture(context);
  const incomplete = snapshot.findings.find((finding) => finding.category === "incomplete")!;
  assert.equal(incomplete.dataRowNumber, 3);
  assert.ok(snapshot.sources.some((source) => source.sourceReferenceId === incomplete.sourceReferenceId));
  const withoutSource: DataQualityFinding = {
    id: "file-diagnostic", category: "schema-issue", severity: "warning", importId: incomplete.importId,
    fileName: "<img src=x onerror=alert(1)>.csv", message: "<svg onload=alert(1)> & quoted \"source\"", fields: [], columns: [],
  };
  const html = render(createElement(QualityFindingsTable, { snapshot, findings: [incomplete, withoutSource] }));
  assert.match(html, /History fields are unavailable/);
  assert.match(html, /Data row 3 · CSV record 4/);
  assert.match(html, /View source evidence/);
  assert.match(html, /File-level finding/);
  assert.match(html, /No row-level source was retained for this finding/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.csv/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt; &amp; quoted &quot;source&quot;/);
  assert.doesNotMatch(html, /<img|<svg onload|<script>/);
});

test("empty and unsupported archives show coverage limits without declaring complete data", async (context) => {
  const db = database(context);
  const empty = render(createElement(DataQualityResults, { snapshot: await queryDataQuality(db) }));
  assert.match(empty, /No saved imports/);
  assert.match(empty, /No record quality has been assessed yet/);
  assert.match(empty, /href="\/import"/);
  await saveImport(db, await input("Unsupported,Description\n1,Unmapped source\n", "unsupported.csv"));
  // An archive without retained diagnostics still has unassessed schema coverage.
  await db.validationIssues.clear();
  const snapshot = await queryDataQuality(db);
  assert.equal(snapshot.findings.length, 0);
  assert.equal(snapshot.files[0].analyzedRecords, 0);
  const html = render(createElement(DataQualityResults, { snapshot }));
  assert.match(html, /unsupported\.csv/);
  assert.match(html, /No matching findings/);
  assert.match(html, /Review file coverage before treating missing findings as evidence of complete data/);
  assert.match(html, /no clean-data conclusion is implied/);
  assert.match(html, /No findings is not proof of complete coverage/);
  assert.match(html, /Filter by file/);
  assert.match(html, /Filter by category/);
  assert.doesNotMatch(html, /All records are valid|Data is complete|No issues found/);
});
