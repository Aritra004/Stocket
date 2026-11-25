/** Entity values live in fragments, which are not included in HTTP requests. */
export function supplierHref(name: string | null): string {
  return name === null ? "/suppliers#missing=1" : `/suppliers#${new URLSearchParams({ name })}`;
}

export function skuHref(sku: string): string {
  return `/skus#${new URLSearchParams({ sku })}`;
}

export function purchaseOrderHref(id: string): string {
  return `/#${new URLSearchParams({ order: id })}`;
}

export function readHistorySelection(kind: "supplier" | "sku", fragment: string): string | null | undefined {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const key = kind === "supplier" ? "name" : "sku";
  if (params.has(key)) return params.get(key)!;
  if (kind === "supplier" && params.get("missing") === "1") return null;
  return undefined;
}

export function readOrderSelection(fragment: string): string | null {
  return new URLSearchParams(fragment.replace(/^#/, "")).get("order") || null;
}
