import type { DataQualityFinding, DataQualitySnapshot, QualitySourceEvidence } from "./storage/quality-types";
import { qualityCategories, qualityCategoryLabels, qualityLocation } from "./quality-presentation";

const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const literal = (value: string | null) => value === null ? "<em>Cell absent</em>" : value === "" ? "<em>Empty string</em>" : `<span class="literal">${escapeHtml(value)}</span>`;
const list = (items: string[]) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;

/** Source IDs for a finding, including every member of an exact duplicate group. */
export function findingSourceIds(snapshot: DataQualitySnapshot, finding: DataQualityFinding): string[] {
  const group = finding.duplicateGroupId ? snapshot.duplicateGroups.find((entry) => entry.id === finding.duplicateGroupId) : undefined;
  return [...new Set([...(finding.sourceReferenceId ? [finding.sourceReferenceId] : []), ...(finding.relatedSourceReferenceIds ?? []), ...(group?.sourceReferenceIds ?? [])])];
}

function sourceHtml(source: QualitySourceEvidence, anchor: string): string {
  return `<details open id="${anchor}" class="source"><summary>${escapeHtml(source.fileName)} · ${escapeHtml(qualityLocation(source))}</summary>
<div class="scroll"><table><thead><tr><th>Column</th><th>Original header</th><th>Original value</th></tr></thead><tbody>${source.columns.map((cell) => `<tr><td>${cell.column}</td><td>${cell.header === null ? "<em>Header absent</em>" : literal(cell.header)}</td><td>${literal(cell.rawValue)}</td></tr>`).join("")}</tbody></table></div>
<h3>Original CSV record</h3><pre>${escapeHtml(source.rawText)}</pre></details>`;
}

