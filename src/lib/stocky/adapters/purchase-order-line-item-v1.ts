import { deriveOutstanding, readCurrency, readDate, readDecimal, readText } from "../field-values";
import { LINE_ITEM_V1 } from "../schemas";
import type { NormalizedRecord, RecordSource } from "../types";

/** Explicit mappings for the checked-in, unverified line-item fixture contract. */
export function normalizePurchaseOrderLineItemV1(source: RecordSource): Extract<NormalizedRecord, { kind: "purchase-order-line-item" }> {
  const orderedQuantity = readDecimal(source, "Ordered Quantity");
  const receivedQuantity = readDecimal(source, "Received Quantity");
  return {
    adapterId: LINE_ITEM_V1.id,
    adapterVersion: LINE_ITEM_V1.version,
    kind: "purchase-order-line-item",
    source,
    issues: [],
    fields: {
      purchaseOrderNumber: readText(source, "PO Number"),
      lineId: readText(source, "Line ID"),
      sku: readText(source, "SKU"),
      productName: readText(source, "Product Name"),
      supplier: readText(source, "Supplier"),
      orderDate: readDate(source, "Order Date"),
      currency: readCurrency(source, "Currency"),
      unitCost: readDecimal(source, "Unit Cost"),
      orderedQuantity,
      receivedQuantity,
      outstandingQuantity: deriveOutstanding(orderedQuantity, receivedQuantity),
    },
  };
}
