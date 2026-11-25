import CsvImporter from "@/src/components/csv-importer";
import { WorkspaceShell } from "@/src/components/workspace-shell";

export default function ImportPage() {
  return <WorkspaceShell active="import">
    <div className="mb-8"><p className="mb-3 text-xs font-medium text-slate-500">Workspace <span aria-hidden="true" className="mx-2 text-slate-300">/</span> CSV import</p><h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-[34px]">Import your purchase history</h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-500">Bring your Stocky CSV exports together. Check your files and preview your data, all from the privacy of your browser.</p></div>
    <CsvImporter />
  </WorkspaceShell>;
}
