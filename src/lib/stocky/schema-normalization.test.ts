import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseFileContents } from "../importer/csv-parser-core";
import { detectStockySchema, LINE_ITEM_V1, SUMMARY_V1 } from "./schemas";
import type { NormalizedRecord } from "./types";

const summaryMarker = "__stocky_rescue_po_summary_v1";
const lineMarker = "__stocky_rescue_po_line_item_v1";

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvText(headers: string[], rows: string[][]) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function parse(text: string, name = "fixture.csv") {
  return parseFileContents(new File([text], name, { type: "text/csv" }));
}

function summary(record: NormalizedRecord) {
  assert.equal(record.kind, "purchase-order-summary");
  if (record.kind !== "purchase-order-summary") throw new Error("Expected a summary record");
  return record;
}

function lineItem(record: NormalizedRecord) {
  assert.equal(record.kind, "purchase-order-line-item");
  if (record.kind !== "purchase-order-line-item") throw new Error("Expected a line-item record");
  return record;
}

test("the checked-in summary fixture normalizes with an explicitly unverified version", async () => {
  const text = await readFile(new URL("./fixtures/provisional-po-summaries-v1.csv", import.meta.url), "utf8");
  const result = await parse(text, "summary-export.csv");
  assert.equal(result.stockyValidation, "provisional");
  assert.equal(result.normalized.schema.status, "matched");
  if (result.normalized.schema.status !== "matched") return;
  assert.equal(result.normalized.schema.adapter.id, SUMMARY_V1.id);
  assert.equal(result.normalized.schema.adapter.version, 1);
  assert.equal(result.normalized.schema.adapter.verification, "unverified");
  assert.equal(result.normalized.records.length, 2);
  const first = summary(result.normalized.records[0]);
  assert.equal(first.fields.purchaseOrderNumber.value, "PO-DEMO-001");
  assert.equal(first.fields.supplier.value, "Sample Supplier, A");
  assert.equal(first.fields.orderDate.value, "2026-01-15");
  assert.equal(first.fields.totalCost.value, "125.5");
  assert.equal(first.fields.outstandingQuantity.state, "derived");
  assert.equal(first.fields.outstandingQuantity.value, "6");
  assert.deepEqual(first.fields.totalCost.sources, [{
    fileName: "summary-export.csv", rowNumber: 1, recordNumber: 2,
    column: 8, header: "Total Cost", rawValue: "125.50",
  }]);
  assert.equal(first.source.values[7], "125.50");
  assert.equal(first.source.cells[10].rawValue, "Synthetic example only");
  assert.deepEqual(result.normalized.schema.unmappedColumns, [{ column: 11, header: "Unmapped note" }]);
  assert.deepEqual(result.normalized.fieldCounts, { missing: 7, observed: 12, derived: 1, conflicting: 0, invalid: 0 });
  assert.ok([...result.info, ...result.warnings].some((issue) => issue.category === "schema" && /unverified|provisional/i.test(issue.message)));
});

test("the checked-in line-item fixture uses its own adapter without inventing missing fields", async () => {
  const text = await readFile(new URL("./fixtures/provisional-po-line-items-v1.csv", import.meta.url), "utf8");
  const result = await parse(text, "lines-export.csv");
  assert.equal(result.stockyValidation, "provisional");
  assert.equal(result.normalized.records.length, 2);
  const first = lineItem(result.normalized.records[0]);
  assert.equal(first.adapterId, LINE_ITEM_V1.id);
  assert.equal(first.fields.lineId.value, "LINE-DEMO-001");
  assert.equal(first.fields.sku.value, "SKU-DEMO-001");
  assert.equal(first.fields.unitCost.value, "12.55");
  assert.equal(first.fields.outstandingQuantity.value, "6");
  const second = lineItem(result.normalized.records[1]);
  for (const field of [second.fields.sku, second.fields.supplier, second.fields.orderDate, second.fields.unitCost]) {
    assert.equal(field.state, "missing");
    assert.equal(field.value, null);
    assert.equal(field.sources[0].rawValue, "");
  }
  assert.equal(second.fields.supplier.sources[0].rowNumber, 2);
  assert.equal(second.fields.outstandingQuantity.value, "2");
});

