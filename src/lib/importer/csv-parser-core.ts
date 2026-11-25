import Papa from "papaparse";
import type { CsvImportResult, ParsingMode, ValidationIssue } from "./types";
import { addIssue, assessStockySchema, finalizeResult, PREVIEW_LIMIT, toParsingIssue, validateFile, validateHeaders, validateQuoteSyntax, validateRow } from "./validators";
import { sourceForRecord } from "../stocky/field-values";
import { appendNormalizedRecord, finalizeNormalization } from "../stocky/normalize";

const YIELD_EVERY_RECORDS = 500;
// Permit tabs, newlines, and Papa's record/unit separators; reject binary controls.
const BINARY_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1D\x7F]/;

/** Shared by the browser worker and its cooperative fallback; contains no I/O to a server. */
export async function parseFileContents(
  file: File,
  parsingMode: ParsingMode = "main-thread",
): Promise<CsvImportResult> {
  const result = validateFile(file);
  if (result.errorCount) return result;
  result.parsingMode = parsingMode;

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    addIssue(result, { severity: "error", category: "file", code: "FileReadError", message: "The browser could not read this file. Select it again and retry." });
    return finalizeResult(result);
  }

  let text: string;
  try {
    // Decode once: independently decoding byte chunks can corrupt split UTF-8 characters.
    // Fatal decoding rejects unsupported encodings instead of changing the raw values.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    result.status = "unsupported";
    addIssue(result, { severity: "error", category: "file", code: "UnsupportedEncoding", message: "This file uses an unsupported text encoding. Re-save it as UTF-8 CSV before importing." });
    return result;
  }

  if (BINARY_CONTROLS.test(text)) {
    result.status = "unsupported";
    addIssue(result, { severity: "error", category: "file", code: "BinaryContent", message: "This file contains characters that are not supported in a CSV text export. Choose a UTF-8 CSV file." });
    return result;
  }

  // Papa removes a leading BOM from strings too. Keep cursor offsets in the same
  // coordinate system without trimming any header or cell content.
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (/^[\r\n]*$/.test(text)) {
    result.skippedEmptyLines = (text.match(/\r\n|\r|\n/g) ?? []).length;
    addIssue(result, { severity: "error", category: "file", code: "EmptyFile", message: "This file contains only empty lines, with no column names or records." });
    return finalizeResult(result);
  }

  return new Promise((resolve) => {
    let previousCursor = 0;
    let resumeOffset = 0;
    let parsedRecords = 0;
    let logicalRecord = 0;
    let hasHeader = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (!hasHeader) {
        addIssue(result, { severity: "error", category: "file", code: "EmptyFile", message: "The file contains no column names or records." });
      } else if (result.totalRows === 0) {
        addIssue(result, { severity: "warning", category: "structure", code: "NoDataRows", message: "The file has column names but no data records." });
      }
      if (result.skippedEmptyLines > 0) {
        addIssue(result, { severity: "info", category: "structure", code: "EmptyLinesSkipped", message: `${result.skippedEmptyLines} empty ${result.skippedEmptyLines === 1 ? "line was" : "lines were"} excluded from the row count. Quoted empty values and records containing separators are still included.` });
      }
      try {
        finalizeNormalization(result.normalized);
      } catch {
        // Never leave this file's promise pending or expose partly finalized
        // mappings as reliable. Retain every original record for local review.
        const issue: ValidationIssue = { severity: "warning", category: "schema", code: "NormalizationFailed", message: "The normalized review could not be completed. Original records were kept without mappings; other files can still be imported." };
        for (const record of result.normalized.records) {
          result.normalized.withheldRecords.push({ source: record.source, reason: issue.message, issues: [{ ...issue, row: record.source.recordNumber }] });
        }
        result.normalized.records = [];
        result.normalized.fieldCounts = { missing: 0, observed: 0, derived: 0, conflicting: 0, invalid: 0 };
        addIssue(result, { ...issue, severity: "info" });
      }
      if (result.normalized.schema.status === "matched") {
        const needsReview = result.normalized.fieldCounts.invalid + result.normalized.fieldCounts.conflicting;
        if (needsReview || result.normalized.withheldRecords.length) {
          addIssue(result, { severity: "info", category: "schema", code: "NormalizationReviewRequired", message: `Normalized review: ${needsReview} invalid or conflicting fields and ${result.normalized.withheldRecords.length} records kept without mappings. CSV parsing status is reported separately.` });
        }
      }
      resolve(finalizeResult(result));
    };

    const fail = () => {
      addIssue(result, { severity: "error", category: "parsing", code: "ParseFailure", message: "Reading stopped before the file was finished. The preview and row count may be incomplete. Your source file has not been changed." });
      finish();
    };

    try {
      // Ignore empty records only for dialect detection. Otherwise trailing blank
      // lines can make Papa misidentify a two-column semicolon/tab-delimited file.
      // The actual parse below still retains quoted empty and whitespace cells.
      const dialect = Papa.parse<string[]>(text.replace(/^(?:\r\n|\r|\n)+/, ""), {
        preview: 10,
        skipEmptyLines: true,
        dynamicTyping: false,
        delimitersToGuess: [",", "\t", ";", "|", Papa.RECORD_SEP, Papa.UNIT_SEP],
      });
      for (const error of dialect.errors) {
        if (error.code === "UndetectableDelimiter") {
          addIssue(result, toParsingIssue(error));
        }
      }

      Papa.parse<string[]>(text, {
        header: false,
        dynamicTyping: false,
        skipEmptyLines: false,
        // We already run inside our own bundled worker, or yield explicitly below.
        worker: false,
        download: false,
        delimiter: dialect.meta.delimiter,
        newline: dialect.meta.linebreak as "\r" | "\n" | "\r\n",
        step: (step, parser) => {
          const end = resumeOffset + step.meta.cursor;
          const rawRecord = text.slice(previousCursor, end);
          previousCursor = end;
          parsedRecords += 1;
          result.delimiter = step.meta.delimiter;

          // Skip only physically empty records, including Papa's final phantom row.
          // A quoted empty string, whitespace-only cell, or comma-only row is data.
          const empty = rawRecord === "" || rawRecord === step.meta.linebreak;
          if (rawRecord === step.meta.linebreak) result.skippedEmptyLines += 1;
          if (!empty) logicalRecord += 1;

          const recordIssues: ValidationIssue[] = [];
          const report = (issue: ValidationIssue) => {
            addIssue(result, issue);
            recordIssues.push(issue);
          };

          for (const error of step.errors) {
            report(toParsingIssue(error, logicalRecord));
          }

          if (!empty) {
            if (step.errors.length === 0) {
              validateQuoteSyntax(rawRecord, step.meta.delimiter, step.meta.linebreak, logicalRecord, report);
            }
            const isHeader = !hasHeader;
            if (!hasHeader) {
              hasHeader = true;
              result.columns = step.data;
              validateHeaders(result.columns, report);
              addIssue(result, { severity: "info", category: "structure", code: "HeaderAssumed", message: "The first non-empty record is used as the column names. If your export has no header, that record may be data. No names have been guessed or added.", row: 1 });
              assessStockySchema(result, recordIssues.some((issue) => issue.category === "parsing"));
            } else {
              result.totalRows += 1;
              validateRow(step.data, result.columns.length, logicalRecord, report);
              if (result.preview.length < PREVIEW_LIMIT) {
                result.preview.push({ rowNumber: result.totalRows, values: step.data });
              }
              if (result.normalized.schema.status === "matched") {
                appendNormalizedRecord(result.normalized, sourceForRecord(file.name, result.totalRows, logicalRecord, result.columns, step.data, rawRecord), recordIssues);
              }
            }
            if (recordIssues.length > 0) {
              result.recordsWithIssues.push({ recordNumber: logicalRecord, dataRowNumber: isHeader ? null : result.totalRows, values: step.data, rawText: rawRecord, issues: recordIssues });
            }
          }

          // Pause/resume is supported because this is a local Papa parser, even
          // inside our dedicated worker. No step/chunk callback combination is used.
          if (parsedRecords % YIELD_EVERY_RECORDS === 0) {
            parser.pause();
            resumeOffset = end;
            setTimeout(() => {
              try {
                parser.resume();
              } catch {
                fail();
              }
            }, 0);
          }
        },
        complete: finish,
        error: fail,
      });
    } catch {
      fail();
    }
  });
}
