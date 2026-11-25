import assert from "node:assert/strict";
import test from "node:test";
import { conflictField, deriveOutstanding, readCurrency, readDate, readDecimal, readText, sourceForRecord } from "./field-values";

const source = (value: string, header = "Value", row = 1) =>
  sourceForRecord("original.csv", row, row + 1, [header], [value], `"${value}"\r\n`);

test("source provenance retains exact values, raw CSV, column positions, missing cells, and extra columns", () => {
  const headers = ["SKU", "Notes", "Currency"];
  const values = ["0001", "  original, text  "];
  const raw = '0001,"  original, text  "\r\n';
  const record = sourceForRecord("orders.csv", 4, 7, headers, values, raw);
  assert.deepEqual(record.values, values);
  assert.equal(record.rawText, raw);
  assert.deepEqual(record.cells[1], { fileName: "orders.csv", rowNumber: 4, recordNumber: 7, column: 2, header: "Notes", rawValue: "  original, text  " });
  assert.equal(record.cells[2].rawValue, null);
  assert.equal(record.cells[2].column, 3);
  const extra = sourceForRecord("orders.csv", 1, 2, ["SKU"], ["0001", "extra"], "0001,extra");
  assert.deepEqual(extra.cells[1], { fileName: "orders.csv", rowNumber: 1, recordNumber: 2, column: 2, header: null, rawValue: "extra" });
  assert.deepEqual(headers, ["SKU", "Notes", "Currency"]);
  assert.deepEqual(values, ["0001", "  original, text  "]);
});

test("text stays unchanged and missing columns, cells, and blank values remain distinct", () => {
  const record = sourceForRecord("orders.csv", 1, 2, ["SKU", "Blank", "Absent"], [" 0001 ", " \t "], '" 0001 "," \t "');
  assert.equal(readText(record, "SKU").value, " 0001 ");
  assert.deepEqual(readText(record, "Supplier"), { state: "missing", value: null, reason: "column-absent", sources: [] });
  const absent = readText(record, "Absent");
  assert.equal(absent.state, "missing");
  if (absent.state === "missing") assert.equal(absent.reason, "cell-absent");
  assert.equal(absent.sources[0].rawValue, null);
  const blank = readText(record, "Blank");
  assert.equal(blank.state, "missing");
  if (blank.state === "missing") assert.equal(blank.reason, "empty-cell");
  assert.equal(blank.sources[0].rawValue, " \t ");
});

test("duplicate exact headers are never resolved by silently choosing the first cell", () => {
  const record = sourceForRecord("orders.csv", 1, 2, ["SKU", "SKU"], ["001", "002"], "001,002");
  const value = readText(record, "SKU");
  assert.equal(value.state, "invalid");
  assert.equal(value.value, null);
  assert.deepEqual(value.sources.map((cell) => cell.rawValue), ["001", "002"]);
});

test("decimal normalization is exact even beyond floating-point precision", () => {
  const raw = "0009007199254740993123456789.123456789000";
  const field = readDecimal(source(raw), "Value");
  assert.equal(field.state, "observed");
  assert.equal(field.value, "9007199254740993123456789.123456789");
  assert.equal(field.sources[0].rawValue, raw);
  assert.equal(readDecimal(source("000.0000"), "Value").value, "0");
  assert.equal(readDecimal(source("0.00010"), "Value").value, "0.0001");
});

test("ambiguous money and numeric formats are invalid instead of guessed", () => {
  for (const raw of ["1,234.50", "12,50", "$12.50", "1e3", "+1", "-1", ".5", "1.", " 1.00 ", "NaN", "Infinity", "１２.５"]) {
    const field = readDecimal(source(raw), "Value");
    assert.equal(field.state, "invalid", raw);
    assert.equal(field.value, null);
    assert.equal(field.sources[0].rawValue, raw);
  }
  assert.equal(readDecimal(source(""), "Value").state, "missing");
});

test("dates require real YYYY-MM-DD calendar values without locale or timezone inference", () => {
  for (const raw of ["2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"]) {
    assert.equal(readDate(source(raw), "Value").value, raw);
  }
  for (const raw of ["1900-02-29", "2025-02-29", "2026-04-31", "0000-01-01", "2026-00-01", "2026-01-00", "2026-13-01", "2026-1-02", "01/02/2026", "2026-01-02T00:00:00Z", " 2026-01-02 "]) {
    const field = readDate(source(raw), "Value");
    assert.equal(field.state, "invalid", raw);
    assert.equal(field.sources[0].rawValue, raw);
  }
});

