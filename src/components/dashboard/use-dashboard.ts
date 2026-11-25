"use client";

import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { createArchiveDatabase } from "@/src/lib/storage/database";
import { dashboardRequest } from "@/src/lib/storage/dashboard-client";
import type {
  DashboardRequest,
  DashboardResponses,
} from "@/src/lib/storage/dashboard-operations";

export function useArchiveRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const db = createArchiveDatabase();
    const refresh = () => setRevision((value) => value + 1);
    // Only file metadata is observed on the UI thread. Dexie propagates commits
    // from importer workers and other tabs, including same-count replacements.
    const subscription = liveQuery(() => db.importedFiles.toArray()).subscribe({
      next: refresh,
      error: refresh,
    });
    window.addEventListener("focus", refresh);
    return () => {
      subscription.unsubscribe();
      db.close();
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return revision;
}

export function useDashboardQuery<R extends DashboardRequest>(
  request: R | null,
  revision: number,
) {
  type Result = DashboardResponses[R["operation"]];
  const key = JSON.stringify([request, revision]);
  const [result, setResult] = useState<{
    key: string;
    data?: Result;
    error: string;
  }>();
  useEffect(() => {
    const [current] = JSON.parse(key) as [R | null, number];
    if (!current) return;
    const controller = new AbortController();
    void dashboardRequest(current, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data, error: "" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            error:
              error instanceof Error
                ? error.message
                : "Purchase history could not be read. Retry the query.",
          });
      });
    return () => controller.abort();
  }, [key]);
  const current = result?.key === key ? result : undefined;
  return {
    data: current?.data,
    error: current?.error ?? "",
    loading: request !== null && !current,
  };
}

export function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
