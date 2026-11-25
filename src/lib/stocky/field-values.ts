import type {
  CalendarDate,
  DecimalString,
  NormalizedField,
  RecordSource,
  SourceCell,
} from "./types";

/** Preserve the original record and one-based positions, including unmapped cells. */
export function sourceForRecord(
  fileName: string,
  rowNumber: number,
  recordNumber: number,
  headers: string[],
  values: string[],
  rawText: string,
): RecordSource {
  return {
    fileName,
    rowNumber,
    recordNumber,
    values: [...values],
    rawText,
    cells: Array.from({ length: Math.max(headers.length, values.length) }, (_, index) => ({
      fileName,
      rowNumber,
      recordNumber,
      column: index + 1,
      header: headers[index] ?? null,
      rawValue: values[index] ?? null,
    })),
  };
}

/** Exact header matching only; a duplicate can never silently select the first cell. */
export function readText(source: RecordSource, header: string): NormalizedField<string> {
  const sources = source.cells.filter((cell) => cell.header === header);
  if (sources.length === 0) return { state: "missing", value: null, reason: "column-absent", sources };
  if (sources.length > 1) {
    return { state: "invalid", value: null, reason: "More than one source column has this name; no column was chosen.", sources };
  }
  const rawValue = sources[0].rawValue;
  if (rawValue === null) return { state: "missing", value: null, reason: "cell-absent", sources };
  if (rawValue.trim() === "") return { state: "missing", value: null, reason: "empty-cell", sources };
  return { state: "observed", value: rawValue, sources };
}

function convertObserved<T>(
  source: RecordSource,
  header: string,
  convert: (raw: string) => T | null,
  invalidReason: string,
): NormalizedField<T> {
  const field = readText(source, header);
  if (field.state === "missing" || field.state === "invalid") return field;
  // readText creates only missing, invalid, and observed fields.
  if (field.state !== "observed") {
    return { state: "invalid", value: null, sources: field.sources, reason: "This value has no unambiguous source cell." };
  }
  const value = convert(field.value);
  return value === null
    ? { state: "invalid", value: null, reason: invalidReason, sources: field.sources }
    : { state: "observed", value, sources: field.sources };
}

function canonicalDecimal(raw: string): DecimalString | null {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) return null;
  const [integer, fraction = ""] = raw.split(".");
  const whole = integer.replace(/^0+(?=\d)/, "");
  const decimal = fraction.replace(/0+$/, "");
  return (decimal ? `${whole}.${decimal}` : whole) as DecimalString;
}

/** No currency symbols, grouping separators, exponents, or locale inference. */
export function readDecimal(source: RecordSource, header: string): NormalizedField<DecimalString> {
  return convertObserved(source, header, canonicalDecimal,
    "Expected a nonnegative number using digits and an optional decimal point. The original value was not converted.");
}

function calendarDate(raw: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? raw as CalendarDate : null;
}

export function readDate(source: RecordSource, header: string): NormalizedField<CalendarDate> {
  return convertObserved(source, header, calendarDate,
    "Expected a real calendar date written as YYYY-MM-DD. No date format or timezone was guessed.");
}

/** A literal three-letter code, not a claim that it belongs to an ISO currency list. */
export function readCurrency(source: RecordSource, header: string): NormalizedField<string> {
  return convertObserved(source, header, (raw) => /^[A-Z]{3}$/.test(raw) ? raw : null,
    "Expected an explicit three-letter uppercase currency code. No currency was guessed from a symbol or amount.");
}

function scaledInteger(value: DecimalString, scale: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(scale, "0"));
}

/** The only derived quantity: exact subtraction from two explicit source quantities. */
export function deriveOutstanding(
  ordered: NormalizedField<DecimalString>,
  received: NormalizedField<DecimalString>,
): NormalizedField<DecimalString> {
  const sources = [...ordered.sources, ...received.sources];
  const missing = [ordered, received].find((field) => field.state === "missing");
  if (missing?.state === "missing") return { state: "missing", value: null, reason: missing.reason, sources };
  if ((ordered.state !== "observed" && ordered.state !== "derived") ||
      (received.state !== "observed" && received.state !== "derived")) {
    return { state: "invalid", value: null, reason: "Outstanding quantity cannot be calculated from invalid or conflicting quantities.", sources };
  }
  // Validate branded strings defensively if this helper is called outside an adapter.
  const orderedValue = canonicalDecimal(ordered.value);
  const receivedValue = canonicalDecimal(received.value);
  if (orderedValue === null || receivedValue === null) {
    return { state: "invalid", value: null, reason: "Outstanding quantity requires explicit nonnegative quantities.", sources };
  }
  const scale = Math.max(orderedValue.split(".")[1]?.length ?? 0, receivedValue.split(".")[1]?.length ?? 0);
  const difference = scaledInteger(orderedValue, scale) - scaledInteger(receivedValue, scale);
  if (difference < BigInt(0)) {
    return { state: "invalid", value: null, reason: "Received quantity exceeds ordered quantity. No outstanding quantity was assumed.", sources };
  }
  const digits = difference.toString().padStart(scale + 1, "0");
  const exact = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return {
    state: "derived",
    value: canonicalDecimal(exact)!,
    rule: "ordered-minus-received/v1",
    sources,
  };
}

/** Keep all competing known values; missing/invalid observations are never filled in. */
export function conflictField<T>(fields: NormalizedField<T>[]): NormalizedField<T> | null {
  const alternatives = new Map<T, SourceCell[]>();
  for (const field of fields) {
    if (field.state !== "observed" && field.state !== "derived") continue;
    let sources = alternatives.get(field.value);
    if (!sources) {
      sources = [];
      alternatives.set(field.value, sources);
    }
    // Append once per observation; repeated values must not copy the growing group.
    // A loop also avoids argument-count limits for source lists from prior derivations.
    for (const source of field.sources) sources.push(source);
  }
  if (alternatives.size < 2) return null;
  const observations = Array.from(alternatives, ([value, sources]) => ({ value, sources }));
  return {
    state: "conflicting",
    value: null,
    reason: "Different source records provide different values for this field. No value was chosen.",
    alternatives: observations,
    sources: observations.flatMap((observation) => observation.sources),
  };
}
