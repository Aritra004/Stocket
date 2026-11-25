import assert from "node:assert/strict";
import test from "node:test";
import { parseFileContents } from "../importer/csv-parser-core";

const header = "__stocky_rescue_po_summary_v1,PO Number,Ordered Quantity,Received Quantity\n";

test("a finalization failure settles the file, retains original records, and allows the next import", { timeout: 3000 }, async (context) => {
  const originalBigInt = globalThis.BigInt;
  let calls = 0;
  const replacement = context.mock.method(globalThis, "BigInt", (value: string | number | bigint | boolean) => {
    calls += 1;
    // Initial row normalization uses three calls. Fail during final derivation.
    if (calls > 3) throw new Error("Simulated arithmetic failure");
    return originalBigInt(value);
  });
  const rawRecord = "provisional,PO-1,10,4\n";
  const result = await parseFileContents(new File([header + rawRecord], "same.csv"));
  replacement.mock.restore();

  assert.equal(result.totalRows, 1);
  assert.equal(result.normalized.records.length, 0);
  assert.equal(result.normalized.withheldRecords.length, 1);
  assert.equal(result.normalized.withheldRecords[0].source.rawText, rawRecord);
  assert.deepEqual(result.normalized.withheldRecords[0].source.values, ["provisional", "PO-1", "10", "4"]);
  assert.ok(result.info.some((issue) => issue.code === "NormalizationFailed"));
  assert.equal(result.errorCount, 0, "normalization failure is distinct from CSV parsing");

  const next = await parseFileContents(new File([header + "provisional,PO-2,5,1\n"], "same.csv"));
  assert.equal(next.normalized.records[0].fields.outstandingQuantity.value, "4");
});

test("large conflict groups share competing evidence without copying it into each dependent field", async () => {
  const rowCount = 2000;
  const rows = Array.from({ length: rowCount }, (_, index) => `provisional,PO-1,${index + 1},0`).join("\n");
  const result = await parseFileContents(new File([header + rows], "conflicts.csv"));
  assert.equal(result.normalized.records.length, rowCount);
  const first = result.normalized.records[0];
  assert.equal(first.fields.orderedQuantity.state, "conflicting");
  assert.equal(first.fields.orderedQuantity.sources.length, rowCount);
  for (const record of result.normalized.records) {
    assert.equal(record.fields.orderedQuantity, first.fields.orderedQuantity);
    assert.equal(record.fields.outstandingQuantity.state, "invalid");
    assert.equal(record.fields.outstandingQuantity.sources.length, 2);
    assert.ok(record.fields.outstandingQuantity.sources.every((source) => source.rowNumber === record.source.rowNumber));
    assert.ok(record.issues.some((issue) => issue.code === "ConflictingNormalizedValue" && issue.row === record.source.recordNumber && issue.column === 3));
  }
});
