import type { ValidationIssue } from "../importer/types";

export type StockyRecordKind = "purchase-order-summary" | "purchase-order-line-item";
export type FieldState = "missing" | "observed" | "derived" | "conflicting" | "invalid";
/** Exact, canonical base-ten notation; never a floating-point money value. */
export type DecimalString = string & { readonly __decimal: unique symbol };
/** A validated calendar date in YYYY-MM-DD form; no locale or timezone inference. */
export type CalendarDate = string & { readonly __calendarDate: unique symbol };

export interface SourceCell {
  fileName: string;
  /** One-based data row, excluding the header and physically empty lines. */
  rowNumber: number;
  /** One-based logical CSV record, including the header. */
  recordNumber: number;
  /** One-based physical column position. */
  column: number;
  header: string | null;
  /** Null means a cell is absent, distinct from the observed empty string. */
  rawValue: string | null;
}

export interface RecordSource {
  fileName: string;
  rowNumber: number;
  recordNumber: number;
  /** Original Papa-parsed cells, unchanged and including unmapped columns. */
  values: string[];
  /** Original decoded CSV record, including quoting and its line ending. */
  rawText: string;
  cells: SourceCell[];
}

interface FieldBase { sources: SourceCell[] }
export type NormalizedField<T> =
  | (FieldBase & { state: "missing"; value: null; reason: "column-absent" | "cell-absent" | "empty-cell" })
  | (FieldBase & { state: "observed"; value: T })
  | (FieldBase & { state: "derived"; value: T; rule: string })
  | (FieldBase & { state: "invalid"; value: null; reason: string })
  | (FieldBase & { state: "conflicting"; value: null; reason: string; alternatives: Array<{ value: T; sources: SourceCell[] }> });

export interface PurchaseOrderSummaryFields {
  purchaseOrderNumber: NormalizedField<string>;
  supplier: NormalizedField<string>;
  status: NormalizedField<string>;
  orderDate: NormalizedField<CalendarDate>;
  expectedDate: NormalizedField<CalendarDate>;
  currency: NormalizedField<string>;
  totalCost: NormalizedField<DecimalString>;
  orderedQuantity: NormalizedField<DecimalString>;
  receivedQuantity: NormalizedField<DecimalString>;
  outstandingQuantity: NormalizedField<DecimalString>;
}

export interface PurchaseOrderLineItemFields {
  purchaseOrderNumber: NormalizedField<string>;
  lineId: NormalizedField<string>;
  sku: NormalizedField<string>;
  productName: NormalizedField<string>;
  supplier: NormalizedField<string>;
  orderDate: NormalizedField<CalendarDate>;
  currency: NormalizedField<string>;
  unitCost: NormalizedField<DecimalString>;
  orderedQuantity: NormalizedField<DecimalString>;
  receivedQuantity: NormalizedField<DecimalString>;
  outstandingQuantity: NormalizedField<DecimalString>;
}

interface NormalizedRecordBase {
  adapterId: string;
  adapterVersion: 1;
  source: RecordSource;
  issues: ValidationIssue[];
}
export type NormalizedRecord =
  | (NormalizedRecordBase & { kind: "purchase-order-summary"; fields: PurchaseOrderSummaryFields })
  | (NormalizedRecordBase & { kind: "purchase-order-line-item"; fields: PurchaseOrderLineItemFields });

export interface SchemaDescriptor {
  id: string;
  version: 1;
  kind: StockyRecordKind;
  label: string;
  verification: "unverified";
  /** Checked-in synthetic fixture contract, not evidence of a genuine Stocky export. */
  fixturePath: string;
  requiredHeaders: readonly string[];
  mappedHeaders: readonly string[];
}

export type SchemaDetection =
  | { status: "not-detected" }
  | { status: "unknown"; reason: "no-match" | "ambiguous" | "duplicate-mapped-header" | "malformed-header"; message: string; candidates: string[] }
  | { status: "matched"; adapter: SchemaDescriptor; unmappedColumns: Array<{ column: number; header: string }> };

export interface WithheldNormalizedRecord {
  source: RecordSource;
  reason: string;
  issues: ValidationIssue[];
}

export interface NormalizedImport {
  schema: SchemaDetection;
  /** Every supported row is retained, not only the first ten preview records. */
  records: NormalizedRecord[];
  /** Structurally unsafe rows are retained with their source, without field mappings. */
  withheldRecords: WithheldNormalizedRecord[];
  fieldCounts: Record<FieldState, number>;
}
