import type {
  DashboardRequest,
  DashboardResponses,
} from "./dashboard-operations";

async function fallback<R extends DashboardRequest>(
  request: R,
  signal?: AbortSignal,
): Promise<DashboardResponses[R["operation"]]> {
  signal?.throwIfAborted();
  const { executeDashboardRequest, dashboardErrorMessage } =
    await import("./dashboard-operations");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    return await executeDashboardRequest(request, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(dashboardErrorMessage(error));
  }
}

/** History reads are paged; quality and offline exports return full snapshots. Obsolete reads are terminated. */
export async function dashboardRequest<R extends DashboardRequest>(
  request: R,
  signal?: AbortSignal,
): Promise<DashboardResponses[R["operation"]]> {
  if (typeof window === "undefined")
    throw new Error("Purchase history is available only in your browser.");
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") return fallback(request, signal);
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let started = false;
    let settled = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", abort);
      worker?.terminate();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Query cancelled", "AbortError"));
    };
    const failure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!started) void fallback(request, signal).then(resolve, reject);
      else
        reject(
          new Error(
            "The purchase-history query was interrupted. Retry to read the archive again.",
          ),
        );
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      worker = new Worker(new URL("./dashboard.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onerror = failure;
      worker.onmessageerror = failure;
      worker.onmessage = (event: MessageEvent) => {
        if (settled) return;
        if (event.data.type === "ready" && !started) {
          started = true;
          clearTimeout(startupTimer);
          try {
            worker!.postMessage(request);
          } catch {
            failure();
          }
        } else if (
          event.data.type === "result" ||
          event.data.type === "error"
        ) {
          settled = true;
          cleanup();
          if (event.data.type === "error")
            reject(new Error(event.data.message));
          else resolve(event.data.value);
        }
      };
      startupTimer = setTimeout(failure, 5000);
    } catch {
      failure();
    }
  });
}

export function loadDashboardSource(id: string, signal?: AbortSignal) {
  return dashboardRequest({ operation: "source", id }, signal);
}
