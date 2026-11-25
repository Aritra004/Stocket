import { deriveOutstanding, readCurrency, readDate, readDecimal, readText } from "../field-values";
import { SUMMARY_V1 } from "../schemas";
import type { NormalizedRecord, RecordSource } from "../types";

/** Explicit mappings for the checked-in, unverified summary fixture contract. */
export function normalizePurchaseOrderSummaryV1(source: RecordSource): Extract<NormalizedRecord, { kind: "purchase-order-summary" }> {
  const orderedQuantity = readDecimal(source, "Ordered Quantity");
  const receivedQuantity = readDecimal(source, "Received Quantity");
  return {
    adapterId: SUMMARY_V1.id,
    adapterVersion: SUMMARY_V1.version,
    kind: "purchase-order-summary",
    source,
    issues: [],
    fields: {
      purchaseOrderNumber: readText(source, "PO Number"),
      supplier: readText(source, "Supplier"),
      status: readText(source, "Status"),
      orderDate: readDate(source, "Order Date"),
      expectedDate: readDate(source, "Expected Date"),
      currency: readCurrency(source, "Currency"),
      totalCost: readDecimal(source, "Total Cost"),
      orderedQuantity,
      receivedQuantity,
      outstandingQuantity: deriveOutstanding(orderedQuantity, receivedQuantity),
    },
  };
}
