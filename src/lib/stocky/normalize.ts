import { normalizePurchaseOrderSummaryV1 } from "./adapters/purchase-order-summary-v1";
import { normalizePurchaseOrderLineItemV1 } from "./adapters/purchase-order-line-item-v1";
import { conflictField, deriveOutstanding } from "./field-values";
import { SUMMARY_V1, LINE_ITEM_V1 } from "./schemas";
import type {
  NormalizedField,
  NormalizedImport,
  NormalizedRecord,
  RecordSource,
} from "./types";
import type { ValidationIssue } from "../importer/types";

const fieldLabels: Record<string, string> = {
  purchaseOrderNumber: "Purchase order number",
  lineId: "Line ID",
  sku: "SKU",
  productName: "Product name",
  supplier: "Supplier",
  status: "Status",
  orderDate: "Order date",
  expectedDate: "Expected date",
  currency: "Currency",
  totalCost: "Total cost",
  unitCost: "Unit cost",
  orderedQuantity: "Ordered quantity",
  receivedQuantity: "Received quantity",
  outstandingQuantity: "Outstanding quantity",
};

export function createNormalizedImport(): NormalizedImport {
  return {
    schema: { status: "not-detected" },
    records: [],
    withheldRecords: [],
    fieldCounts: {
      missing: 0,
      observed: 0,
      derived: 0,
      conflicting: 0,
      invalid: 0,
    },
  };
}

export function appendNormalizedRecord(
  output: NormalizedImport,
  source: RecordSource,
  csvIssues: ValidationIssue[],
): void {
  if (output.schema.status !== "matched") return;
  if (
    csvIssues.some(
      (issue) => issue.category === "parsing" || issue.category === "structure",
    )
  ) {
    output.withheldRecords.push({
      source,
      issues: [...csvIssues],
      reason:
        "The CSV structure of this record needs review. Its original text and values are retained, but no normalized fields were created.",
    });
    return;
  }
  try {
    switch (output.schema.adapter.id) {
      case SUMMARY_V1.id:
        output.records.push(normalizePurchaseOrderSummaryV1(source));
        break;
      case LINE_ITEM_V1.id:
        output.records.push(normalizePurchaseOrderLineItemV1(source));
        break;
      default:
        throw new Error("Adapter not registered");
    }
  } catch {
    output.withheldRecords.push({
      source,
      reason:
        "This record could not be normalized. Its original text and values remain available; other records can still be reviewed.",
      issues: [
        {
          severity: "warning",
          category: "schema",
          code: "NormalizationFailed",
          message:
            "No normalized values were created for this record. The original record is unchanged.",
          row: source.recordNumber,
        },
      ],
    });
  }
}

function groupBy<T>(
  records: T[],
  identity: (record: T) => string | null,
): T[][] {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = identity(record);
    if (key !== null) {
      const group = groups.get(key);
      if (group) group.push(record);
      else groups.set(key, [record]);
    }
  }
  return [...groups.values()];
}

/** Called only with one typed model and its declared field keys. No field aliases. */
function applyConflicts<F>(
  group: Array<{ fields: F }>,
  names: readonly (keyof F)[],
): void {
  for (const name of names) {
    // Every adapter field is a NormalizedField of a string or branded string.
    const fields = group.map(
      (record) => record.fields[name],
    ) as NormalizedField<string>[];
    const conflict = conflictField(fields);
    if (!conflict) continue;
    group.forEach((record, index) => {
      if (
        fields[index].state === "observed" ||
        fields[index].state === "derived"
      ) {
        // All alternatives came from this same model/field, preserving its brand.
        record.fields[name] = conflict as F[keyof F];
      }
    });
  }
}

function knownText(field: NormalizedField<string>): string | null {
  return field.state === "observed" ? field.value : null;
}

/** Within-file comparisons only. Records stay separate and missing fields stay missing. */
export function finalizeNormalization(output: NormalizedImport): void {
  const summaries = output.records.filter(
    (
      record,
    ): record is Extract<
      NormalizedRecord,
      { kind: "purchase-order-summary" }
    > => record.kind === "purchase-order-summary",
  );
  for (const group of groupBy(summaries, (record) =>
    knownText(record.fields.purchaseOrderNumber),
  )) {
    applyConflicts(group, [
      "supplier",
      "status",
      "orderDate",
      "expectedDate",
      "currency",
      "totalCost",
      "orderedQuantity",
      "receivedQuantity",
    ]);
  }
  const lines = output.records.filter(
    (
      record,
    ): record is Extract<
      NormalizedRecord,
      { kind: "purchase-order-line-item" }
    > => record.kind === "purchase-order-line-item",
  );
  for (const group of groupBy(lines, (record) =>
    knownText(record.fields.purchaseOrderNumber),
  )) {
    applyConflicts(group, ["supplier", "currency", "orderDate"]);
  }
  for (const group of groupBy(lines, (record) => {
    const order = knownText(record.fields.purchaseOrderNumber);
    const line = knownText(record.fields.lineId);
    return order !== null && line !== null
      ? JSON.stringify([order, line])
      : null;
  })) {
    applyConflicts(group, [
      "sku",
      "productName",
      "unitCost",
      "orderedQuantity",
      "receivedQuantity",
    ]);
  }

  output.fieldCounts = {
    missing: 0,
    observed: 0,
    derived: 0,
    conflicting: 0,
    invalid: 0,
  };
  for (const record of output.records) {
    // A quantity that becomes conflicting must not leave a stale derived value.
    // Keep only this record's input evidence on the dependent field. The quantity
    // fields already retain all competing sources in a shared conflict object;
    // copying those sources into every dependent field would grow quadratically.
    if (
      record.fields.orderedQuantity.state === "conflicting" ||
      record.fields.receivedQuantity.state === "conflicting"
    ) {
      record.fields.outstandingQuantity = {
        state: "invalid",
        value: null,
        reason:
          "Outstanding quantity cannot be calculated from conflicting quantities.",
        sources: record.fields.outstandingQuantity.sources,
      };
    } else {
      record.fields.outstandingQuantity = deriveOutstanding(
        record.fields.orderedQuantity,
        record.fields.receivedQuantity,
      );
    }
    record.issues = [];
    for (const [name, field] of Object.entries(record.fields) as Array<
      [string, NormalizedField<string>]
    >) {
      output.fieldCounts[field.state] += 1;
      if (field.state === "invalid" || field.state === "conflicting") {
        // Look at this row's small source set rather than scanning the entire
        // conflict group's sources once for every row in that group.
        const sourceColumn = field.sources[0]?.column;
        const ownCell =
          sourceColumn === undefined
            ? undefined
            : record.source.cells[sourceColumn - 1];
        record.issues.push({
          severity: "warning",
          category: "schema",
          code:
            field.state === "invalid"
              ? "InvalidNormalizedValue"
              : "ConflictingNormalizedValue",
          message: `${fieldLabels[name] ?? name}: ${field.reason}`,
          row: record.source.recordNumber,
          ...(ownCell && name !== "outstandingQuantity"
            ? { column: ownCell.column }
            : {}),
        });
      }
      if (
        field.state === "missing" &&
        (name === "purchaseOrderNumber" || name === "lineId")
      ) {
        record.issues.push({
          severity: "warning",
          category: "schema",
          code: "MissingRecordIdentity",
          message: `The ${name === "lineId" ? "line identifier" : "purchase-order number"} is missing. This record was kept separately without guessing its identity.`,
          row: record.source.recordNumber,
        });
      }
    }
  }
}
