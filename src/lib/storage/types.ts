import type { CsvImportResult, ImportStatus, ValidationIssue } from "../importer/types";
import type { FieldState, NormalizedField, PurchaseOrderLineItemFields, PurchaseOrderSummaryFields, RecordSource, SourceCell } from "../stocky/types";

export interface StoredImport {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  lastModified: number;
  sha256: string;
  hashVersion: "sha256/raw-v1";
  importedAt: number;
  totalRows: number;
  status: ImportStatus;
  normalizedCount: number;
  /** Warning/error details in the local issue collection, separate from CSV status. */
  reviewCount: number;
}

/** Keep the full normalized graph once, preserving shared conflict evidence. */
export interface StoredImportPayload { importId: string; result: CsvImportResult }

/** Exact imported bytes. Absent for legacy imports until the original is reselected. */
export interface StoredOriginalFile { importId: string; blob: Blob }

export type StoredFields<T> = {
  [K in keyof T]: T[K] extends NormalizedField<infer V>
    ? { state: FieldState; value: V | null; sourceReferenceId: string }
    : never;
};

interface StoredRecordBase {
  id: string;
  importId: string;
  recordIndex: number;
  sourceReferenceId: string;
  rowNumber: number;
  recordNumber: number;
  adapterId: string;
  adapterVersion: number;
  /** Exact observed identifier only; no store namespace or identity is inferred. */
  orderKey?: string;
}

/** Indexed projections; the complete typed model is in the import payload. */
export interface StoredPurchaseOrder extends StoredRecordBase {
  kind: "purchase-order-summary";
  fields: StoredFields<PurchaseOrderSummaryFields>;
}

export interface StoredLineItem extends StoredRecordBase {
  kind: "purchase-order-line-item";
  lineKey?: string;
  fields: StoredFields<PurchaseOrderLineItemFields>;
}

/** One literal supplier observation per source record; names are not identities. */
export interface StoredSupplier {
  id: string;
  importId: string;
  recordId: string;
  sourceReferenceId: string;
  name: string;
  state: "observed" | "conflicting";
  column: number;
}

export interface StoredSourceReference {
  id: string;
  importId: string;
  recordId?: string;
  kind: "normalized" | "withheld" | "csv-issue";
  recordNumber: number;
  /** Header records have no data row. */
  dataRowNumber: number | null;
  source: Omit<RecordSource, "rowNumber" | "cells"> & {
    rowNumber: number | null;
    cells: Array<Omit<SourceCell, "rowNumber"> & { rowNumber: number | null }>;
  };
}

export interface StoredValidationIssue {
  id: string;
  importId: string;
  scope: "csv" | "normalization" | "overlap";
  issue: ValidationIssue;
  recordId?: string;
  sourceReferenceId?: string;
  /** Overlap group lookup key; this is a candidate identity, never a merged order. */
  orderKey?: string;
  relatedImportIds?: string[];
  relatedImportCount?: number;
  conflictingFields?: string[];
}

export interface SaveImportInput {
  file: { name: string; size: number; type: string; lastModified: number };
  sha256: string;
  result: CsvImportResult;
  /** Never reconstruct this from parsed text; old records may not have these bytes. */
  originalFile?: Blob;
  replaceId?: string;
  /** Optimistic guard for a replacement confirmed against this saved version. */
  expectedHash?: string;
}

export type SaveImportOutcome = { kind: "saved" | "duplicate"; file: StoredImport };