test("required header sets match in a different column order with exact source positions", async () => {
  const headers = ["Supplier", "PO Number", summaryMarker, "Currency"];
  const detection = detectStockySchema(headers);
  assert.equal(detection.status, "matched");
  const result = await parse(csvText(headers, [["  Supplier, Inc  ", "0007", "provisional", "USD"]]));
  const record = summary(result.normalized.records[0]);
  assert.equal(record.fields.purchaseOrderNumber.value, "0007");
  assert.equal(record.fields.supplier.value, "  Supplier, Inc  ");
  assert.equal(record.fields.supplier.sources[0].column, 1);
  assert.equal(record.fields.purchaseOrderNumber.sources[0].column, 2);
  assert.deepEqual(record.source.values, ["  Supplier, Inc  ", "0007", "provisional", "USD"]);
});

test("generic purchase-order headers are unsupported without a fixture marker", async () => {
  const result = await parse(csvText(["PO Number", "Supplier", "SKU", "Unit Cost"], [["PO-1", "Supplier A", "00123", "1.00"]]));
  assert.equal(result.stockyValidation, "unsupported");
  assert.equal(result.status, "success");
  assert.equal(result.normalized.schema.status, "unknown");
  assert.equal(result.normalized.records.length, 0);
  assert.equal(result.preview[0].values[2], "00123");
});

test("unregistered versions and incomplete required sets are never mapped", () => {
  for (const headers of [
    ["__stocky_rescue_po_summary_v2", "PO Number"],
    [summaryMarker, "Supplier"],
    [lineMarker, "PO Number", "SKU"],
    [lineMarker, "PO Number", "Line ID"],
    [summaryMarker, "po number"],
    [summaryMarker, " PO Number "],
  ]) {
    const detection = detectStockySchema(headers);
    assert.equal(detection.status, "unknown");
    if (detection.status === "unknown") assert.equal(detection.reason, "no-match");
  }
});

test("duplicate required or optional mapped headers stop normalization", async () => {
  for (const duplicate of ["PO Number", "Supplier", summaryMarker]) {
    const headers = [summaryMarker, "PO Number", "Supplier", duplicate];
    const detection = detectStockySchema(headers);
    assert.equal(detection.status, "unknown");
    if (detection.status === "unknown") assert.equal(detection.reason, "duplicate-mapped-header");
    const result = await parse(csvText(headers, [["provisional", "PO-1", "A", "B"]]));
    assert.equal(result.normalized.records.length, 0);
    assert.equal(result.stockyValidation, "unsupported");
    assert.equal(result.preview[0].values.length, 4);
  }
});

test("both complete contracts produce an ambiguous result without precedence", async () => {
  const headers = [summaryMarker, lineMarker, "PO Number", "Line ID", "SKU"];
  const detection = detectStockySchema(headers);
  assert.equal(detection.status, "unknown");
  if (detection.status !== "unknown") return;
  assert.equal(detection.reason, "ambiguous");
  assert.deepEqual(new Set(detection.candidates), new Set([SUMMARY_V1.id, LINE_ITEM_V1.id]));
  const result = await parse(csvText(headers, [["provisional", "provisional", "PO-1", "L1", "00123"]]));
  assert.equal(result.normalized.records.length, 0);
  assert.equal(result.stockyValidation, "unsupported");
});

test("a malformed header prevents mapping even when its recovered required names match", async () => {
  const detection = detectStockySchema([summaryMarker, "PO Number"], true);
  assert.equal(detection.status, "unknown");
  if (detection.status === "unknown") assert.equal(detection.reason, "malformed-header");
  const rawHeader = `${summaryMarker},PO Number,Notes"invalid\n`;
  const result = await parse(`${rawHeader}provisional,PO-1,retained\n`);
  assert.equal(result.normalized.schema.status, "unknown");
  if (result.normalized.schema.status === "unknown") assert.equal(result.normalized.schema.reason, "malformed-header");
  assert.equal(result.normalized.records.length, 0);
  assert.equal(result.recordsWithIssues[0].rawText, rawHeader);
  assert.deepEqual(result.preview[0].values, ["provisional", "PO-1", "retained"]);
});

