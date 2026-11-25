import type { NormalizedImport } from "../stocky/types";

export type ImportStatus = "success" | "warning" | "error" | "unsupported";

export type ParsingMode = "worker" | "main-thread";

export type IssueSeverity = "info" | "warning" | "error";
export type IssueCategory = "file" | "parsing" | "structure" | "schema" | "environment" | "session";

export interface ValidationIssue {
  severity: IssueSeverity;
  category: IssueCategory;
  code: string;
  message: string;
  /** One-based logical CSV record, including the header; not a physical line. */
  row?: number;
  /** One-based column position. */
  column?: number;
}

export interface CsvRecord {
  /** One-based data-record number, excluding the header and empty physical lines. */
  rowNumber: number;
  /** Positional cells preserve duplicate headers, missing cells, and extra cells. */
  values: string[];
}

/** Reviewable original text and recovered values, including records after preview 10. */
export interface CsvRecordWithIssues {
  recordNumber: number;
  /** Null identifies the record interpreted as the header. */
  dataRowNumber: number | null;
  values: string[];
  /** Exact decoded source for this logical record, including its line ending. */
  rawText: string;
  issues: ValidationIssue[];
}

export interface CsvImportResult {
  fileName: string;
  /** Original file size in bytes. */
  fileSize: number;
  /** Original parsed header values, in order. These are not Stocky field names. */
  columns: string[];
  /** All parsed data records, including records with structural issues. */
  totalRows: number;
  /** At most the first ten data records. */
  preview: CsvRecord[];
  /** All records with CSV structure/quote issues; never capped with diagnostic summaries. */
  recordsWithIssues: CsvRecordWithIssues[];
  skippedEmptyLines: number;
  /** At most 100 details per severity; counts include omitted details. */
  info: ValidationIssue[];
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
  warningCount: number;
  errorCount: number;
  infoCount: number;
  /** Describes CSV parsing only, never Stocky schema validity. */
  status: ImportStatus;
  delimiter: string | null;
  parsingMode: ParsingMode | null;
  /** Provisional matches are explicitly unverified fixture contracts, not real export claims. */
  stockyValidation: "not-validated" | "unsupported" | "provisional";
  normalized: NormalizedImport;
}

export interface CsvWorkerRequest {
  type: "parse";
  file: File;
}

export type CsvWorkerResponse =
  | { type: "ready" }
  | { type: "failed" }
  | { type: "result"; result: CsvImportResult };
