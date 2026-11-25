import type { NormalizedField, NormalizedRecord } from "../stocky/types";
import type { ArchiveDatabase } from "./database";
import { QUALITY_CATEGORIES, type DataQualityFileSummary, type DataQualityFinding, type DataQualitySnapshot, type QualityCategory, type QualityCategoryCounts, type QualityColumnEvidence, type QualityDuplicateGroup, type QualitySourceEvidence } from "./quality-types";
import type { StoredImport, StoredLineItem, StoredPurchaseOrder, StoredSourceReference } from "./types";

type QualityRecord = StoredPurchaseOrder | StoredLineItem;
const dateFields = new Set(["orderDate", "expectedDate"]);
const completenessFields = new Set(["purchaseOrderNumber", "lineId", "sku", "supplier", "orderDate", "currency", "totalCost", "unitCost", "orderedQuantity", "receivedQuantity"]);
const labels: Record<string, string> = {
  purchaseOrderNumber: "purchase-order number", supplier: "supplier", status: "status", orderDate: "order date", expectedDate: "expected date",
  currency: "currency", totalCost: "total cost", orderedQuantity: "ordered quantity", receivedQuantity: "received quantity", outstandingQuantity: "outstanding quantity",
  lineId: "line ID", sku: "SKU", productName: "product name", unitCost: "unit cost",
};
const counts = (): QualityCategoryCounts => Object.fromEntries(QUALITY_CATEGORIES.map((category) => [category, 0])) as QualityCategoryCounts;
const columnEvidence = (source: StoredSourceReference): QualityColumnEvidence[] => source.source.cells.map(({ column, header, rawValue }) => ({ column, header, rawValue }));

function location(file: StoredImport, record?: QualityRecord, source?: StoredSourceReference) {
  return {
    importId: file.id, fileName: file.fileName,
    ...(record ? { recordId: record.id, sourceReferenceId: record.sourceReferenceId, dataRowNumber: record.rowNumber, recordNumber: record.recordNumber } : {}),
    ...(source ? { sourceReferenceId: source.id, dataRowNumber: source.dataRowNumber, recordNumber: source.recordNumber, ...(source.recordId ? { recordId: source.recordId } : {}) } : {}),
  };
}

function fieldColumns(names: string[], normalized: NormalizedRecord | undefined, source: StoredSourceReference | undefined): QualityColumnEvidence[] {
  if (!source || !normalized) return [];
  const selected = new Set<number>();
  const fields = normalized.fields as unknown as Record<string, NormalizedField<string>>;
  for (const name of names) {
    const field = fields[name];
    if (!field) continue;
    // Conflict fields share potentially large evidence lists. The adapter uses
    // the same column in every row, so select this row's original cell once.
    if (field.state === "conflicting") {
      const column = field.sources[0]?.column;
      if (column !== undefined) selected.add(column);
    } else for (const cell of field.sources) if (cell.recordNumber === source.recordNumber) selected.add(cell.column);
  }
  return columnEvidence(source).filter((cell) => selected.has(cell.column));
}

