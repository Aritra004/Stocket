"use client";

import { useSyncExternalStore } from "react";
import { FieldValue, observedValue, type DisplayField } from "./dashboard/field-value";
import { purchaseOrderHref, readHistorySelection, readOrderSelection, skuHref, supplierHref } from "@/src/lib/history-navigation";

const SELECTION_EVENT = "stocky-history-selection";
const getSnapshot = () => window.location.hash;
const getServerSnapshot = () => "";
function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener(SELECTION_EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(SELECTION_EVENT, onChange);
  };
}

export function useHistorySelection(kind: "supplier" | "sku") {
  const fragment = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { value: readHistorySelection(kind, fragment) };
}

export function useOrderSelection() {
  const fragment = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return readOrderSelection(fragment);
}

export function selectPurchaseOrder(id: string | null) {
  // Keep the Next.js history state and the current scroll position. Closing a
  // drawer replaces its selection so Back does not reopen a dismissed record.
  if (id === null) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  else window.history.pushState(window.history.state, "", purchaseOrderHref(id));
  window.dispatchEvent(new Event(SELECTION_EVENT));
}

const linkClass = "whitespace-pre-wrap break-words rounded text-emerald-900 underline decoration-emerald-200 underline-offset-4 hover:decoration-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700 [overflow-wrap:anywhere]";

export function ObservedSupplierLink({ field }: { field: DisplayField }) {
  const value = observedValue(field);
  return value === null ? <FieldValue field={field} /> : <a href={supplierHref(value)} className={linkClass}><FieldValue field={field} /></a>;
}

export function ObservedSkuLink({ field }: { field: DisplayField }) {
  const value = observedValue(field);
  return value === null ? <FieldValue field={field} /> : <a href={skuHref(value)} className={`${linkClass} font-mono`}><FieldValue field={field} /></a>;
}
