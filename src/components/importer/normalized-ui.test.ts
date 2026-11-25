import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizePurchaseOrderSummaryV1 } from "@/src/lib/stocky/adapters/purchase-order-summary-v1";
import { conflictField, sourceForRecord } from "@/src/lib/stocky/field-values";
import { LINE_ITEM_V1, SUMMARY_V1 } from "@/src/lib/stocky/schemas";
import type { NormalizedField, NormalizedImport, NormalizedRecord } from "@/src/lib/stocky/types";
import { parseFileContents } from "@/src/lib/importer/csv-parser-core";
import { createImportEntries } from "@/src/lib/importer/import-session";
import { DataPreview } from "./data-preview";
import { FileResults } from "./file-results";
import { NormalizedReview } from "./normalized-review";

const headers = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Order Date", "Total Cost", "Ordered Quantity", "Received Quantity", "Notes"];

function summary(rowNumber = 12, supplier = "  Example supplier  ") {
  const values = ["fixture", "PO-001", supplier, "2026-11-21", "00120.500", "5", "2", "Original unmapped note"];
  return normalizePurchaseOrderSummaryV1(sourceForRecord("original-export.csv", rowNumber, rowNumber + 2, headers, values, `${values.join(",")}\n`));
}

function normalized(records: NormalizedRecord[]): NormalizedImport {
  const fieldCounts = { observed: 0, missing: 0, derived: 0, conflicting: 0, invalid: 0 };
  for (const record of records) for (const field of Object.values(record.fields) as NormalizedField<string>[]) fieldCounts[field.state] += 1;
  return {
    schema: { status: "matched", adapter: SUMMARY_V1, unmappedColumns: [{ column: 8, header: "Notes" }] },
    records,
    withheldRecords: [],
    fieldCounts,
  };
}

function render(result: NormalizedImport) {
  return renderToStaticMarkup(createElement(NormalizedReview, { normalized: result }));
}

test("unknown schemas remain unmapped without invented supplier, cost, currency, or date fields", () => {
  const result = normalized([]);
  result.schema = { status: "unknown", reason: "no-match", candidates: [], message: "The original layout is unknown. No fields were mapped." };
  const html = render(result);
  assert.match(html, /No automatic mappings applied/);
  assert.match(html, /The original layout is unknown/);
  assert.doesNotMatch(html, /Unverified provisional fixture|Normalized fields and source evidence|Supplier|Total cost|Currency|Order date/);
});

test("provisional formats show adapter identity, version, and unverified status alongside original evidence", () => {
  const html = render(normalized([summary()]));
  assert.ok(html.includes(SUMMARY_V1.id));
  assert.ok(html.includes(SUMMARY_V1.label));
  assert.match(html, /Version 1/);
  assert.match(html, /purchase-order-summary/);
  assert.match(html, /Unverified provisional fixture/);
  assert.match(html, /has not been verified against a genuine Stocky export/);
  assert.match(html, /original-export\.csv/);
  assert.match(html, /Data row 12/);
  assert.match(html, /CSV record 14/);
  assert.match(html, /Column 5/);
  assert.match(html, /Original header:[\s\S]*?Total Cost/);
  assert.match(html, />120\.5<\/div>/);
  assert.match(html, />00120\.500<\/pre>/);
  assert.match(html, />  Example supplier  <\/pre>/);
  assert.match(html, /1 additional column is preserved/);
  assert.match(html, /Original unmapped note/);
  assert.match(html, /Derived by rule:[\s\S]*?ordered-minus-received\/v1/);
});

test("missing and invalid values remain explicit with no replacement values", () => {
  const record = summary();
  record.fields.supplier = { state: "missing", value: null, sources: [], reason: "column-absent" };
  record.fields.orderDate = { state: "invalid", value: null, reason: "The date format is ambiguous.", sources: [record.source.cells[3]] };
  const html = render(normalized([record]));
  assert.match(html, /This column is not in the file/);
  assert.match(html, /Nothing has been filled in/);
  assert.match(html, />Not provided<\/span>/);
  assert.match(html, /The date format is ambiguous/);
  assert.match(html, />Not normalized<\/span>/);
  assert.match(html, />Missing<\/span>/);
  assert.match(html, />Invalid<\/span>/);
});

