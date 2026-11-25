import type { DataQualityFinding } from "./storage/quality-types";

export const qualityCategoryLabels: Record<DataQualityFinding["category"], string> = {
  incomplete: "Incomplete records",
  "exact-duplicate": "Exact duplicate records",
  "invalid-date": "Invalid dates",
  conflict: "Conflicts",
  "invalid-value": "Invalid values",
  "ambiguous-overlap": "Possible overlaps",
  "csv-issue": "CSV issues",
  "schema-issue": "Schema issues",
};

export const qualityCategories = Object.keys(qualityCategoryLabels) as Array<DataQualityFinding["category"]>;

export function qualityLocation(row: { dataRowNumber?: number | null; recordNumber?: number }): string {
  if (row.recordNumber === undefined) return "File-level finding";
  return `${row.dataRowNumber === null ? "Header" : row.dataRowNumber === undefined ? "Data row unavailable" : `Data row ${row.dataRowNumber}`} · CSV record ${row.recordNumber}`;
}