/** A read-only, internally consistent snapshot of the existing local archive. */
export async function queryDataQuality(db: ArchiveDatabase): Promise<DataQualitySnapshot> {
  return db.transaction("r", [db.importedFiles, db.importPayloads, db.purchaseOrders, db.lineItems, db.sourceReferences, db.validationIssues], async () => {
    const files = await db.importedFiles.orderBy("importedAt").toArray();
    const findings: DataQualityFinding[] = [];
    const summaries: DataQualityFileSummary[] = [];
    const evidence = new Map<string, QualitySourceEvidence>();
    const allRecords = new Map<string, QualityRecord>();
    const allSources = new Map<string, StoredSourceReference>();
    const duplicateCandidates = new Map<string, QualityRecord[]>();
    const missingSourceFiles = new Set<string>();
    const addSource = (source: StoredSourceReference | undefined, file: StoredImport) => {
      if (!source || evidence.has(source.id)) return;
      evidence.set(source.id, { sourceReferenceId: source.id, importId: file.id, ...(source.recordId ? { recordId: source.recordId } : {}), fileName: file.fileName, dataRowNumber: source.dataRowNumber, recordNumber: source.recordNumber, columns: columnEvidence(source), rawText: source.source.rawText });
    };

    for (const file of files) {
      const [payload, orders, lines, sourceRows, issues] = await Promise.all([
        db.importPayloads.get(file.id), db.purchaseOrders.where("importId").equals(file.id).toArray(), db.lineItems.where("importId").equals(file.id).toArray(),
        db.sourceReferences.where("importId").equals(file.id).toArray(), db.validationIssues.where("importId").equals(file.id).toArray(),
      ]);
      const records: QualityRecord[] = [...orders, ...lines].sort((a, b) => a.recordNumber - b.recordNumber || a.id.localeCompare(b.id));
      const sources = new Map(sourceRows.map((source) => [source.id, source]));
      const sourcesByNumber = new Map(sourceRows.map((source) => [source.recordNumber, source]));
      const recordsByOrder = new Map<string, QualityRecord[]>();
      const coveredFieldDiagnostics = new Set<string>();
      for (const source of sourceRows) allSources.set(source.id, source);
      const result = payload?.result;
      const schema = result?.normalized.schema;
      const coverageNotes: string[] = [];
      if (!result) coverageNotes.push("The saved import payload is unavailable. Indexed records and stored diagnostics are still checked, but schema coverage and parser diagnostic totals cannot be verified.");
      else {
        if (schema?.status !== "matched") coverageNotes.push("This file has no supported field mapping. Field completeness, invalid values, date validity, and exact duplicates cannot be fully assessed; no clean-data conclusion is implied.");
        else coverageNotes.push("Field checks use the saved provisional fixture mapping, which is not a verified real Stocky export format.");
        if (result.totalRows > records.length) coverageNotes.push(`${result.totalRows - records.length} parsed data record(s) have no normalized record. Their saved CSV diagnostics are included where available; unpreserved unmapped rows cannot be reconstructed.`);
        if (result.warningCount > result.warnings.length || result.errorCount > result.errors.length || result.infoCount > result.info.length) coverageNotes.push("Parser diagnostic summary details were capped when imported. Parser totals include omitted details; preserved row-level CSV issues are included when available, but the report cannot recover every omitted diagnostic.");
        if (schema?.status === "matched" && schema.unmappedColumns.length) coverageNotes.push(`${schema.unmappedColumns.length} unmapped column(s) are retained as source evidence and considered for exact duplicate comparison, but their business meaning and validity are not assessed.`);
      }
      const summary: DataQualityFileSummary = {
        importId: file.id, fileName: file.fileName, status: file.status, totalRows: file.totalRows, normalizedRecords: file.normalizedCount, analyzedRecords: records.length,
        withheldRecords: sourceRows.filter((source) => source.kind === "withheld").length, schemaStatus: schema?.status ?? "unavailable",
        unmappedColumns: schema?.status === "matched" ? schema.unmappedColumns.map((column) => ({ ...column })) : [], findingCount: 0, affectedRecordCount: 0,
        categoryRecordCounts: counts(), categoryFindingCounts: counts(), parserDiagnosticCounts: result ? { info: result.infoCount, warning: result.warningCount, error: result.errorCount } : null,
        storedDiagnosticCount: issues.length, coverageNotes,
      };
      summaries.push(summary);

      for (const record of records) {
        allRecords.set(record.id, record);
        if (record.orderKey !== undefined) {
          const group = recordsByOrder.get(record.orderKey) ?? [];
          group.push(record);
          recordsByOrder.set(record.orderKey, group);
        }
        const source = sources.get(record.sourceReferenceId);
        const normalized = result?.normalized.records[record.recordIndex];
        if (!source) missingSourceFiles.add(file.id);
        else {
          // Full equality uses preserved header/value pairs, including unmapped
          // columns and original identifier spelling. No order identity is guessed.
          const signature = JSON.stringify([record.adapterId, record.adapterVersion, record.kind, source.source.cells.map((cell) => [cell.header, cell.rawValue])]);
          const group = duplicateCandidates.get(signature) ?? [];
          group.push(record);
          duplicateCandidates.set(signature, group);
        }
        const fields = Object.entries(record.fields);
        const categories: Array<{ category: QualityCategory; names: string[]; message: string }> = [
          { category: "incomplete", names: fields.filter(([name, field]) => completenessFields.has(name) && field.state === "missing").map(([name]) => name), message: "History fields are unavailable" },
          { category: "invalid-date", names: fields.filter(([name, field]) => dateFields.has(name) && field.state === "invalid").map(([name]) => name), message: "Date values could not be validated; no date format was guessed" },
          { category: "conflict", names: fields.filter(([, field]) => field.state === "conflicting").map(([name]) => name), message: "Saved records contain conflicting field observations; no value was chosen" },
          { category: "invalid-value", names: fields.filter(([name, field]) => !dateFields.has(name) && field.state === "invalid").map(([name]) => name), message: "Values could not be validated or safely derived" },
        ];
        for (const { category, names, message } of categories) {
          if (!names.length) continue;
          addSource(source, file);
          const normalizedFields = normalized?.fields as unknown as Record<string, NormalizedField<string>> | undefined;
          const reasons = category === "invalid-date" || category === "invalid-value" ? [...new Set(names.flatMap((name) => {
            const field = normalizedFields?.[name];
            return field?.state === "invalid" ? [field.reason] : [];
          }))] : [];
          findings.push({ id: `${record.id}:quality:${category}`, category, severity: "warning", ...location(file, record, source), fields: names, columns: fieldColumns(names, normalized, source), message: `${message}: ${names.map((name) => labels[name] ?? name).join(", ")}.${reasons.length ? ` ${reasons.join(" ")}` : ""}` });
          if (category === "invalid-date" || category === "invalid-value") coveredFieldDiagnostics.add(`${record.id}:InvalidNormalizedValue`);
          if (category === "conflict") coveredFieldDiagnostics.add(`${record.id}:ConflictingNormalizedValue`);
          if (category === "incomplete" && names.some((name) => name === "purchaseOrderNumber" || name === "lineId")) coveredFieldDiagnostics.add(`${record.id}:MissingRecordIdentity`);
        }
      }

      for (const saved of issues) {
        if (saved.scope === "normalization" && saved.recordId && coveredFieldDiagnostics.has(`${saved.recordId}:${saved.issue.code}`)) continue;
        const record = saved.recordId ? allRecords.get(saved.recordId) : undefined;
        const source = (saved.sourceReferenceId ? sources.get(saved.sourceReferenceId) : undefined) ?? (saved.issue.row !== undefined ? sourcesByNumber.get(saved.issue.row) : undefined);
        const category: QualityCategory = saved.scope === "overlap" ? saved.issue.code === "ConflictingOrderRecords" ? "conflict" : "ambiguous-overlap" : saved.issue.category === "schema" ? "schema-issue" : "csv-issue";
        const affected = saved.scope === "overlap" && saved.orderKey !== undefined ? recordsByOrder.get(saved.orderKey) ?? [] : [];
        const relatedSourceReferenceIds = affected.map((row) => row.sourceReferenceId);
        addSource(source, file);
        for (const row of affected) addSource(sources.get(row.sourceReferenceId), file);
        findings.push({
          id: `${saved.id}:quality`, category, severity: saved.issue.severity, message: saved.issue.message, code: saved.issue.code, ...location(file, record, source),
          ...(saved.issue.row !== undefined && !source && !record ? { recordNumber: saved.issue.row } : {}),
          fields: saved.conflictingFields ?? [], columns: source && saved.issue.column !== undefined ? columnEvidence(source).filter((cell) => cell.column === saved.issue.column) : [],
          ...(affected.length ? { affectedRecordIds: affected.map((row) => row.id), relatedSourceReferenceIds } : {}),
        });
      }
    }

    const fileMap = new Map(files.map((file) => [file.id, file]));
    const duplicateGroups: QualityDuplicateGroup[] = [];
    for (const group of duplicateCandidates.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.id.localeCompare(b.id));
      const id = `${group[0].id}:exact-duplicate-group`;
      duplicateGroups.push({ id, recordIds: group.map((record) => record.id), sourceReferenceIds: group.map((record) => record.sourceReferenceId), importIds: [...new Set(group.map((record) => record.importId))] });
      for (const record of group) {
        const file = fileMap.get(record.importId)!;
        const source = allSources.get(record.sourceReferenceId)!;
        addSource(source, file);
        findings.push({ id: `${record.id}:quality:exact-duplicate`, category: "exact-duplicate", severity: "warning", ...location(file, record, source), fields: [], columns: [], duplicateGroupId: id, message: `This record is one of ${group.length} exact source-value matches with the same adapter and record kind. All original column names and cell values match, including unmapped columns. Records remain separate; this is not proof that a business order was duplicated.` });
      }
    }

    const byFile = new Map(summaries.map((file) => [file.importId, file]));
    const recordSets = new Map(summaries.map((file) => [file.importId, new Map(QUALITY_CATEGORIES.map((category) => [category, new Set<string>()]))]));
    const totalCategoryFindings = counts();
    const totalCategoryRecords = counts();
    for (const finding of findings) {
      const file = byFile.get(finding.importId)!;
      file.findingCount += 1;
      file.categoryFindingCounts[finding.category] += 1;
      totalCategoryFindings[finding.category] += 1;
      // Unnormalized records with preserved row diagnostics count as records;
      // file/header diagnostics do not manufacture affected data records.
      const affectedIds = finding.affectedRecordIds?.length ? finding.affectedRecordIds : finding.recordId ? [finding.recordId] : finding.sourceReferenceId && finding.dataRowNumber !== null && finding.dataRowNumber !== undefined ? [finding.sourceReferenceId] : [];
      for (const id of affectedIds) recordSets.get(file.importId)!.get(finding.category)!.add(id);
    }
    let affectedRecordCount = 0;
    for (const file of summaries) {
      const fileIds = new Set<string>();
      for (const category of QUALITY_CATEGORIES) {
        const ids = recordSets.get(file.importId)!.get(category)!;
        file.categoryRecordCounts[category] = ids.size;
        totalCategoryRecords[category] += ids.size;
        for (const id of ids) fileIds.add(id);
      }
      file.affectedRecordCount = fileIds.size;
      affectedRecordCount += fileIds.size;
      if (missingSourceFiles.has(file.importId)) file.coverageNotes.push("Some indexed records have no saved source reference. Field states remain reviewable, but their raw values and exact duplicate status could not be verified.");
    }
    findings.sort((a, b) => a.importId.localeCompare(b.importId) || (a.recordNumber ?? 0) - (b.recordNumber ?? 0) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    return {
      generatedAt: new Date().toISOString(), files: summaries, findings, sources: [...evidence.values()], duplicateGroups,
      totals: { fileCount: files.length, totalRows: files.reduce((sum, file) => sum + file.totalRows, 0), analyzedRecords: allRecords.size, findingCount: findings.length, affectedRecordCount, exactDuplicateGroupCount: duplicateGroups.length, exactDuplicateRecordCount: duplicateGroups.reduce((sum, group) => sum + group.recordIds.length, 0), categoryRecordCounts: totalCategoryRecords, categoryFindingCounts: totalCategoryFindings },
      coverageNotes: [
        "Read-only snapshot of saved local IndexedDB records. No fields are repaired, inferred, merged, or removed.",
        "Incomplete means at least one history field is unavailable: purchase-order number; supplier; order date; currency; cost; ordered or received quantity; and line ID/SKU for line items. It does not mean an order is invalid. Optional status, expected date and product name are not completeness requirements; derived outstanding quantity is not counted again. Summary records are not expected to contain SKUs.",
        "Category record counts count distinct affected preserved data records in each category. Categories overlap; file/header diagnostics affect no data record. Finding counts include those diagnostics and may exceed record counts.",
        "Exact duplicate counts include every member of a group with the same adapter, record kind, and exact ordered header/value pairs. Formatting of CSV quoting and line endings is not compared. Shared purchase-order or line identifiers alone do not establish exact duplicates.",
        "Cross-import overlap notices describe candidate order groups. Every local record in the candidate group counts as affected; identifiers may belong to different stores or orders, so conflicts do not establish a common business identity.",
        "Invalid date checks use saved field states from the declared mapping. No locale or timezone is guessed. Original values and unavailable amounts or quantities remain unchanged.",
        "Field-state findings consolidate matching stored normalization diagnostics. Other saved CSV and schema diagnostics remain separate. No findings is not proof of complete coverage; read each file's coverage notes.",
      ],
    };
  });
}
