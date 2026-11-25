import type { ImportStatus, IssueSeverity } from "../importer/types";

export const QUALITY_CATEGORIES = ["incomplete", "exact-duplicate", "invalid-date", "conflict", "invalid-value", "ambiguous-overlap", "csv-issue", "schema-issue"] as const;
export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];
export type QualityCategoryCounts = Record<QualityCategory, number>;

export interface QualityColumnEvidence {
  column: number;
  header: string | null;
  /** Null is an absent cell, distinct from a present empty string. */
  rawValue: string | null;
}

/** Original evidence is stored once here, not copied into every finding. */
export interface QualitySourceEvidence {
  sourceReferenceId: string;
  importId: string;
  recordId?: string;
  fileName: string;
  dataRowNumber: number | null;
  recordNumber: number;
  columns: QualityColumnEvidence[];
  rawText: string;
}

export interface DataQualityFinding {
  id: string;
  category: QualityCategory;
  severity: IssueSeverity;
  message: string;
  importId: string;
  fileName: string;
  recordId?: string;
  sourceReferenceId?: string;
  dataRowNumber?: number | null;
  recordNumber?: number;
  fields: string[];
  columns: QualityColumnEvidence[];
  code?: string;
  duplicateGroupId?: string;
  /** For an overlap notice, every local record in the candidate order group. */
  affectedRecordIds?: string[];
  relatedSourceReferenceIds?: string[];
}

export interface QualityDuplicateGroup {
  id: string;
  recordIds: string[];
  sourceReferenceIds: string[];
  importIds: string[];
}

export interface DataQualityFileSummary {
  importId: string;
  fileName: string;
  status: ImportStatus;
  totalRows: number;
  normalizedRecords: number;
  analyzedRecords: number;
  withheldRecords: number;
  schemaStatus: "matched" | "unknown" | "not-detected" | "unavailable";
  unmappedColumns: Array<{ column: number; header: string }>;
  findingCount: number;
  affectedRecordCount: number;
  /** Distinct preserved records per category; a record can appear in several categories. */
  categoryRecordCounts: QualityCategoryCounts;
  categoryFindingCounts: QualityCategoryCounts;
  /** Parser-reported counts include diagnostics omitted from its capped summaries. */
  parserDiagnosticCounts: { info: number; warning: number; error: number } | null;
  storedDiagnosticCount: number;
  coverageNotes: string[];
}

export interface DataQualitySnapshot {
  generatedAt: string;
  files: DataQualityFileSummary[];
  findings: DataQualityFinding[];
  sources: QualitySourceEvidence[];
  duplicateGroups: QualityDuplicateGroup[];
  totals: {
    fileCount: number;
    totalRows: number;
    analyzedRecords: number;
    findingCount: number;
    affectedRecordCount: number;
    exactDuplicateGroupCount: number;
    /** All members of exact duplicate groups, including the first observation. */
    exactDuplicateRecordCount: number;
    categoryRecordCounts: QualityCategoryCounts;
    categoryFindingCounts: QualityCategoryCounts;
  };
  coverageNotes: string[];
}
