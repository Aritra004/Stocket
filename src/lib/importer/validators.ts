import { z } from "zod";
import type { ParseError } from "papaparse";
import type { CsvImportResult, ValidationIssue } from "./types";
import { createNormalizedImport } from "../stocky/normalize";
import { detectStockySchema } from "../stocky/schemas";

export const PREVIEW_LIMIT = 10;
export const ISSUE_DETAIL_LIMIT = 100;

// These schemas validate CSV structure, not a presumed Stocky export schema.
// Never coerce or transform imported strings.
export const fileMetadataSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.string(),
});

export const csvHeaderSchema = z.array(z.string()).min(1);

export function createImportResult(file: Pick<File, "name" | "size">): CsvImportResult {
  return {
    fileName: file.name,
    fileSize: file.size,
    columns: [],
    totalRows: 0,
    preview: [],
    recordsWithIssues: [],
    skippedEmptyLines: 0,
    info: [],
    warnings: [],
    errors: [],
    warningCount: 0,
    errorCount: 0,
    infoCount: 0,
    status: "success",
    delimiter: null,
    parsingMode: null,
    stockyValidation: "not-validated",
    normalized: createNormalizedImport(),
  };
}

export function addIssue(result: CsvImportResult, issue: ValidationIssue): void {
  const issues = issue.severity === "error" ? result.errors : issue.severity === "warning" ? result.warnings : result.info;
  if (issue.severity === "error") result.errorCount += 1;
  else if (issue.severity === "warning") result.warningCount += 1;
  else result.infoCount += 1;
  if (issues.length < ISSUE_DETAIL_LIMIT) issues.push(issue);
}

export function finalizeResult(result: CsvImportResult): CsvImportResult {
  if (result.status !== "unsupported") {
    result.status = result.errorCount ? "error" : result.warningCount ? "warning" : "success";
  }
  return result;
}

/** Extension is authoritative: browsers supply inconsistent or empty CSV MIME types. */
export function validateFile(file: File): CsvImportResult {
  const result = createImportResult(file);
  let validMetadata = false;
  try {
    validMetadata = fileMetadataSchema.safeParse({ name: file.name, size: file.size, type: file.type }).success;
  } catch {
    // Metadata access can fail independently of reading file contents.
  }
  if (!validMetadata) {
    addIssue(result, { severity: "error", category: "file", code: "InvalidFile", message: "This file's name or size could not be read. Select the file again." });
  } else if (!/\.(csv|tsv)$/i.test(file.name)) {
    result.status = "unsupported";
    addIssue(result, { severity: "error", category: "file", code: "UnsupportedFileType", message: "Choose a .csv or .tsv text file. Spreadsheets and other file formats are not supported." });
  } else if (file.size === 0) {
    addIssue(result, { severity: "error", category: "file", code: "EmptyFile", message: "This file is empty. Choose an export containing column names and records." });
  }
  return finalizeResult(result);
}

export function validateHeaders(columns: string[], report: (issue: ValidationIssue) => void): void {
  if (!csvHeaderSchema.safeParse(columns).success || columns.every((column) => column.trim() === "")) {
    report({ severity: "error", category: "structure", code: "MissingHeader", message: "The first record has no column names. No names have been added; the original record is kept for review.", row: 1 });
  }

  const seen = new Set<string>();
  columns.forEach((name, index) => {
    if (name.trim() === "") {
      report({ severity: "warning", category: "structure", code: "EmptyHeader", message: `Column ${index + 1} has no name. Its values are kept in their original position.`, row: 1, column: index + 1 });
    } else if (seen.has(name)) {
      report({ severity: "warning", category: "structure", code: "DuplicateHeader", message: `Column ${index + 1} repeats an earlier column name. Both columns and all their values are kept separately.`, row: 1, column: index + 1 });
    }
    seen.add(name);
  });
}

export function validateRow(values: string[], expectedCount: number, row: number, report: (issue: ValidationIssue) => void): void {
  if (values.length === expectedCount) return;
  report({
    severity: "warning",
    category: "structure",
    code: "FieldCountMismatch",
    message: `This record has ${values.length} values, but the header has ${expectedCount} columns. ${values.length < expectedCount ? "Missing values have not been filled in." : "Extra values have not been removed."} The original record is kept for review.`,
    row,
  });
}

/** Friendly messages replace library jargon, while codes remain available to callers. */
export function toParsingIssue(error: Pick<ParseError, "code">, row?: number): ValidationIssue {
  if (error.code === "UndetectableDelimiter") {
    return { severity: "warning", category: "parsing", code: error.code, message: "We could not confidently identify the column separator, so commas were used. Check that the preview matches your file." };
  }
  return {
    severity: "error",
    category: "parsing",
    code: error.code,
    message: error.code === "MissingQuotes"
      ? "A quoted value is missing its closing quotation mark. Later lines may have been read as part of this value. Review the original record before using it."
      : error.code === "InvalidQuotes"
        ? "The quotation marks in this record are not arranged correctly. Review the original record before using it."
        : "This record could not be read reliably. Its original text is kept for review.",
    ...(row === undefined ? {} : { row }),
  };
}

/** Papa tolerates quotes within unquoted fields. Flag them without rewriting data. */
export function validateQuoteSyntax(raw: string, delimiter: string, linebreak: string, row: number, report: (issue: ValidationIssue) => void): void {
  if (!delimiter || !linebreak) return;
  const record = raw.endsWith(linebreak) ? raw.slice(0, -linebreak.length) : raw;
  let state: "start" | "unquoted" | "quoted" | "closed" = "start";
  let column = 1;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (state === "quoted") {
      if (character === '"') {
        if (record[index + 1] === '"') index += 1;
        else state = "closed";
      }
      continue;
    }
    if (record.startsWith(delimiter, index)) {
      state = "start";
      column += 1;
      index += delimiter.length - 1;
    } else if (character === '"' && state === "start") {
      state = "quoted";
    } else if (character === '"' && state === "unquoted") {
      report({ severity: "error", category: "parsing", code: "UnexpectedQuote", message: "A quotation mark appears inside a value that is not quoted. The original value has been kept; review this record before using it.", row, column });
      return;
    } else if (state === "start") {
      state = "unquoted";
    }
    // Missing/invalid closing quotes are reported by Papa. Do not guess recovery.
  }
}

/** Only exact, versioned fixture contracts are currently supported, always unverified. */
export function assessStockySchema(result: CsvImportResult, malformedHeader = false): void {
  if (!csvHeaderSchema.safeParse(result.columns).success) return;
  const schema = detectStockySchema(result.columns, malformedHeader);
  result.normalized.schema = schema;
  result.stockyValidation = schema.status === "matched" ? "provisional" : "unsupported";
  if (schema.status === "matched") {
    addIssue(result, {
      severity: "info", category: "schema", code: "ProvisionalStockySchema",
      message: `Matched ${schema.adapter.label}, version ${schema.adapter.version}. This is an unverified synthetic fixture format, not a verified Stocky export. Review the normalized values and their sources before using them.`,
    });
    return;
  }
  addIssue(result, {
    severity: "info", category: "schema", code: "UnsupportedStockySchema",
    message: schema.status === "unknown" ? schema.message : "No column format was detected. No field mappings were applied.",
  });
}

export function unexpectedFailureResult(file: Pick<File, "name" | "size">): CsvImportResult {
  const result = createImportResult(file);
  addIssue(result, { severity: "error", category: "file", code: "ImportFailed", message: "This file could not be processed. Other files can still be imported. Remove this file and select it again to retry." });
  return finalizeResult(result);
}