/** Static, escaped HTML with all findings and evidence; no scripts or external assets. */
export function renderDataQualityReport(snapshot: DataQualitySnapshot): string {
  const sourceMap = new Map(snapshot.sources.map((source, index) => [source.sourceReferenceId, { source, anchor: `source-${index + 1}` }]));
  const fileMap = new Map(snapshot.files.map((file, index) => [file.importId, `file-${index + 1}`]));
  const groupMap = new Map(snapshot.duplicateGroups.map((group, index) => [group.id, `duplicate-group-${index + 1}`]));
  const categories = qualityCategories.map((category) => `<tr><th scope="row">${escapeHtml(qualityCategoryLabels[category])}</th><td>${snapshot.totals.categoryRecordCounts[category]}</td><td>${snapshot.totals.categoryFindingCounts[category]}</td></tr>`).join("");
  const files = snapshot.files.map((file) => `<tr><td><a href="#${fileMap.get(file.importId)}" class="literal">${escapeHtml(file.fileName)}</a></td><td>${escapeHtml(file.status)}</td><td>${file.totalRows}</td><td>${file.analyzedRecords}</td><td>${file.affectedRecordCount}</td>${qualityCategories.map((category) => `<td>${file.categoryRecordCounts[category]}</td>`).join("")}<td>${file.findingCount}</td></tr>`).join("");
  const findings = snapshot.findings.map((finding) => {
    // List a duplicate group's members once below, rather than repeating all
    // members for every finding (which would make large exports quadratic).
    const ids = [...new Set([...(finding.sourceReferenceId ? [finding.sourceReferenceId] : []), ...(finding.relatedSourceReferenceIds ?? [])])];
    const references = ids.map((id) => {
      const entry = sourceMap.get(id);
      return entry ? `<li><a href="#${entry.anchor}">${escapeHtml(entry.source.fileName)} · ${escapeHtml(qualityLocation(entry.source))}</a></li>` : "<li>Original source is unavailable in this snapshot.</li>";
    }).join("");
    const group = finding.duplicateGroupId ? groupMap.get(finding.duplicateGroupId) : undefined;
    return `<tr data-quality-finding="true"><td>${escapeHtml(qualityCategoryLabels[finding.category])}<br><small>${escapeHtml(finding.severity)}</small></td><td>${escapeHtml(finding.message)}${finding.code ? `<p><small>Diagnostic: ${escapeHtml(finding.code)}</small></p>` : ""}${finding.columns.length ? `<ul>${finding.columns.map((cell) => `<li>Column ${cell.column} · ${cell.header === null ? "Header absent" : escapeHtml(cell.header)}: ${literal(cell.rawValue)}</li>`).join("")}</ul>` : ""}</td><td><span class="literal">${escapeHtml(finding.fileName)}</span><p>${escapeHtml(qualityLocation(finding))}</p>${references ? `<ul>${references}</ul>` : "<p>No row-level source was retained for this finding.</p>"}${group ? `<p><a href="#${group}">All exact duplicate source records</a></p>` : ""}</td></tr>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>Stocky History Rescue — Data quality report</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f8f9;color:#172b3a;font:15px/1.6 system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:40px 24px}header{border-bottom:3px solid #065f46;padding-bottom:24px}h1{font-size:32px;letter-spacing:-1px;color:#10251f;margin:8px 0}h2{font-size:22px;margin:32px 0 14px}h3{font-size:15px}p{margin:8px 0}a{color:#065f46;text-decoration:underline;text-underline-offset:3px}small,.muted{color:#536574}.cards{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}.card{background:white;border:1px solid #dce5e7;border-radius:10px;padding:16px 22px;min-width:150px}.card strong{display:block;font-size:26px}.scroll{overflow-x:auto;background:white;border:1px solid #dce5e7;border-radius:8px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #dce5e7;overflow-wrap:anywhere}th{background:#eef5f2;font-weight:600}tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}.wide{min-width:1250px}.literal,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{font-size:12px;background:#f5f7f8;padding:12px;border-radius:6px}.source,.file{background:white;border:1px solid #dce5e7;padding:16px;margin:16px 0;border-radius:10px;scroll-margin-top:20px}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}ul{padding-left:22px}li{margin:4px 0}footer{margin-top:36px;border-top:1px solid #dce5e7;padding-top:16px;font-size:12px;color:#536574}@media print{body{background:white}main{padding:0}.scroll{overflow:visible}.wide{min-width:0}table{font-size:9px}td,th{padding:5px}h2,h3,summary{break-after:avoid}.card{break-inside:avoid}a{color:inherit}pre{white-space:pre-wrap}}
</style></head><body><main>
<header><p class="muted">Stocky History Rescue · Local archive</p><h1>Data quality report</h1><p>Generated ${escapeHtml(snapshot.generatedAt)} (UTC). This report contains all file summaries and findings in the snapshot, with original evidence retained for findings, regardless of dashboard filters.</p><p>Recorded costs and currencies remain unchanged. No currency conversion, mixed-currency total, or inferred price is included.</p></header>
<div class="cards"><div class="card">Saved files<strong>${snapshot.totals.fileCount}</strong></div><div class="card">Parsed data rows<strong>${snapshot.totals.totalRows}</strong></div><div class="card">Mapped records checked<strong>${snapshot.totals.analyzedRecords}</strong></div><div class="card">Records with findings<strong>${snapshot.totals.affectedRecordCount}</strong></div><div class="card">Findings<strong>${snapshot.totals.findingCount}</strong></div></div>
<h2>Quality categories</h2><p>Record counts are distinct within each category. Categories overlap and must not be added together. File and header diagnostics count as findings, without inventing affected data rows.</p>
<div class="scroll"><table><thead><tr><th>Category</th><th>Affected records</th><th>Findings</th></tr></thead><tbody>${categories}</tbody></table></div>
<p>${snapshot.totals.exactDuplicateGroupCount} exact duplicate groups contain ${snapshot.totals.exactDuplicateRecordCount} records, including the first observation in each group. Repeated identifiers alone are possible overlaps, not exact duplicates.</p>
<h2>Import quality by file</h2>${snapshot.files.length ? `<div class="scroll"><table class="wide"><thead><tr><th>File</th><th>CSV status</th><th>Parsed rows</th><th>Mapped records checked</th><th>Records with findings</th>${qualityCategories.map((category) => `<th>${escapeHtml(qualityCategoryLabels[category])}</th>`).join("")}<th>Findings</th></tr></thead><tbody>${files}</tbody></table></div>` : "<p>No saved imports. No record quality has been assessed.</p>"}
${snapshot.files.map((file) => `<section class="file" id="${fileMap.get(file.importId)}"><h3 class="literal">${escapeHtml(file.fileName)}</h3><p>Mapping: ${escapeHtml(file.schemaStatus)} · Withheld records: ${file.withheldRecords} · Saved diagnostics: ${file.storedDiagnosticCount}</p><p>${file.parserDiagnosticCounts ? `Parser totals: ${file.parserDiagnosticCounts.error} errors, ${file.parserDiagnosticCounts.warning} warnings, ${file.parserDiagnosticCounts.info} notices. These counts describe parser diagnostics, not affected records.` : "Parser diagnostic totals unavailable."}</p>${file.unmappedColumns.length ? `<p>Unmapped columns: ${file.unmappedColumns.map((column) => `${column.column}: ${escapeHtml(column.header)}`).join(", ")}</p>` : ""}${list(file.coverageNotes)}</section>`).join("")}
<h2>Quality findings</h2>${findings ? `<div class="scroll"><table><thead><tr><th>Category</th><th>Finding and original values</th><th>Source references</th></tr></thead><tbody>${findings}</tbody></table></div>` : "<p>No findings in the saved evidence. Review coverage before drawing a clean-data conclusion.</p>"}
${snapshot.duplicateGroups.length ? `<h2>Exact duplicate groups</h2>${snapshot.duplicateGroups.map((group) => `<section class="source" id="${groupMap.get(group.id)}"><h3>${group.recordIds.length} matching source records</h3><ul>${group.sourceReferenceIds.map((id) => { const entry = sourceMap.get(id); return entry ? `<li><a href="#${entry.anchor}">${escapeHtml(entry.source.fileName)} · ${escapeHtml(qualityLocation(entry.source))}</a></li>` : "<li>Original source unavailable</li>"; }).join("")}</ul></section>`).join("")}` : ""}
<h2>Source evidence</h2><p>Data row numbers exclude the header and empty physical lines; CSV record numbers include the header. A quoted multiline value is one logical record. Empty strings and absent cells are shown separately.</p>
${snapshot.sources.map((source) => sourceHtml(source, sourceMap.get(source.sourceReferenceId)!.anchor)).join("") || "<p>No questionable row evidence is available in this snapshot.</p>"}
<h2>Coverage and counting rules</h2>${list(snapshot.coverageNotes)}
<footer>Generated locally from saved IndexedDB records. This HTML is self-contained and works offline. No source records were changed. The report includes original imported values; share it only with the intended recipients.</footer>
</main></body></html>`;
}
