import assert from "node:assert/strict";
import test from "node:test";
import type { OfflineArchive, OfflineField } from "./types";
import { validateOfflineArchive } from "./validate";

const observed = (value: string): OfflineField => ({ state: "observed", value });
const missing = (): OfflineField => ({ state: "missing", value: null });
function archive(): OfflineArchive {
  return {
    version: 1, exportedAt: "2026-11-24T10:00:00.000Z",
    files: [{ id: "file", name: " source<&>.csv ", totalRows: 1, status: "success", coverageNotes: ["Preserved"] }],
    records: [{ id: "__proto__", fileId: "file", kind: "purchase-order-summary", sourceId: "source", fields: {
      purchaseOrderNumber: observed("00001"), supplier: observed(" Café & Co. "), status: missing(), orderDate: observed("2024-02-29"), expectedDate: missing(),
      currency: observed("USD"), totalCost: observed("12345678901234567890.00000000000000001"), orderedQuantity: observed("0"), receivedQuantity: observed("0"), outstandingQuantity: { state: "derived", value: "0" },
    } }],
    sources: [{ id: "source", fileId: "file", dataRowNumber: 1, recordNumber: 2, cells: [{ column: 1, header: "SKU", rawValue: "</script><img src=x onerror=alert(1)>\n00001" }, { column: 2, header: null, rawValue: null }, { column: 3, header: "Empty", rawValue: "" }], rawText: '"</script>","00001"\r\n' }],
    findings: [{ id: "finding", fileId: "file", category: "incomplete", severity: "warning", message: "<b>Original</b>", recordIds: ["__proto__"], sourceIds: ["source"] }],
    qualityNotes: ["No inference"],
  };
}

test("validator preserves exact strings, hostile content, high precision and safe map IDs", () => {
  const original = archive();
  const validated = validateOfflineArchive(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(validated, original);
  assert.equal(validated.records[0].fields.totalCost.value, "12345678901234567890.00000000000000001");
  assert.equal(validated.records[0].fields.supplier.value, " Café & Co. ");
  assert.equal(validated.records[0].id, "__proto__");
  assert.equal(validated.sources[0].cells[2].rawValue, "");
  assert.equal(validated.sources[0].cells[1].rawValue, null);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);
  validated.files[0].coverageNotes.push("Changed copy");
  assert.deepEqual(original.files[0].coverageNotes, ["Preserved"]);
});

test("validator rejects unknown versions, incomplete shapes and unexpected properties with paths", () => {
  assert.throws(() => validateOfflineArchive({ ...archive(), version: 2 }), /archive\.version: unsupported/);
  assert.throws(() => validateOfflineArchive({ ...archive(), records: null }), /archive\.records: expected an array/);
  assert.throws(() => validateOfflineArchive({ ...archive(), unexpected: true }), /archive\.unexpected: unexpected property/);
  const incomplete = archive();
  delete incomplete.records[0].fields.totalCost;
  assert.throws(() => validateOfflineArchive(incomplete), /archive\.records\[0\]\.fields\.totalCost: required/);
  const polluted = JSON.parse(JSON.stringify(archive()));
  polluted.records[0].fields = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateOfflineArchive(polluted), /fields\.__proto__: unexpected/);
});

test("validator rejects numeric monetary values, noncanonical decimals and inconsistent field states", () => {
  for (const value of [1.23, "1.230", "01", "-1", "1e3", "NaN", "", null]) {
    const original = archive() as unknown as { records: Array<{ fields: Record<string, unknown> }> };
    original.records[0].fields.totalCost = { state: "observed", value };
    assert.throws(() => validateOfflineArchive(original), /fields\.totalCost\.value:/);
  }
  for (const state of ["missing", "invalid", "conflicting"]) {
    const original = archive();
    original.records[0].fields.totalCost = { state, value: "2" } as OfflineField;
    assert.throws(() => validateOfflineArchive(original), new RegExp(`${state} fields must have a null value`));
  }
  const derived = archive();
  derived.records[0].fields.totalCost = { state: "derived", value: "1.00001" };
  assert.deepEqual(validateOfflineArchive(derived).records[0].fields.totalCost, { state: "derived", value: "1.00001" });
  const nullDerived = archive();
  nullDerived.records[0].fields.totalCost = { state: "derived", value: null };
  assert.throws(() => validateOfflineArchive(nullDerived), /expected a string/);
});

