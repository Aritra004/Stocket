/** Versioned JSON contract. This module has no dependency on the host app. */
export type OfflineFieldState = "observed" | "missing" | "invalid" | "conflicting" | "derived";
export interface OfflineField { state: OfflineFieldState; value: string | null }
export interface OfflineFile {
  id: string;
  name: string;
  totalRows: number;
  status: string;
  coverageNotes: string[];
}
export interface OfflineRecord {
  id: string;
  fileId: string;
  kind: "purchase-order-summary" | "purchase-order-line-item";
  sourceId: string;
  fields: Record<string, OfflineField>;
}
export interface OfflineSource {
  id: string;
  fileId: string;
  dataRowNumber: number | null;
  recordNumber: number;
  cells: Array<{ column: number; header: string | null; rawValue: string | null }>;
  rawText: string;
}
export interface OfflineFinding {
  id: string;
  fileId: string;
  category: string;
  severity: "info" | "warning" | "error";
  message: string;
  recordIds: string[];
  sourceIds: string[];
}
export interface OfflineArchive {
  version: 1;
  exportedAt: string;
  files: OfflineFile[];
  records: OfflineRecord[];
  sources: OfflineSource[];
  findings: OfflineFinding[];
  qualityNotes: string[];
}
