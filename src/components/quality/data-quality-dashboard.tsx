"use client";

import { useMemo, useState } from "react";
import { Download, FileCheck2, RefreshCw } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { useArchiveRevision, useDashboardQuery } from "@/src/components/dashboard/use-dashboard";
import { SourceReferenceView } from "@/src/components/dashboard/order-detail";
import { HistoryEmpty, HistoryPagination, HistoryState } from "@/src/components/history/history-controls";
import type { DataQualityFinding, DataQualitySnapshot, QualityCategory, QualitySourceEvidence } from "@/src/lib/storage/quality-types";
import { qualityCategories, qualityCategoryLabels, qualityLocation } from "@/src/lib/quality-presentation";
import { findingSourceIds, renderDataQualityReport } from "@/src/lib/quality-report";
import { downloadHtmlReport } from "@/src/lib/download-report";
import { ArchiveZipExport } from "./archive-zip-export";

const PAGE_SIZE = 25;
const selectClass = "h-10 w-full min-w-0 rounded-md border bg-white px-3 text-xs text-slate-700 focus-visible:outline-2 focus-visible:outline-emerald-700";
const primaryCategories: QualityCategory[] = ["incomplete", "exact-duplicate", "invalid-date", "conflict"];

function EvidenceRecord({ source }: { source: QualitySourceEvidence }) {
  return <SourceReferenceView source={{
    id: source.sourceReferenceId, importId: source.importId, recordId: source.recordId,
    kind: "normalized", recordNumber: source.recordNumber, dataRowNumber: source.dataRowNumber,
    source: { fileName: source.fileName, rowNumber: source.dataRowNumber, recordNumber: source.recordNumber, rawText: source.rawText,
      values: [], cells: source.columns.map((cell) => ({ ...cell, fileName: source.fileName, rowNumber: source.dataRowNumber, recordNumber: source.recordNumber })),
    },
  }} />;
}

function FindingEvidence({ ids, sources }: { ids: string[]; sources: Map<string, QualitySourceEvidence> }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const index = Math.min(page, Math.max(0, Math.ceil(ids.length / 5) - 1));
  return <details className="mt-3 rounded-lg border bg-white p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer rounded text-xs font-medium text-emerald-800 focus-visible:outline-2 focus-visible:outline-emerald-700">View source evidence</summary>
    {open && <div className="min-w-0 space-y-4">
      {ids.slice(index * 5, index * 5 + 5).map((id) => {
        const source = sources.get(id);
        return source ? <EvidenceRecord key={id} source={source} /> : <p key={id} className="mt-3 text-xs text-slate-500">The original source is unavailable in this snapshot.</p>;
      })}
      {ids.length > 5 && <HistoryPagination total={ids.length} count={Math.min(5, ids.length - index * 5)} pageSize={5} pageIndex={index} label="source records" onChange={setPage} />}
    </div>}
  </details>;
}