test("currency uses only an explicitly provided uppercase three-letter literal", () => {
  assert.equal(readCurrency(source("USD"), "Value").value, "USD");
  // Syntax acceptance is not an assertion of ISO assignment or geographic identity.
  assert.equal(readCurrency(source("XYZ"), "Value").value, "XYZ");
  for (const raw of ["usd", "$", "US$", "US", "USDT", " USD ", "840"]) {
    const field = readCurrency(source(raw), "Value");
    assert.equal(field.state, "invalid", raw);
    assert.equal(field.value, null);
    assert.equal(field.sources[0].rawValue, raw);
  }
  assert.equal(readCurrency(source(""), "Value").state, "missing");
});

test("outstanding quantity derives exact decimal subtraction with both sources and a versioned rule", () => {
  const ordered = readDecimal(source("9007199254740993123456789.30", "Ordered", 3), "Ordered");
  const received = readDecimal(source("9007199254740993123456789.10", "Received", 3), "Received");
  const outstanding = deriveOutstanding(ordered, received);
  assert.equal(outstanding.state, "derived");
  assert.equal(outstanding.value, "0.2");
  if (outstanding.state === "derived") assert.equal(outstanding.rule, "ordered-minus-received/v1");
  assert.deepEqual(outstanding.sources.map((cell) => cell.header), ["Ordered", "Received"]);
  assert.deepEqual(outstanding.sources.map((cell) => cell.rawValue), ["9007199254740993123456789.30", "9007199254740993123456789.10"]);
  assert.equal(deriveOutstanding(readDecimal(source("0.3"), "Value"), readDecimal(source("0.1"), "Value")).value, "0.2");
  assert.equal(deriveOutstanding(readDecimal(source("1.0"), "Value"), readDecimal(source("1.00"), "Value")).value, "0");
});

test("missing or unusable quantities never create assumed outstanding values", () => {
  const ordered = readDecimal(source("2"), "Value");
  assert.equal(deriveOutstanding(ordered, readDecimal(source(""), "Value")).state, "missing");
  const invalid = deriveOutstanding(ordered, readDecimal(source("bad"), "Value"));
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.value, null);
  const overReceived = deriveOutstanding(ordered, readDecimal(source("3"), "Value"));
  assert.equal(overReceived.state, "invalid");
  assert.equal(overReceived.value, null);
  assert.equal(overReceived.sources[1].rawValue, "3");
});

test("conflicting observations retain alternatives and their provenance without choosing a value", () => {
  const first = readText(source("Supplier A", "Supplier", 1), "Supplier");
  const repeat = readText(source("Supplier A", "Supplier", 2), "Supplier");
  const different = readText(source("Supplier B", "Supplier", 3), "Supplier");
  const missing = readText(source("", "Supplier", 4), "Supplier");
  const conflict = conflictField([first, repeat, different, missing]);
  assert.equal(conflict?.state, "conflicting");
  assert.equal(conflict?.value, null);
  if (conflict?.state === "conflicting") {
    assert.deepEqual(conflict.alternatives.map((entry) => entry.value), ["Supplier A", "Supplier B"]);
    assert.deepEqual(conflict.alternatives[0].sources.map((cell) => cell.rowNumber), [1, 2]);
    assert.deepEqual(conflict.sources.map((cell) => cell.rowNumber), [1, 2, 3]);
  }
  assert.equal(missing.state, "missing");
  assert.equal(first.state, "observed");
});

test("equivalent exact quantities and absent or invalid observations do not invent conflicts", () => {
  const first = readDecimal(source("01.00"), "Value");
  const same = readDecimal(source("1.0"), "Value");
  const invalid = readDecimal(source("1,00"), "Value");
  const missing = readDecimal(source(""), "Value");
  assert.equal(conflictField([first, same, invalid, missing]), null);
  assert.equal(conflictField([missing, invalid]), null);
  assert.equal(conflictField([]), null);
});

test("large repeated-value groups retain every source without modifying observations", () => {
  const repeatCount = 20_000;
  const observations = Array.from({ length: repeatCount }, (_, index) =>
    readText(source("Supplier A", "Supplier", index + 1), "Supplier"));
  assert.equal(conflictField(observations), null);
  const different = readText(source("Supplier B", "Supplier", repeatCount + 1), "Supplier");
  const conflict = conflictField([...observations, different]);
  assert.equal(conflict?.state, "conflicting");
  if (conflict?.state !== "conflicting") return;
  assert.equal(conflict.alternatives.length, 2);
  assert.equal(conflict.alternatives[0].sources.length, repeatCount);
  assert.equal(conflict.sources.length, repeatCount + 1);
  for (let index = 0; index < repeatCount; index += 1) {
    assert.equal(conflict.alternatives[0].sources[index], observations[index].sources[0]);
    assert.equal(observations[index].sources.length, 1);
    assert.equal(observations[index].state, "observed");
  }
  assert.equal(conflict.alternatives[1].sources[0], different.sources[0]);
  assert.equal(different.sources.length, 1);
});
