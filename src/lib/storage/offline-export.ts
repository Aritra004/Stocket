import type { OfflineArchive, OfflineRecord } from "../../../offline-viewer/types";
import { validateOfflineArchive } from "../../../offline-viewer/validate";
import type { ArchiveDatabase } from "./database";
import { queryDataQuality } from "./quality-queries";
import type { DataQualitySnapshot } from "./quality-types";

/** Export all normalized records and preserved sources from one read-only snapshot. */
export async function queryOfflineArchive(db: ArchiveDatabase, qualitySnapshot?: DataQualitySnapshot): Promise<OfflineArchive> {
  return db.transaction("r", db.tables, async () => {
    // ZIP generation supplies quality from the same outer read transaction.
    const quality = qualitySnapshot ?? await queryDataQuality(db);
    const [files, orders, lines, sources] = await Promise.all([
      db.importedFiles.orderBy("importedAt").toArray(), db.purchaseOrders.toArray(), db.lineItems.toArray(), db.sourceReferences.toArray(),
    ]);
    const coverage = new Map(quality.files.map((file) => [file.importId, file.coverageNotes]));
    const records: OfflineRecord[] = [...orders, ...lines].map((record) => ({
      id: record.id, fileId: record.importId, kind: record.kind, sourceId: record.sourceReferenceId,
      fields: Object.fromEntries(Object.entries(record.fields).map(([name, field]) => [name, { state: field.state, value: field.value }])),
    }));
    const archive: OfflineArchive = {
      version: 1, exportedAt: quality.generatedAt,
      files: files.map((file) => ({ id: file.id, name: file.fileName, totalRows: file.totalRows, status: file.status, coverageNotes: coverage.get(file.id) ?? [] })),
      records,
      sources: sources.map((source) => ({
        id: source.id, fileId: source.importId, dataRowNumber: source.dataRowNumber, recordNumber: source.recordNumber,
        cells: source.source.cells.map(({ column, header, rawValue }) => ({ column, header, rawValue })), rawText: source.source.rawText,
      })),
      findings: quality.findings.map((finding) => ({
        id: finding.id, fileId: finding.importId, category: finding.category, severity: finding.severity, message: finding.message,
        recordIds: [...new Set([...(finding.recordId ? [finding.recordId] : []), ...(finding.affectedRecordIds ?? [])])],
        sourceIds: [...new Set([...(finding.sourceReferenceId ? [finding.sourceReferenceId] : []), ...(finding.relatedSourceReferenceIds ?? [])])],
      })),
      qualityNotes: [
        ...quality.coverageNotes,
        "This offline archive contains every saved normalized record and every saved source reference, including records without quality findings. Unmapped rows not preserved by the importer cannot be reconstructed.",
      ],
    };
    try {
      return validateOfflineArchive(archive);
    } catch (error) {
      throw new Error(`The saved archive could not be exported without losing reference integrity. ${error instanceof Error ? error.message : "Review the saved records and source references."}`);
    }
  });
}
