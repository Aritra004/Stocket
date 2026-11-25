import type { CsvImportResult } from "./types";
import { validateFile } from "./validators";

export interface ImportEntry {
  id: string;
  file: File;
  phase: "queued" | "parsing" | "complete";
  result?: CsvImportResult;
}

export interface ImportSession {
  entries: ImportEntry[];
  selectedId: string | null;
  batch: { ids: string[]; completed: number } | null;
}

export type ImportSessionAction =
  | { type: "add"; entries: ImportEntry[] }
  | { type: "remove"; id: string }
  | { type: "clear" }
  | { type: "start"; ids: string[] }
  | { type: "parsing"; id: string }
  | { type: "result"; id: string; result: CsvImportResult }
  | { type: "finish" }
  | { type: "select"; id: string };

export const initialImportSession: ImportSession = {
  entries: [],
  selectedId: null,
  batch: null,
};

/** Preflight failures can be reviewed immediately; valid files still need parsing. */
export function createImportEntries(files: File[]): ImportEntry[] {
  return files.map((file) => {
    const preflight = validateFile(file);
    const id = crypto.randomUUID();
    return preflight.errorCount > 0
      ? { id, file, phase: "complete", result: preflight }
      : { id, file, phase: "queued" };
  });
}

/** Labels disambiguate selections; names and content are never used as identity. */
export function getImportFileLabels(entries: ImportEntry[]): Map<string, string> {
  const totals = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const entry of entries) totals.set(entry.file.name, (totals.get(entry.file.name) ?? 0) + 1);
  return new Map(entries.map((entry) => {
    const position = (positions.get(entry.file.name) ?? 0) + 1;
    positions.set(entry.file.name, position);
    const total = totals.get(entry.file.name) ?? 1;
    return [entry.id, total > 1 ? `${entry.file.name} (file ${position} of ${total})` : entry.file.name];
  }));
}

function firstCompletedId(entries: ImportEntry[]): string | null {
  return entries.find((entry) => entry.phase === "complete")?.id ?? null;
}

/** Session-only state; files and results are never persisted or sent elsewhere. */
export function importSessionReducer(
  state: ImportSession,
  action: ImportSessionAction,
): ImportSession {
  switch (action.type) {
    case "add": {
      if (state.batch) return state;
      const seen = new Set(state.entries.map((entry) => entry.id));
      const additions = action.entries.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      if (additions.length === 0) return state;
      const entries = [...state.entries, ...additions];
      return {
        ...state,
        entries,
        selectedId: state.selectedId ?? firstCompletedId(entries),
      };
    }
    case "remove": {
      if (state.batch) return state;
      const entries = state.entries.filter((entry) => entry.id !== action.id);
      if (entries.length === state.entries.length) return state;
      return {
        ...state,
        entries,
        selectedId: state.selectedId === action.id ? firstCompletedId(entries) : state.selectedId,
      };
    }
    case "clear":
      return state.batch ? state : initialImportSession;
    case "start": {
      if (state.batch) return state;
      const queued = new Set(state.entries.filter((entry) => entry.phase === "queued").map((entry) => entry.id));
      const ids = [...new Set(action.ids)].filter((id) => queued.has(id));
      return ids.length > 0 ? { ...state, batch: { ids, completed: 0 } } : state;
    }
    case "parsing": {
      if (!state.batch?.ids.includes(action.id)) return state;
      const entry = state.entries.find((item) => item.id === action.id);
      if (entry?.phase !== "queued") return state;
      return {
        ...state,
        entries: state.entries.map((item) => item.id === action.id ? { ...item, phase: "parsing" } : item),
      };
    }
    case "result": {
      if (!state.batch?.ids.includes(action.id)) return state;
      const entry = state.entries.find((item) => item.id === action.id);
      if (!entry || entry.phase === "complete") return state;
      const entries = state.entries.map((item): ImportEntry => item.id === action.id
        ? { ...item, phase: "complete", result: action.result }
        : item);
      return {
        ...state,
        entries,
        batch: { ...state.batch, completed: state.batch.completed + 1 },
        selectedId: state.selectedId ?? firstCompletedId(entries),
      };
    }
    case "finish":
      if (!state.batch) return state;
      return {
        ...state,
        entries: state.entries.map((entry) => entry.phase === "parsing" ? { ...entry, phase: "queued" } : entry),
        batch: null,
      };
    case "select":
      return state.entries.some((entry) => entry.id === action.id && entry.phase === "complete")
        ? { ...state, selectedId: action.id }
        : state;
  }
}

export function summarizeImports(entries: ImportEntry[]) {
  return entries.reduce((summary, entry) => {
    summary.totalFiles += 1;
    summary.totalBytes += entry.file.size;
    if (entry.phase !== "complete" || !entry.result) {
      summary.pending += 1;
      return summary;
    }
    summary.totalRows += entry.result.totalRows;
    if (entry.result.status === "success" || entry.result.status === "warning") {
      summary.successful += 1;
      if (entry.result.status === "warning") summary.warnings += 1;
    } else {
      summary.failed += 1;
    }
    return summary;
  }, { totalFiles: 0, totalRows: 0, successful: 0, failed: 0, warnings: 0, pending: 0, totalBytes: 0 });
}
