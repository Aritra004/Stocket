/// <reference lib="webworker" />

import {
  dashboardErrorMessage,
  executeDashboardRequest,
  type DashboardRequest,
} from "./dashboard-operations";

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<DashboardRequest>) => {
  try {
    worker.postMessage({
      type: "result",
      value: await executeDashboardRequest(event.data),
    });
  } catch (error) {
    worker.postMessage({
      type: "error",
      message: dashboardErrorMessage(error),
    });
  }
};
worker.postMessage({ type: "ready" });