test("absent mapped columns are missing, with no guessed sensitive values or fabricated cells", async () => {
  const result = await parse(csvText([summaryMarker, "PO Number"], [["provisional", "PO-1"]]));
  const record = summary(result.normalized.records[0]);
  for (const field of [record.fields.supplier, record.fields.orderDate, record.fields.expectedDate, record.fields.currency, record.fields.totalCost]) {
    assert.equal(field.state, "missing");
    assert.equal(field.value, null);
    assert.deepEqual(field.sources, []);
    if (field.state === "missing") assert.equal(field.reason, "column-absent");
  }
  assert.equal(record.source.cells.length, 2);
  assert.equal(record.fields.outstandingQuantity.state, "missing");
});

test("ambiguous money, currency and dates remain invalid with original source text", async () => {
  const headers = [summaryMarker, "PO Number", "Order Date", "Expected Date", "Currency", "Total Cost"];
  const rows = [
    ["provisional", "PO-1", "01/02/2026", "2026-02-30", "$", "$1,234.50"],
    ["provisional", "PO-2", "2026-01-01T00:00:00Z", "2026-2-3", "usd", "1.234,50"],
  ];
  const result = await parse(csvText(headers, rows));
  assert.equal(result.normalized.records.length, 2);
  result.normalized.records.forEach((record, index) => {
    const fields = summary(record).fields;
    for (const field of [fields.orderDate, fields.expectedDate, fields.currency, fields.totalCost]) {
      assert.equal(field.state, "invalid");
      assert.equal(field.value, null);
    }
    assert.deepEqual(record.source.values, rows[index]);
    assert.equal(fields.totalCost.sources[0].rawValue, rows[index][5]);
  });
  assert.ok(result.normalized.records[0].issues.some((issue) => issue.category === "schema" && issue.row === 2 && issue.column === 6));
});

test("unmapped duplicate, blank and prototype-like columns retain every original value", async () => {
  const headers = [summaryMarker, "PO Number", "Notes", "Notes", "", "__proto__"];
  const values = ["provisional", "PO-1", "first", "second", "blank-header value", "prototype value"];
  const result = await parse(csvText(headers, [values]));
  assert.equal(result.normalized.records.length, 1);
  const record = result.normalized.records[0];
  assert.deepEqual(record.source.values, values);
  assert.deepEqual(record.source.cells.map((cell) => cell.header), headers);
  assert.equal(record.source.cells[3].column, 4);
  assert.equal(result.normalized.schema.status, "matched");
  if (result.normalized.schema.status === "matched") {
    assert.deepEqual(result.normalized.schema.unmappedColumns.map((column) => column.column), [3, 4, 5, 6]);
  }
});

test("normalization keeps all supported rows beyond the ten-row raw preview", async () => {
  const rows = Array.from({ length: 23 }, (_, index) => ["provisional", `PO-${index + 1}`]);
  const result = await parse(csvText([summaryMarker, "PO Number"], rows));
  assert.equal(result.preview.length, 10);
  assert.equal(result.totalRows, 23);
  assert.equal(result.normalized.records.length, 23);
  assert.equal(result.normalized.records[22].source.rowNumber, 23);
  assert.equal(result.normalized.records[22].source.recordNumber, 24);
  assert.equal(result.normalized.records[22].fields.purchaseOrderNumber.value, "PO-23");
});