export function ImportQualityTable({ snapshot }: { snapshot: DataQualitySnapshot }) {
  return <Table aria-label="Import quality by file" className="min-w-[1080px] text-xs" containerProps={{ role: "region", "aria-label": "Import quality table scroll area", tabIndex: 0 }}>
    <TableHeader><TableRow><TableHead scope="col">File and coverage</TableHead><TableHead scope="col">Parsed rows</TableHead><TableHead scope="col">Mapped records checked</TableHead><TableHead scope="col">Records with findings</TableHead>{primaryCategories.map((category) => <TableHead key={category} scope="col">{qualityCategoryLabels[category]}</TableHead>)}<TableHead scope="col">Findings</TableHead></TableRow></TableHeader>
    <TableBody>{snapshot.files.map((file) => <TableRow key={file.importId}>
      <TableCell className="max-w-96 align-top"><p className="whitespace-pre-wrap break-words font-medium text-slate-900 [overflow-wrap:anywhere]">{file.fileName}</p><p className="mt-1 text-[11px] text-slate-500">CSV status: {file.status} · Mapping: {file.schemaStatus}</p>
        <details className="mt-3"><summary className="cursor-pointer text-emerald-800">File coverage and diagnostics</summary><div className="mt-2 space-y-2 text-[11px] leading-5 text-slate-600">
          <p>{file.withheldRecords} withheld records. {file.storedDiagnosticCount} saved diagnostics.</p>
          <p>{file.parserDiagnosticCounts ? `Parser totals: ${file.parserDiagnosticCounts.error} errors, ${file.parserDiagnosticCounts.warning} warnings, ${file.parserDiagnosticCounts.info} notices.` : "Parser totals unavailable."}</p>
          <p>Diagnostic totals count messages, not affected records.</p>
          <dl className="space-y-1">{qualityCategories.map((category) => <div key={category}><dt className="inline font-medium">{qualityCategoryLabels[category]}: </dt><dd className="inline">{file.categoryRecordCounts[category]} records · {file.categoryFindingCounts[category]} findings</dd></div>)}</dl>
          <ul className="list-disc space-y-1 pl-4">{file.coverageNotes.map((note) => <li key={note}>{note}</li>)}</ul>
          {file.unmappedColumns.length > 0 && <p>Unmapped columns: {file.unmappedColumns.map((column) => `${column.column}: ${column.header}`).join(", ")}</p>}
        </div></details>
      </TableCell><TableCell className="align-top tabular-nums">{file.totalRows.toLocaleString()}</TableCell><TableCell className="align-top tabular-nums">{file.analyzedRecords.toLocaleString()}</TableCell><TableCell className="align-top tabular-nums">{file.affectedRecordCount.toLocaleString()}</TableCell>{primaryCategories.map((category) => <TableCell key={category} className="align-top tabular-nums">{file.categoryRecordCounts[category].toLocaleString()}</TableCell>)}<TableCell className="align-top tabular-nums">{file.findingCount.toLocaleString()}</TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

export function QualityFindingsTable({ snapshot, findings }: { snapshot: DataQualitySnapshot; findings: DataQualityFinding[] }) {
  const sources = useMemo(() => new Map(snapshot.sources.map((source) => [source.sourceReferenceId, source])), [snapshot.sources]);
  return <Table aria-label="Quality findings" className="min-w-[760px] text-xs" containerProps={{ role: "region", "aria-label": "Quality findings table scroll area", tabIndex: 0 }}>
    <TableHeader><TableRow><TableHead scope="col">Category</TableHead><TableHead scope="col">Finding</TableHead><TableHead scope="col">Original source</TableHead></TableRow></TableHeader>
    <TableBody>{findings.map((finding) => {
      const ids = findingSourceIds(snapshot, finding);
      return <TableRow key={finding.id}>
        <TableCell className="w-40 align-top"><p className="font-medium text-slate-800">{qualityCategoryLabels[finding.category]}</p><span className="mt-2 inline-block rounded border bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">{finding.severity}</span></TableCell>
        <TableCell className="max-w-xl align-top"><p className="whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">{finding.message}</p>{finding.code && <p className="mt-2 text-[10px] text-slate-500">{finding.code}</p>}</TableCell>
        <TableCell className="w-96 max-w-xl align-top"><p className="whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]">{finding.fileName}</p><p className="mt-1 text-[11px] text-slate-500">{qualityLocation(finding)}</p>
          {ids.length > 0 ? <FindingEvidence key={`${finding.id}:${snapshot.generatedAt}`} ids={ids} sources={sources} /> : <p className="mt-3 text-[11px] leading-5 text-slate-500">No row-level source was retained for this finding.</p>}
        </TableCell>
      </TableRow>;
    })}</TableBody>
  </Table>;
}

export function DataQualityResults({ snapshot }: { snapshot: DataQualitySnapshot }) {
  const [file, setFile] = useState("");
  const [category, setCategory] = useState<QualityCategory | "">("");
  const [page, setPage] = useState(0);
  const findings = useMemo(() => snapshot.findings.filter((finding) => (!file || finding.importId === file) && (!category || finding.category === category)), [snapshot.findings, file, category]);
  const index = Math.min(page, Math.max(0, Math.ceil(findings.length / PAGE_SIZE) - 1));
  const rows = findings.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
  if (snapshot.files.length === 0) return <HistoryEmpty title="No saved imports" importLink>Import files to review their recorded values and data quality. No record quality has been assessed yet.</HistoryEmpty>;
  return <div className="space-y-6">
    <dl aria-label="Data quality overview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
      ["Saved files", snapshot.totals.fileCount], ["Mapped records checked", snapshot.totals.analyzedRecords], ["Records with findings", snapshot.totals.affectedRecordCount], ["Findings", snapshot.totals.findingCount],
    ].map(([label, value]) => <div key={label} className="rounded-xl border bg-white p-5"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">{typeof value === "number" ? value.toLocaleString() : value}</dd></div>)}</dl>
    <section aria-labelledby="file-quality-heading" className="min-w-0 overflow-hidden rounded-xl border bg-white">
      <div className="border-b p-5"><h2 id="file-quality-heading" className="text-sm font-semibold">Import quality by file</h2><p className="mt-2 text-xs leading-5 text-slate-500">Counts describe distinct preserved records, including every member of an exact duplicate group. Categories overlap; a record may need review for more than one reason.</p></div>
      <ImportQualityTable snapshot={snapshot} />
    </section>
    <section aria-label="Quality findings" className="min-w-0 overflow-hidden rounded-xl border bg-white">
      <div className="border-b p-5"><h2 className="text-sm font-semibold">Quality findings</h2><p className="mt-2 text-xs leading-5 text-slate-500">Incomplete records have missing purchase-history fields; this does not by itself mean the order is invalid. Shared order numbers are possible overlaps, not confirmed duplicates.</p></div>
      <div className="flex flex-wrap items-end gap-3 border-b bg-slate-50/50 p-5">
        <label className="w-full min-w-0 text-[11px] text-slate-500 sm:max-w-sm sm:flex-1"><span className="mb-1.5 block">Filter by file</span><select aria-label="Filter by file" value={file} onChange={(event) => { setFile(event.target.value); setPage(0); }} className={selectClass}><option value="">All files</option>{snapshot.files.map((entry, position) => <option key={entry.importId} value={entry.importId}>{entry.fileName} · import {position + 1}</option>)}</select></label>
        <label className="w-full min-w-0 text-[11px] text-slate-500 sm:max-w-xs sm:flex-1"><span className="mb-1.5 block">Filter by category</span><select aria-label="Filter by category" value={category} onChange={(event) => { setCategory(event.target.value as QualityCategory | ""); setPage(0); }} className={selectClass}><option value="">All categories</option>{qualityCategories.map((entry) => <option key={entry} value={entry}>{qualityCategoryLabels[entry]} ({snapshot.totals.categoryFindingCounts[entry]})</option>)}</select></label>
        {(file || category) && <Button size="sm" variant="ghost" onClick={() => { setFile(""); setCategory(""); setPage(0); }}>Clear filters</Button>}
      </div>
      {rows.length ? <QualityFindingsTable snapshot={snapshot} findings={rows} /> : <HistoryEmpty title="No matching findings">No saved findings match these filters. Review file coverage before treating missing findings as evidence of complete data.</HistoryEmpty>}
      <HistoryPagination total={findings.length} pageIndex={index} pageSize={PAGE_SIZE} count={rows.length} label="findings" onChange={setPage} />
    </section>
    <details className="rounded-xl border bg-white p-5"><summary className="cursor-pointer text-sm font-semibold text-slate-800">Coverage and counting rules</summary><ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-6 text-slate-600">{snapshot.coverageNotes.map((note) => <li key={note}>{note}</li>)}</ul></details>
  </div>;
}

export default function DataQualityDashboard() {
  const revision = useArchiveRevision();
  const [refresh, setRefresh] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const result = useDashboardQuery({ operation: "data-quality" }, revision + refresh);
  function download() {
    if (!result.data) return;
    setDownloadError("");
    try {
      downloadHtmlReport(renderDataQualityReport(result.data), `stocky-data-quality-${result.data.generatedAt.slice(0, 10)}.html`);
    } catch {
      setDownloadError("The HTML report could not be prepared. Retry the download; your saved records have not changed.");
    }
  }
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-2xl"><p className="mb-2 text-xs text-slate-500">Your purchase history</p><h1 className="text-3xl font-semibold tracking-tight text-slate-950">Data quality</h1><p className="mt-3 text-sm leading-6 text-slate-500">Review missing values, duplicate source records, invalid dates, and conflicts in your saved files. Every finding stays connected to its original evidence.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)} disabled={result.loading}><RefreshCw className="size-3.5" aria-hidden="true" />Refresh quality</Button><Button size="sm" onClick={download} disabled={!result.data || result.loading}><Download className="size-3.5" aria-hidden="true" />Download HTML report</Button></div></div>
    <p className="flex items-start gap-2 rounded-lg border border-emerald-100 bg-emerald-50/60 p-4 text-xs leading-5 text-emerald-950"><FileCheck2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>The download includes all file summaries, findings, and their retained source evidence, including results hidden by filters. It works offline and is created entirely in this browser.</span></p>
    <ArchiveZipExport hasImports={Boolean(result.data?.files.length)} loading={result.loading} />
    {downloadError && <p role="alert" className="text-sm text-red-800">{downloadError}</p>}
    <HistoryState loading={result.loading} error={result.error} onRetry={() => setRefresh((value) => value + 1)}>{result.data && <DataQualityResults snapshot={result.data} />}</HistoryState>
  </div>;
}