test("conflicting values provide navigation to every alternative without selecting a winner or executing CSV content", () => {
  const first = summary(1, '<script>alert("first")</script>');
  const second = summary(2, "Different supplier");
  const conflict = conflictField([first.fields.supplier, second.fields.supplier]);
  assert.ok(conflict);
  first.fields.supplier = conflict;
  const html = render(normalized([first]));
  assert.match(html, /Conflicting values/);
  assert.match(html, /no value selected/);
  assert.match(html, /Alternative 1: &lt;script&gt;alert\(&quot;first&quot;\)&lt;\/script&gt;/);
  assert.match(html, /1 of 2/);
  assert.match(html, /aria-label="Next conflicting alternative"/);
  assert.match(html, /aria-label="Go to conflicting alternative"/);
  assert.doesNotMatch(html, /Alternative 2: Different supplier/);
  assert.match(html, /Data row 1/);
  assert.match(html, /No value has been chosen/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("thousands of conflicting alternatives have a bounded initial DOM and remain reachable by jump controls", () => {
  const record = summary();
  const alternatives = Array.from({ length: 3000 }, (_, index) => ({
    value: `Competing supplier ${index + 1}`,
    sources: [{ ...record.source.cells[2], rowNumber: index + 1, recordNumber: index + 2, rawValue: `Competing supplier ${index + 1}` }],
  }));
  record.fields.supplier = {
    state: "conflicting", value: null, reason: "Supplier names differ across records.",
    alternatives, sources: alternatives.flatMap((alternative) => alternative.sources),
  };
  const html = render(normalized([record]));
  assert.match(html, /1 of 3,000/);
  assert.match(html, /<input\b[^>]*type="number"[^>]*max="3000"/);
  assert.match(html, /aria-label="Go to conflicting alternative"/);
  assert.match(html, /Alternative 1: Competing supplier 1/);
  assert.doesNotMatch(html, /Competing supplier 2|Competing supplier 3000|<option\b/);
  assert.equal([...html.matchAll(/Alternative \d+:/g)].length, 1);
  assert.ok(html.length < 35_000, `Expected bounded HTML, received ${html.length} characters`);
});

test("record navigation exposes all normalized records without rendering a large menu or all record tables", () => {
  const records = Array.from({ length: 35 }, (_, index) => summary(index + 1, `Supplier row ${index + 1}`));
  const html = render(normalized(records));
  assert.match(html, /1 of 35/);
  assert.match(html, /aria-label="Next normalized record"/);
  assert.match(html, /<input\b[^>]*type="number"[^>]*max="35"[^>]*name="record"/);
  assert.match(html, /Supplier row 1/);
  assert.doesNotMatch(html, /Supplier row 35|<option\b/);
  assert.equal([...html.matchAll(/<table\b/g)].length, 1);
});

test("withheld records retain the reason and original unsafe CSV as escaped text", () => {
  const result = normalized([]);
  const rawText = 'fixture,PO-001,"unfinished <script>alert(1)</script>\n';
  result.withheldRecords = [{
    source: sourceForRecord("malformed.csv", 18, 19, headers, ["fixture", "PO-001", "unfinished"], rawText),
    reason: "This row has broken quotation marks. Original data is retained without field mappings.",
    issues: [{ severity: "error", category: "parsing", code: "MissingQuotes", message: "A quoted value was not closed." }],
  }];
  const html = render(result);
  assert.match(html, /1 record was kept without normalization/);
  assert.match(html, /broken quotation marks/);
  assert.match(html, /Original data is retained without field mappings/);
  assert.match(html, /Data row 18/);
  assert.match(html, /CSV record 19/);
  assert.match(html, /malformed\.csv/);
  assert.match(html, /fixture,PO-001,&quot;unfinished &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("the actual summary and line-item parsers connect to both raw preview and per-file provisional badges", async () => {
  for (const schema of [SUMMARY_V1, LINE_ITEM_V1]) {
    const text = await readFile(schema.fixturePath, "utf8");
    const file = new File([text], `${schema.kind}.csv`);
    const result = await parseFileContents(file);
    assert.equal(result.normalized.schema.status, "matched");
    const [entry] = createImportEntries([file]);
    const previewHtml = renderToStaticMarkup(createElement(DataPreview, {
      files: [{ id: entry.id, fileName: file.name, result }],
      selectedId: entry.id,
      onSelect: () => undefined,
    }));
    assert.match(previewHtml, /Original values/);
    assert.match(previewHtml, /Normalized review/);
    assert.ok(previewHtml.includes(schema.id));
    assert.match(previewHtml, /Provisional normalized values can be reviewed below/);
    assert.doesNotMatch(previewHtml, /Columns have not been mapped to Stocky fields/);
    const fileHtml = renderToStaticMarkup(createElement(FileResults, {
      entries: [{ ...entry, phase: "complete", result }],
      selectedId: entry.id,
      busy: false,
      onRemove: () => undefined,
      onInspect: () => undefined,
      onClear: () => undefined,
    }));
    assert.ok(fileHtml.includes(schema.label));
    assert.match(fileHtml, /v1 · Unverified fixture/);
    assert.doesNotMatch(fileHtml, /Stocky field mapping unavailable/);
  }
});
