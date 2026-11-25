(() => {
  type Archive = import("./types").OfflineArchive;
  type RecordRow = import("./types").OfflineRecord;
  type Field = import("./types").OfflineField;
  type Source = import("./types").OfflineSource;
  type Finding = import("./types").OfflineFinding;
  const app = document.getElementById("offline-app");
  if (!app) return;

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(label: string, action: () => void, className = "button") {
    const node = element("button", label, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function textBlock(text: string, className = "muted") { return element("p", text, className); }
  function observed(field: Field | undefined): string | null {
    return field?.state === "observed" && typeof field.value === "string" ? field.value : null;
  }
  function value(field: Field | undefined): HTMLElement {
    const literal = observed(field);
    if (literal !== null) return element("span", literal, "literal");
    const labels = new Map<string, string>([["missing", "Not provided"], ["invalid", "Invalid value"], ["conflicting", "Conflicting values"], ["derived", "Calculated · not imported"]]);
    return element("span", labels.get(field?.state ?? "missing") ?? "Not provided", "field-state");
  }
  function empty(title: string, detail: string) {
    const box = element("div", undefined, "empty");
    box.append(element("h3", title), textBlock(detail));
    return box;
  }
  function disclosure(label: string, build: () => Node): HTMLDetailsElement {
    const details = element("details", undefined, "disclosure");
    details.append(element("summary", label));
    let mounted = false;
    details.addEventListener("toggle", () => {
      if (details.open && !mounted) { mounted = true; details.append(build()); }
    });
    return details;
  }
  function table(headers: string[], rows: Array<Array<Node | string>>, label: string) {
    const wrap = element("div", undefined, "table-scroll");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", `${label} table scroll area`);
    const grid = element("table");
    grid.setAttribute("aria-label", label);
    const head = element("thead");
    const headRow = element("tr");
    for (const label of headers) { const cell = element("th", label); cell.scope = "col"; headRow.append(cell); }
    head.append(headRow);
    const body = element("tbody");
    for (const cells of rows) {
      const row = element("tr");
      for (const content of cells) { const cell = element("td"); cell.append(typeof content === "string" ? document.createTextNode(content) : content); row.append(cell); }
      body.append(row);
    }
    grid.append(head, body);
    wrap.append(grid);
    return wrap;
  }
  function paged<T>(items: T[], label: string, render: (rows: T[]) => Node, size = 25) {
    const container = element("div");
    let page = 0;
    function paint() {
      const start = page * size;
      const slice = items.slice(start, start + size);
      const controls = element("div", undefined, "pagination");
      const count = textBlock(`${items.length ? start + 1 : 0}–${start + slice.length} of ${items.length} ${label}`);
      count.setAttribute("role", "status");
      const previous = button("Previous", () => { page -= 1; paint(); });
      previous.disabled = page === 0;
      previous.setAttribute("aria-label", `Previous ${label}`);
      const next = button("Next", () => { page += 1; paint(); });
      next.disabled = start + size >= items.length;
      next.setAttribute("aria-label", `Next ${label}`);
      controls.append(count, previous, textBlock(`Page ${page + 1} of ${Math.max(1, Math.ceil(items.length / size))}`), next);
      container.replaceChildren(render(slice), controls);
    }
    paint();
    return container;
  }
  function searchInput(label: string, onInput: (value: string) => void) {
    const wrap = element("label", undefined, "control");
    const input = element("input");
    input.type = "search";
    input.setAttribute("aria-label", label);
    input.placeholder = label;
    input.addEventListener("input", () => onInput(input.value));
    wrap.append(element("span", label), input);
    return wrap;
  }
  function selectInput(label: string, choices: Array<[string, string]>, onChange: (key: string) => void) {
    const wrap = element("label", undefined, "control");
    const select = element("select");
    select.setAttribute("aria-label", label);
    for (const [key, text] of choices) { const option = element("option", text); option.value = key; select.append(option); }
    select.addEventListener("change", () => onChange(select.value));
    wrap.append(element("span", label), select);
    return wrap;
  }

  try {
    const data = document.getElementById("archive-data")?.textContent;
    if (!data) throw new Error("Archive data unavailable");
    const archive = JSON.parse(data) as Archive;
    if (archive.version !== 1 || !Array.isArray(archive.records) || !Array.isArray(archive.files) || !Array.isArray(archive.sources) || !Array.isArray(archive.findings)) throw new Error("Unsupported archive");
    const files = new Map(archive.files.map((file) => [file.id, file]));
    const records = new Map(archive.records.map((record) => [record.id, record]));
    const sources = new Map(archive.sources.map((source) => [source.id, source]));
    const sourceRecordIds = new Map(archive.records.map((record) => [record.sourceId, record.id]));
    const orders = archive.records.filter((record) => record.kind === "purchase-order-summary");
    const lines = archive.records.filter((record) => record.kind === "purchase-order-line-item");
    const exact = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const byDate = (rows: RecordRow[]) => [...rows].sort((a, b) => {
      const first = observed(a.fields.orderDate); const second = observed(b.fields.orderDate);
      return first === null ? second === null ? exact(a.id, b.id) : 1 : second === null ? -1 : exact(second, first) || exact(a.id, b.id);
    });
    const fileName = (id: string) => files.get(id)?.name ?? "Source file unavailable";
    const supplierNames = [...new Set(archive.records.flatMap((record) => { const name = observed(record.fields.supplier); return name === null ? [] : [name]; }))].sort(exact);
    const skuMap = new Map<string, RecordRow[]>();
    for (const row of lines) {
      const sku = observed(row.fields.sku);
      if (sku !== null) { const group = skuMap.get(sku) ?? []; group.push(row); skuMap.set(sku, group); }
    }
    const skuNames = [...skuMap.keys()].sort(exact);
    const hero = element("header", undefined, "hero");
    const heading = element("div");
    heading.append(element("p", "LOCAL ARCHIVE", "eyebrow"), element("h1", "Stocky History Rescue"), textBlock("Browse your preserved purchase history. All records stay inside this file."));
    const stamp = element("div", undefined, "archive-stamp");
    stamp.append(element("span", "Offline viewer", "badge"), textBlock(`Exported ${archive.exportedAt}`));
    hero.append(heading, stamp);
    const nav = element("nav", undefined, "navigation");
    nav.setAttribute("aria-label", "Archive navigation");
    const content = element("div", undefined, "page");
    const navButtons = new Map<string, HTMLButtonElement>();
    const addNav = (label: string, action: () => void) => { const control = button(label, action, "nav-button"); navButtons.set(label, control); nav.append(control); };
    addNav("Purchase orders", () => showOrders());
    addNav("SKUs", () => showSkus());
    addNav("Data quality", () => showQuality());
    app.replaceChildren(hero, nav, content);

    function page(title: string, description: string, active: string, back?: { label: string; action: () => void }) {
      for (const [label, control] of navButtons) { if (label === active) control.setAttribute("aria-current", "page"); else control.removeAttribute("aria-current"); }
      content.replaceChildren();
      if (back) content.append(button(back.label, back.action, "back-button"));
      const titleNode = element("h2", title, "page-title");
      titleNode.tabIndex = -1;
      content.append(titleNode, textBlock(description, "page-description"));
      titleNode.focus({ preventScroll: true });
    }
    function sourceLocation(row: RecordRow) {
      const box = element("div", undefined, "source-location");
      const source = sources.get(row.sourceId);
      box.append(element("span", fileName(row.fileId), "literal"), textBlock(source ? `${source.dataRowNumber === null ? "Header" : `Data row ${source.dataRowNumber}`} · CSV record ${source.recordNumber}` : "Original source unavailable"));
      return box;
    }
    function sourceEvidence(id: string) {
      return disclosure("View source evidence", () => {
        const source = sources.get(id);
        if (!source) return textBlock("Original source is unavailable in this archive.");
        return sourceView(source);
      });
    }
    function textPages(raw: string) {
      if (raw === "") return element("p", "Empty string", "muted");
      const starts = [0];
      for (let start = 0; start + 2000 < raw.length;) {
        let end = start + 2000;
        const last = raw.charCodeAt(end - 1); const next = raw.charCodeAt(end);
        // Keep a Unicode surrogate pair on the same page without changing the
        // original string or allocating a code-point array for the full value.
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
        starts.push(end); start = end;
      }
      return paged(starts.map((_, index) => index), "text sections", ([index]) => element("pre", raw.slice(starts[index], starts[index + 1] ?? raw.length), "raw-text"), 1);
    }
    function sourceView(source: Source) {
      const box = element("div", undefined, "source-evidence");
      box.append(element("h4", fileName(source.fileId), "literal"), textBlock(`${source.dataRowNumber === null ? "Header" : `Data row ${source.dataRowNumber}`} · CSV record ${source.recordNumber}`));
      box.append(paged(source.cells, "source columns", (cells) => table(["Column", "Original header", "Original value"], cells.map((cell) => [String(cell.column), cell.header === null ? element("em", "Header absent") : cell.header === "" ? element("em", "Empty header") : element("span", cell.header, "literal"), cell.rawValue === null ? element("em", "Cell absent") : cell.rawValue === "" ? element("em", "Empty string") : cell.rawValue.length <= 2000 ? element("span", cell.rawValue, "literal") : disclosure("Inspect original value", () => textPages(cell.rawValue!))]), "Original source cells"), 10));
      box.append(disclosure("Original CSV record", () => textPages(source.rawText)));
      return box;
    }
    function supplierValue(row: RecordRow) {
      const name = observed(row.fields.supplier);
      return name === null ? value(row.fields.supplier) : button(name, () => showSupplier(name), "text-button literal");
    }
    function orderTable(rows: RecordRow[]) {
      return table(["Purchase order", "Supplier", "Order date", "Status", "Recorded total", "Currency", "Original source"], rows.map((row) => {
        const number = observed(row.fields.purchaseOrderNumber);
        const source = sources.get(row.sourceId);
        const control = button(number ?? "Order number unavailable", () => showOrder(row), "text-button literal");
        control.setAttribute("aria-label", `Open purchase order ${number ?? "without an observed number"} from ${fileName(row.fileId)}, data row ${source?.dataRowNumber ?? "unavailable"}`);
        return [control, supplierValue(row), value(row.fields.orderDate), value(row.fields.status), value(row.fields.totalCost), value(row.fields.currency), sourceLocation(row)];
      }), "Purchase orders");
    }
    function showOrders() {
      page("Purchase orders", "Search saved summary records and exact observed supplier names. Similar names remain separate; repeated order numbers are not merged.", "Purchase orders");
      let search = ""; let supplier: string | null | undefined;
      const supplierKeys = new Map<string, string>();
      const labels = new Set(["All suppliers", "Supplier not observed"]);
      const choices: Array<[string, string]> = [["all", "All suppliers"], ["missing", "Supplier not observed"]];
      supplierNames.forEach((name, index) => {
        const key = `supplier-${index}`; supplierKeys.set(key, name);
        let label = name;
        while (labels.has(label)) label += " (observed name)";
        labels.add(label); choices.push([key, label]);
      });
      const results = element("div", undefined, "panel");
      const refresh = () => {
        const query = search.toLowerCase();
        const filtered = byDate(orders.filter((row) => (supplier === undefined || observed(row.fields.supplier) === supplier) && [observed(row.fields.purchaseOrderNumber), observed(row.fields.supplier), fileName(row.fileId)].some((text) => text?.toLowerCase().includes(query))));
        results.replaceChildren(filtered.length ? paged(filtered, "purchase orders", orderTable) : empty(orders.length ? "No purchase orders match" : "No purchase-order summaries", orders.length ? "Change the search or supplier filter to inspect other preserved records." : "Summary-only imports appear here. Line-only imports remain available in the SKU directory; no summary is inferred."));
        if (supplier !== undefined) results.append(button("View supplier history", () => showSupplier(supplier!), "text-button section-action"));
      };
      const controls = element("div", undefined, "controls");
      controls.append(searchInput("Search purchase orders", (text) => { search = text; refresh(); }), selectInput("Filter by supplier", choices, (key) => { supplier = key === "all" ? undefined : key === "missing" ? null : supplierKeys.get(key); refresh(); }));
      content.append(controls, results); refresh();
      if (!archive.files.length) content.append(empty("No saved imports", "This viewer contains no imported records. Generate a new viewer after saving an import."));
    }
    const fieldLabels = new Map<string, string>([["purchaseOrderNumber", "Purchase-order number"], ["supplier", "Supplier"], ["status", "Status"], ["orderDate", "Order date"], ["expectedDate", "Expected date"], ["currency", "Currency"], ["totalCost", "Total cost"], ["unitCost", "Unit cost"], ["orderedQuantity", "Ordered quantity"], ["receivedQuantity", "Received quantity"], ["outstandingQuantity", "Outstanding quantity"], ["sku", "SKU"], ["lineId", "Line ID"], ["productName", "Product name"]]);
    function recordFields(row: RecordRow) {
      const grid = element("dl", undefined, "field-grid");
      for (const [key, field] of Object.entries(row.fields)) {
        const pair = element("div"); const detail = element("dd");
        const sku = key === "sku" ? observed(field) : null;
        detail.append(key === "supplier" ? supplierValue(row) : sku !== null ? button(sku, () => showSku(sku), "text-button literal") : value(field));
        pair.append(element("dt", fieldLabels.get(key) ?? key), detail); grid.append(pair);
      }
      return grid;
    }
    function showOrder(row: RecordRow) {
      const number = observed(row.fields.purchaseOrderNumber);
      page(number ?? "Purchase-order record", "Values below belong to this preserved summary record. Missing prices and quantities remain unavailable.", "Purchase orders", { label: "Back to purchase orders", action: showOrders });
      const panel = element("section", undefined, "panel padded");
      panel.setAttribute("aria-label", "Purchase-order detail");
      panel.append(recordFields(row), sourceLocation(row), sourceEvidence(row.sourceId)); content.append(panel);
      const candidates = number === null ? [] : byDate(lines.filter((line) => observed(line.fields.purchaseOrderNumber) === number));
      content.append(element("h3", "Candidate line records"), textBlock("These records share the exact observed order number. Different stores or orders can reuse a number, so no relationship or supplier is inferred."));
      content.append(candidates.length ? paged(candidates, "candidate lines", (rows) => lineTable(rows, () => showOrder(row))) : empty("No candidate line records", number === null ? "This summary has no unambiguous observed order number." : "No saved line has this exact observed order number. Summary-only imports do not establish SKU history."));
    }
    function lineTable(rows: RecordRow[], back: () => void) {
      return table(["SKU", "Order date", "Unit cost", "Currency", "Ordered quantity", "Received quantity", "Supplier", "Purchase order and source"], rows.map((row) => {
        const sku = observed(row.fields.sku);
        const reference = element("div"); reference.append(value(row.fields.purchaseOrderNumber), sourceLocation(row), button("View line details", () => showLine(row, back), "text-button"));
        return [sku === null ? value(row.fields.sku) : button(sku, () => showSku(sku), "text-button literal"), value(row.fields.orderDate), value(row.fields.unitCost), value(row.fields.currency), value(row.fields.orderedQuantity), value(row.fields.receivedQuantity), supplierValue(row), reference];
      }), "SKU purchase costs");
    }
    function showLine(row: RecordRow, back: () => void) {
      page("Line-item record", "Only observed values are displayed as imported amounts. Costs keep their recorded currencies; no conversion or total is inferred.", "SKUs", { label: "Back to history", action: back });
      const panel = element("section", undefined, "panel padded");
      panel.setAttribute("aria-label", "Line-item detail");
      panel.append(recordFields(row), sourceLocation(row), sourceEvidence(row.sourceId)); content.append(panel);
      const number = observed(row.fields.purchaseOrderNumber);
      const matches = number === null ? [] : byDate(orders.filter((order) => observed(order.fields.purchaseOrderNumber) === number));
      content.append(element("h3", "Candidate purchase orders"), textBlock("Exact order-number matches remain separate records. Matching numbers do not establish a shared order or store."));
      content.append(matches.length ? paged(matches, "candidate purchase orders", orderTable) : empty("No purchase-order summary found", "This line remains preserved without inventing a summary relationship."));
    }
    function showSupplier(name: string | null) {
      page(name ?? "Supplier not observed", name === null ? "Records without an unambiguous observed supplier are grouped for review without assigning a supplier." : "Only this exact observed name is included. Case, whitespace and punctuation remain distinct.", "Purchase orders", { label: "Back to purchase orders", action: showOrders });
      const matchingOrders = byDate(orders.filter((row) => observed(row.fields.supplier) === name));
      const matchingLines = byDate(lines.filter((row) => observed(row.fields.supplier) === name));
      content.append(element("h3", "Purchase-order records"));
      content.append(matchingOrders.length ? paged(matchingOrders, "purchase orders", orderTable) : empty("No purchase-order summaries", "No summary directly records this supplier selection."));
      content.append(element("h3", "Line-item records"));
      content.append(matchingLines.length ? paged(matchingLines, "supplier lines", (rows) => lineTable(rows, () => showSupplier(name))) : empty("No directly observed line items", "A supplier on a summary does not establish the supplier on possible line matches."));
    }
    function showSkus() {
      page("SKUs", "Search exact observed identifiers. Leading zeros, case and whitespace are preserved, without assuming product identity across stores.", "SKUs");
      const results = element("div", undefined, "panel");
      const refresh = (search: string) => {
        const filtered = skuNames.filter((sku) => sku.toLowerCase().includes(search.toLowerCase()));
        results.replaceChildren(filtered.length ? paged(filtered, "SKUs", (names) => table(["SKU identifier", "Line records"], names.map((sku) => [button(sku, () => showSku(sku), "text-button literal"), String(skuMap.get(sku)?.length ?? 0)]), "SKU directory")) : empty(search ? "No SKUs match" : "No observed SKUs yet", search ? "Try another exact identifier or clear the search." : "Summary-only imports contain no SKU history. Missing or conflicting SKUs are not turned into identifiers."));
      };
      const controls = element("div", undefined, "controls"); controls.append(searchInput("Search SKU identifiers", refresh)); content.append(controls, results); refresh("");
    }
    function showSku(sku: string) {
      page(sku, "Recorded purchase costs for this exact SKU. Newest observed dates come first; unavailable dates come last. Currencies are never converted or combined.", "SKUs", { label: "Back to SKUs", action: showSkus });
      const rows = byDate(skuMap.get(sku) ?? []);
      content.append(element("h3", "Recorded purchase costs"));
      content.append(rows.length ? paged(rows, "SKU history lines", (entries) => lineTable(entries, () => showSku(sku))) : empty("No saved lines for this SKU", "No cost, quantity or supplier is inferred for an absent identifier."));
    }
    const categoryLabels = new Map<string, string>([["incomplete", "Incomplete records"], ["exact-duplicate", "Exact duplicate records"], ["invalid-date", "Invalid dates"], ["conflict", "Conflicts"], ["invalid-value", "Invalid values"], ["ambiguous-overlap", "Possible overlaps"], ["csv-issue", "CSV issues"], ["schema-issue", "Schema issues"]]);
    function affected(findings: Finding[], fileId: string) {
      const ids = new Set<string>();
      for (const finding of findings) {
        for (const id of finding.recordIds) if (records.get(id)?.fileId === fileId) ids.add(`record:${id}`);
        for (const id of finding.sourceIds) {
          const recordId = sourceRecordIds.get(id); const source = sources.get(id);
          if (recordId !== undefined && records.get(recordId)?.fileId === fileId) ids.add(`record:${recordId}`);
          else if (source?.fileId === fileId && source.dataRowNumber !== null) ids.add(`source:${id}`);
        }
      }
      return ids.size;
    }
    function findingTable(rows: Finding[]) {
      return table(["Category", "Finding", "Original source"], rows.map((finding) => {
        const kind = element("div"); kind.append(element("strong", categoryLabels.get(finding.category) ?? finding.category), textBlock(finding.severity));
        const evidence = element("div"); evidence.append(element("span", fileName(finding.fileId), "literal"));
        evidence.append(finding.sourceIds.length ? disclosure("View source evidence", () => paged(finding.sourceIds, "finding source records", (ids) => {
          const group = element("div");
          for (const id of ids) { const source = sources.get(id); group.append(source ? sourceView(source) : textBlock("Original source is unavailable in this archive.")); }
          return group;
        }, 5)) : textBlock("No row-level source was retained for this finding."));
        return [kind, element("p", finding.message, "literal"), evidence];
      }), "Quality findings");
    }
    function showQuality() {
      page("Data quality", "Review saved findings and file coverage. Counts describe preserved records; categories may overlap. No missing value is repaired or inferred.", "Data quality");
      if (!archive.files.length) { content.append(empty("No saved imports", "No record quality has been assessed in this archive.")); return; }
      content.append(element("h3", "Import quality by file"));
      content.append(paged(archive.files, "files", (rows) => table(["File and coverage", "Parsed rows", "Mapped records", "Records with findings", "Findings"], rows.map((file) => {
        const findings = archive.findings.filter((finding) => finding.fileId === file.id);
        const details = element("div"); details.append(element("strong", file.name, "literal"), textBlock(`CSV status: ${file.status}`), disclosure("File coverage and diagnostics", () => {
          const list = element("ul"); for (const note of file.coverageNotes) list.append(element("li", note));
          if (!file.coverageNotes.length) list.append(element("li", "Coverage notes were not retained; absent findings do not establish complete data."));
          return list;
        }));
        return [details, String(file.totalRows), String(archive.records.filter((row) => row.fileId === file.id).length), String(affected(findings, file.id)), String(findings.length)];
      }), "Import quality by file")));
      content.append(element("h3", "Quality findings"));
      let fileId: string | undefined; let category: string | undefined;
      const results = element("div", undefined, "panel");
      const refresh = () => {
        const rows = archive.findings.filter((finding) => (fileId === undefined || finding.fileId === fileId) && (category === undefined || finding.category === category));
        results.replaceChildren(rows.length ? paged(rows, "findings", findingTable) : empty("No matching findings", "Review file coverage before treating absent findings as evidence of complete data."));
      };
      const controls = element("div", undefined, "controls");
      const fileKeys = new Map(archive.files.map((file, index) => [`file-${index}`, file.id]));
      controls.append(selectInput("Filter findings by file", [["all", "All files"], ...archive.files.map((file, index): [string, string] => [`file-${index}`, `${file.name} · import ${index + 1}`])], (key) => { fileId = fileKeys.get(key); refresh(); }));
      const categories = [...new Set(archive.findings.map((finding) => finding.category))].sort(exact);
      const categoryKeys = new Map(categories.map((name, index) => [`category-${index}`, name]));
      controls.append(selectInput("Filter findings by category", [["all", "All categories"], ...categories.map((name, index): [string, string] => [`category-${index}`, categoryLabels.get(name) ?? name])], (key) => { category = categoryKeys.get(key); refresh(); }));
      content.append(controls, results); refresh();
      content.append(disclosure("Coverage and counting rules", () => {
        const list = element("ul"); for (const note of archive.qualityNotes) list.append(element("li", note));
        list.append(element("li", "Exact duplicate records remain separate observations. Shared identifiers alone do not prove a duplicated business order.")); return list;
      }));
    }
    showOrders();
  } catch {
    app.replaceChildren(element("h1", "Stocky History Rescue"), empty("This archive could not be opened", "Generate a new offline viewer from the saved local archive. This file has not changed."));
  }
})();