test("malformed rows are withheld intact while later valid records still normalize", async () => {
  const badQuote = 'provisional,PO-BAD,unquoted"quote\n';
  const shortRow = "provisional,PO-SHORT\n";
  const extraRow = "provisional,PO-EXTRA,Supplier,unexpected\n";
  const result = await parse(`${summaryMarker},PO Number,Supplier\n${badQuote}${shortRow}${extraRow}provisional,PO-GOOD,Safe\n`);
  assert.equal(result.totalRows, 4);
  assert.equal(result.normalized.records.length, 1);
  assert.equal(result.normalized.records[0].fields.purchaseOrderNumber.value, "PO-GOOD");
  assert.equal(result.normalized.withheldRecords.length, 3);
  assert.deepEqual(result.normalized.withheldRecords.map((row) => row.source.rawText), [badQuote, shortRow, extraRow]);
  assert.deepEqual(result.normalized.withheldRecords.map((row) => row.source.rowNumber), [1, 2, 3]);
  assert.deepEqual(result.normalized.withheldRecords.map((row) => row.source.recordNumber), [2, 3, 4]);
  assert.equal(result.normalized.withheldRecords[1].source.cells[2].rawValue, null);
  assert.equal(result.normalized.withheldRecords[2].source.cells[3].header, null);
  assert.equal(result.normalized.withheldRecords[2].source.cells[3].rawValue, "unexpected");
  assert.ok(result.normalized.withheldRecords.every((row) => row.issues.length > 0));
});

test("blank lines and quoted multiline values retain logical record provenance", async () => {
  const rawRecord = 'provisional,PO-1,"First line\nSecond line"\r\n';
  const result = await parse(`\r\n${summaryMarker},PO Number,Supplier\r\n\r\n${rawRecord}`, "multiline.csv");
  const record = summary(result.normalized.records[0]);
  assert.equal(record.source.rawText, rawRecord);
  assert.equal(record.source.rowNumber, 1);
  assert.equal(record.source.recordNumber, 2);
  assert.equal(record.fields.supplier.value, "First line\nSecond line");
  assert.deepEqual(record.fields.supplier.sources, [{ fileName: "multiline.csv", rowNumber: 1, recordNumber: 2, column: 3, header: "Supplier", rawValue: "First line\nSecond line" }]);
});

test("conflicting summaries retain every record and alternative without backfilling missing cells", async () => {
  const result = await parse(csvText([summaryMarker, "PO Number", "Supplier", "Currency", "Total Cost"], [
    ["provisional", "PO-1", "Supplier A", "USD", "10.00"],
    ["provisional", "PO-1", "Supplier B", "EUR", "12.00"],
    ["provisional", "PO-1", "", "", ""],
  ]));
  assert.equal(result.normalized.records.length, 3);
  for (const record of result.normalized.records.slice(0, 2)) {
    const fields = summary(record).fields;
    for (const field of [fields.supplier, fields.currency, fields.totalCost]) {
      assert.equal(field.state, "conflicting");
      assert.equal(field.value, null);
      if (field.state === "conflicting") {
        assert.equal(field.alternatives.length, 2);
        assert.deepEqual(field.alternatives.flatMap((option) => option.sources.map((source) => source.rowNumber)), [1, 2]);
      }
    }
  }
  const last = summary(result.normalized.records[2]);
  assert.equal(last.fields.supplier.state, "missing");
  assert.equal(last.fields.currency.state, "missing");
  assert.equal(last.fields.totalCost.state, "missing");
  assert.equal(last.source.values[2], "");
});

test("equivalent decimal values do not conflict and distinct original spellings are retained", async () => {
  const result = await parse(csvText([summaryMarker, "PO Number", "Total Cost"], [
    ["provisional", "PO-1", "001.00"], ["provisional", "PO-1", "1.0"],
  ]));
  assert.equal(result.normalized.records.length, 2);
  for (const record of result.normalized.records) {
    assert.equal(summary(record).fields.totalCost.state, "observed");
    assert.equal(summary(record).fields.totalCost.value, "1");
  }
  assert.deepEqual(result.normalized.records.map((record) => record.source.values[2]), ["001.00", "1.0"]);
});

test("conflicting quantities invalidate an earlier derived outstanding quantity", async () => {
  const result = await parse(csvText([summaryMarker, "PO Number", "Ordered Quantity", "Received Quantity"], [
    ["provisional", "PO-1", "10", "4"], ["provisional", "PO-1", "12", "4"],
  ]));
  for (const record of result.normalized.records) {
    assert.equal(record.fields.orderedQuantity.state, "conflicting");
    assert.equal(record.fields.outstandingQuantity.state, "invalid");
    assert.equal(record.fields.outstandingQuantity.value, null);
  }
  assert.equal(result.normalized.fieldCounts.derived, 0);
});