test("validator checks real dates and explicit export timestamps without guessing formats", () => {
  for (const value of ["2026-02-29", "2026-13-01", "01/02/2026", "2026-1-1", "0000-01-01"]) {
    const original = archive();
    original.records[0].fields.orderDate = observed(value);
    assert.throws(() => validateOfflineArchive(original), /fields\.orderDate\.value: expected a real calendar date/);
  }
  for (const value of ["2026-02-30T00:00:00Z", "2026-11-24T24:00:00Z", "2026-11-24", "today", "2026-11-24T00:00:00"]) {
    assert.throws(() => validateOfflineArchive({ ...archive(), exportedAt: value }), /archive\.exportedAt: expected a valid ISO/);
  }
  assert.equal(validateOfflineArchive({ ...archive(), exportedAt: "2026-11-24T10:00:00+05:30" }).exportedAt, "2026-11-24T10:00:00+05:30");
  const invalidDate = archive();
  invalidDate.records[0].fields.orderDate = { state: "invalid", value: null };
  assert.deepEqual(validateOfflineArchive(invalidDate).records[0].fields.orderDate, { state: "invalid", value: null });
});

test("validator rejects ID collisions and unresolved or cross-file references", () => {
  const duplicate = archive();
  duplicate.records[0].id = "file";
  assert.throws(() => validateOfflineArchive(duplicate), /records\[0\]\.id: duplicate ID/);
  const brokenSource = archive();
  brokenSource.records[0].sourceId = "absent";
  assert.throws(() => validateOfflineArchive(brokenSource), /records\[0\]\.sourceId: references an unknown source/);
  const brokenFinding = archive();
  brokenFinding.findings[0].recordIds = ["absent"];
  assert.throws(() => validateOfflineArchive(brokenFinding), /findings\[0\]\.recordIds\[0\]: references an unknown record/);
  const crossFile = archive();
  crossFile.files.push({ ...crossFile.files[0], id: "other" });
  crossFile.sources[0].fileId = "other";
  assert.throws(() => validateOfflineArchive(crossFile), /source belongs to a different file/);
  const crossFinding = archive();
  crossFinding.files.push({ ...crossFinding.files[0], id: "other" });
  crossFinding.findings[0].fileId = "other";
  assert.throws(() => validateOfflineArchive(crossFinding), /record belongs to a different file/);
  const repeatedReference = archive();
  repeatedReference.findings[0].sourceIds = ["source", "source"];
  assert.throws(() => validateOfflineArchive(repeatedReference), /sourceIds: references must not repeat/);
});

test("validator permits source-free file findings while validating row and column positions", () => {
  const original = archive();
  original.findings[0].recordIds = [];
  original.findings[0].sourceIds = [];
  assert.deepEqual(validateOfflineArchive(original).findings[0].sourceIds, []);
  const invalidRow = archive();
  invalidRow.sources[0].dataRowNumber = 2;
  assert.throws(() => validateOfflineArchive(invalidRow), /dataRowNumber: exceeds/);
  const duplicateColumn = archive();
  duplicateColumn.sources[0].cells[1].column = 1;
  assert.throws(() => validateOfflineArchive(duplicateColumn), /column: duplicate source column/);
  const headerReference = archive();
  headerReference.sources[0].dataRowNumber = null;
  assert.throws(() => validateOfflineArchive(headerReference), /sourceId: a normalized record must reference a data row/);
});