test("same line identifiers conflict within a purchase order without merging records", async () => {
  const headers = [lineMarker, "PO Number", "Line ID", "SKU", "Unit Cost", "Ordered Quantity", "Received Quantity"];
  const result = await parse(csvText(headers, [
    ["provisional", "PO-1", "L1", "00123", "1.25", "10", "4"],
    ["provisional", "PO-1", "L1", "00456", "2.50", "12", "4"],
    ["provisional", "PO-2", "L1", "00789", "8.00", "20", "5"],
  ]));
  assert.equal(result.normalized.records.length, 3);
  for (const record of result.normalized.records.slice(0, 2)) {
    const fields = lineItem(record).fields;
    assert.equal(fields.sku.state, "conflicting");
    assert.equal(fields.unitCost.state, "conflicting");
    assert.equal(fields.orderedQuantity.state, "conflicting");
    assert.equal(fields.outstandingQuantity.state, "invalid");
  }
  assert.equal(lineItem(result.normalized.records[2]).fields.sku.state, "observed");
  assert.equal(lineItem(result.normalized.records[2]).fields.outstandingQuantity.value, "15");
});

test("different line IDs retain their own SKU and cost while shared order fields can conflict", async () => {
  const headers = [lineMarker, "PO Number", "Line ID", "SKU", "Supplier", "Currency", "Order Date", "Unit Cost"];
  const result = await parse(csvText(headers, [
    ["provisional", "PO-1", "L1", "SKU-A", "Supplier A", "USD", "2026-01-01", "1"],
    ["provisional", "PO-1", "L2", "SKU-B", "Supplier B", "EUR", "2026-01-02", "2"],
    ["provisional", "PO-1", "L3", "", "", "", "", ""],
  ]));
  for (const record of result.normalized.records.slice(0, 2)) {
    const fields = lineItem(record).fields;
    assert.equal(fields.supplier.state, "conflicting");
    assert.equal(fields.currency.state, "conflicting");
    assert.equal(fields.orderDate.state, "conflicting");
    assert.equal(fields.sku.state, "observed");
    assert.equal(fields.unitCost.state, "observed");
  }
  const missing = lineItem(result.normalized.records[2]).fields;
  assert.equal(missing.supplier.state, "missing");
  assert.equal(missing.sku.state, "missing");
  assert.equal(missing.currency.state, "missing");
});

test("blank order or line identifiers never group unrelated missing identities", async () => {
  const summaries = await parse(csvText([summaryMarker, "PO Number", "Supplier"], [
    ["provisional", "", "A"], ["provisional", "", "B"],
  ]));
  for (const record of summaries.normalized.records) assert.equal(record.fields.supplier.state, "observed");
  const lines = await parse(csvText([lineMarker, "PO Number", "Line ID", "SKU"], [
    ["provisional", "PO-1", "", "A"], ["provisional", "PO-1", "", "B"],
  ]));
  for (const record of lines.normalized.records) assert.equal(lineItem(record).fields.sku.state, "observed");
});

test("identical filenames do not combine contents, records, or conflict evidence", async () => {
  const headers = [summaryMarker, "PO Number", "Supplier"];
  const [first, second] = await Promise.all([
    parse(csvText(headers, [["provisional", "PO-1", "A"]]), "same.csv"),
    parse(csvText(headers, [["provisional", "PO-1", "B"]]), "same.csv"),
  ]);
  assert.notEqual(first, second);
  assert.equal(summary(first.normalized.records[0]).fields.supplier.state, "observed");
  assert.equal(summary(second.normalized.records[0]).fields.supplier.state, "observed");
  assert.equal(summary(first.normalized.records[0]).fields.supplier.value, "A");
  assert.equal(summary(second.normalized.records[0]).fields.supplier.value, "B");
  assert.equal(first.normalized.records[0].source.fileName, "same.csv");
  assert.equal(second.normalized.records[0].source.fileName, "same.csv");
});
