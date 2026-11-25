import assert from "node:assert/strict";
import test from "node:test";

import { parseFileContents } from "./csv-parser-core";
import { parseCsvFile, parseCsvFiles } from "./csv-parser";
import type { CsvWorkerRequest, CsvWorkerResponse } from "./types";

function csv(text: string, name = "purchase-orders.csv") {
  return new File([text], name, { type: "text/csv" });
}

async function withBrowser<T>(run: () => Promise<T>): Promise<T> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "Worker", {
    value: undefined,
    configurable: true,
    writable: true,
  });

  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (previousWorker) {
      Object.defineProperty(globalThis, "Worker", previousWorker);
    } else {
      Reflect.deleteProperty(globalThis, "Worker");
    }
  }
}

test("parses BOM, quoted commas, escaped quotes, multiline fields, and empty cells", async () => {
  const input = csv(
    '\uFEFF"PO","Supplier","Notes"\r\n"0007","Smith, Jones","Said ""hello""\r\nNext"\r\n"0008",""," tail "\r\n',
  );
  const result = await parseFileContents(input);

  assert.equal(result.fileName, input.name);
  assert.equal(result.fileSize, input.size);
  assert.deepEqual(result.columns, ["PO", "Supplier", "Notes"]);
  assert.equal(result.totalRows, 2);
  assert.deepEqual(result.preview, [
    {
      rowNumber: 1,
      values: ["0007", "Smith, Jones", 'Said "hello"\r\nNext'],
    },
    { rowNumber: 2, values: ["0008", "", " tail "] },
  ]);
  assert.equal(result.status, "success");
  assert.equal(result.stockyValidation, "unsupported");
});

for (const delimiter of [",", "\t", ";", "|"]) {
  test(`detects ${JSON.stringify(delimiter)} delimiters`, async () => {
    const result = await parseFileContents(
      csv(
        [
          ["Purchase order", "Supplier", "Quantity"],
          ["001", "Vendor A", "12"],
          ["002", "Vendor B", "0"],
        ]
          .map((row) => row.join(delimiter))
          .join("\n"),
        delimiter === "\t" ? "orders.tsv" : "orders.csv",
      ),
    );

    assert.equal(result.delimiter, delimiter);
    assert.equal(result.totalRows, 2);
    assert.deepEqual(result.preview[0].values, ["001", "Vendor A", "12"]);
    assert.equal(result.status, "success");
  });

  for (const leadingBlankLines of [0, 15]) {
    test(`detects two-column ${JSON.stringify(delimiter)} files with ${leadingBlankLines} leading blank lines and trailing blanks`, async () => {
      const result = await parseFileContents(
        csv(
          `${"\n".repeat(leadingBlankLines)}id${delimiter}supplier\n001${delimiter}Vendor A\n002${delimiter}Vendor B\n\n\n`,
        ),
      );

      assert.equal(result.delimiter, delimiter);
      assert.deepEqual(result.columns, ["id", "supplier"]);
      assert.equal(result.totalRows, 2);
      assert.deepEqual(result.preview[0].values, ["001", "Vendor A"]);
      assert.deepEqual(result.preview[1].values, ["002", "Vendor B"]);
      assert.equal(result.status, "success");
    });
  }
}

test("keeps arbitrary columns and all raw values as strings", async () => {
  const result = await parseFileContents(
    csv(
      " not a Stocky field ,flag,date,formula,amount,html\n00123,true,2026-01-02,=SUM(A1),0.00,<script>example</script>\n",
    ),
  );

  assert.equal(result.columns[0], " not a Stocky field ");
  assert.deepEqual(result.preview[0].values, [
    "00123",
    "true",
    "2026-01-02",
    "=SUM(A1)",
    "0.00",
    "<script>example</script>",
  ]);
  assert.equal(result.stockyValidation, "unsupported");
});

test("retains duplicate, blank, and object-prototype header names positionally", async () => {
  const result = await parseFileContents(
    csv("__proto__,sku,sku,\nfirst,second,third,fourth\n"),
  );

  assert.deepEqual(result.columns, ["__proto__", "sku", "sku", ""]);
  assert.deepEqual(result.preview[0].values, [
    "first",
    "second",
    "third",
    "fourth",
  ]);
  assert.equal(result.status, "warning");
  assert.ok(result.warningCount >= 2);
});

test("skips physically blank records while preserving quoted empty and whitespace values", async () => {
  const result = await parseFileContents(csv('\n\nvalue\n\n""\n   \n\n'));

  assert.deepEqual(result.columns, ["value"]);
  assert.equal(result.totalRows, 2);
  assert.deepEqual(
    result.preview.map((row) => row.values),
    [[""], ["   "]],
  );
});

test("preserves records made entirely of empty cells", async () => {
  const result = await parseFileContents(csv("first,second,third\n,,\n1,,\n"));

  assert.equal(result.totalRows, 2);
  assert.deepEqual(
    result.preview.map((row) => row.values),
    [["", "", ""], ["1", "", ""]],
  );
});

for (const [name, contents] of [
  ["zero-byte", ""],
  ["BOM-only", "\uFEFF"],
  ["LF blank-line-only", "\n\n"],
  ["CR blank-line-only", "\r\r"],
  ["CRLF blank-line-only", "\r\n\r\n"],
]) {
  test(`returns an error result for ${name} files`, async () => {
    const result = await parseFileContents(csv(contents));

    assert.equal(result.status, "error");
    assert.equal(result.totalRows, 0);
    assert.deepEqual(result.columns, []);
    assert.deepEqual(result.preview, []);
    assert.ok(result.errorCount > 0);
  });
}

test("reports a header-only file without inventing a data row", async () => {
  const result = await parseFileContents(csv("SKU,Quantity\n"));

  assert.deepEqual(result.columns, ["SKU", "Quantity"]);
  assert.equal(result.totalRows, 0);
  assert.deepEqual(result.preview, []);
  assert.equal(result.status, "warning");
  assert.ok(result.warningCount > 0);
});

test("rejects an entirely blank header", async () => {
  const result = await parseFileContents(csv(",,\n1,2,3\n"));

  assert.equal(result.status, "error");
  assert.ok(result.errorCount > 0);
});

test("retains extra and missing cells and reports row-width warnings", async () => {
  const result = await parseFileContents(csv("a,b\n1\n2,3,4\n5,6\n"));

  assert.equal(result.totalRows, 3);
  assert.deepEqual(
    result.preview.map((row) => row.values),
    [["1"], ["2", "3", "4"], ["5", "6"]],
  );
  assert.equal(result.status, "warning");
  assert.ok(result.warningCount >= 2);
  assert.ok(result.warnings.some((issue) => issue.row === 2));
  assert.ok(result.warnings.some((issue) => issue.row === 3));
});

test("reports malformed quotes without throwing or claiming success", async () => {
  const result = await parseFileContents(csv('sku,notes\n1,"unfinished'));

  assert.equal(result.status, "error");
  assert.ok(result.errorCount > 0);
  assert.ok(result.errors.every((issue) => issue.severity === "error"));
});

test("counts the complete file while retaining only its first ten records", async () => {
  const result = await parseFileContents(
    csv(`id,value\n${Array.from({ length: 25 }, (_, i) => `${i},value ${i}`).join("\n")}\n`),
  );

  assert.equal(result.totalRows, 25);
  assert.equal(result.preview.length, 10);
  assert.deepEqual(result.preview[9], {
    rowNumber: 10,
    values: ["9", "value 9"],
  });
});

test("caps retained warnings while counting every issue", async () => {
  const result = await parseFileContents(
    csv(`id,value\n${Array.from({ length: 160 }, (_, i) => String(i)).join("\n")}\n`),
  );

  assert.equal(result.totalRows, 160);
  assert.equal(result.warnings.length, 100);
  assert.ok(result.warningCount >= 160);
  assert.equal(result.status, "warning");
});

test("accepts uppercase CSV extensions despite missing MIME metadata", async () => {
  const result = await parseFileContents(new File(["a,b\n1,2"], "ORDERS.CSV"));

  assert.equal(result.status, "success");
  assert.equal(result.totalRows, 1);
});

test("rejects unsupported extensions before attempting to read their contents", async () => {
  const input = new File(["a,b\n1,2"], "orders.xlsx");
  Object.defineProperty(input, "arrayBuffer", {
    value: () => {
      assert.fail("Unsupported files must not be read");
    },
  });
  const result = await parseFileContents(input);

  assert.equal(result.status, "unsupported");
  assert.equal(result.totalRows, 0);
  assert.ok(result.errorCount > 0);
});

test("returns a structured error when local file reading fails", async () => {
  const input = csv("a,b\n1,2");
  Object.defineProperty(input, "arrayBuffer", {
    value: async () => {
      throw new Error("The local file is no longer readable");
    },
  });
  const result = await parseFileContents(input);

  assert.equal(result.status, "error");
  assert.ok(result.errorCount > 0);
  assert.equal(result.fileName, input.name);
});

test("rejects invalid UTF-8 instead of silently replacing raw characters", async () => {
  const result = await parseFileContents(
    new File([new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xc3, 0x28])], "invalid.csv"),
  );

  assert.ok(result.status === "error" || result.status === "unsupported");
  assert.ok(result.errorCount > 0);
});

test("rejects binary control bytes disguised as CSV", async () => {
  const result = await parseFileContents(csv("a,b\n1,\u0000\u0001"));

  assert.ok(result.status === "error" || result.status === "unsupported");
  assert.ok(result.errorCount > 0);
});

test("preserves Unicode values in a file larger than a typical parsing chunk", async () => {
  const value = `${"x".repeat(262_140)}€😀日本語`;
  const result = await parseFileContents(csv(`id,description\n1,"${value}"\n2,end\n`));

  assert.equal(result.totalRows, 2);
  assert.equal(result.preview[0].values[1], value);
  assert.deepEqual(result.preview[1].values, ["2", "end"]);
  assert.equal(result.status, "success");
});

for (const newline of ["\n", "\r", "\r\n"]) {
  test(`supports ${JSON.stringify(newline)} record separators and quoted newlines`, async () => {
    const result = await parseFileContents(
      csv(`id,value${newline}1,"first${newline}second"${newline}2,last${newline}`),
    );

    assert.equal(result.totalRows, 2);
    assert.deepEqual(result.preview[0].values, ["1", `first${newline}second`]);
    assert.deepEqual(result.preview[1].values, ["2", "last"]);
    assert.equal(result.errorCount, 0);
  });
}

test("counts and locates issues correctly across repeated cooperative pauses", async () => {
  const rows = Array.from({ length: 1_505 }, (_, i) => `${i},value ${i}`);
  rows[498] = '"",""';
  rows[499] = '"line\nbreak",next';
  rows[998] = "too,many,fields";
  rows[999] = '"another\nline",next';
  rows[1_498] = '"",""';
  const contents = rows
    .map((row, index) => (index % 499 === 0 ? `\n${row}\n` : row))
    .join("\n");
  const result = await parseFileContents(csv(`id,value\n${contents}\n`));

  assert.equal(result.totalRows, 1_505);
  assert.equal(result.preview.length, 10);
  assert.equal(result.errorCount, 0);
  const mismatchIssues = result.warnings.filter(
    (issue) => issue.code === "FieldCountMismatch",
  );
  assert.equal(mismatchIssues.length, 1);
  assert.equal(mismatchIssues[0].row, 1_000);
});

test("imports an array-like file selection in order and isolates failed files", async () => {
  await withBrowser(async () => {
    const resultsSeen: Array<{ name: string; index: number }> = [];
    const results = await parseCsvFiles(
      {
        0: csv("id,value\n1,first", "first.csv"),
        1: new File(["unsupported"], "middle.pdf"),
        2: csv("id,value\n2,last", "last.csv"),
        length: 3,
      },
      (result, index) => resultsSeen.push({ name: result.fileName, index }),
    );

    assert.deepEqual(
      results.map((result) => result.fileName),
      ["first.csv", "middle.pdf", "last.csv"],
    );
    assert.equal(results[0].totalRows, 1);
    assert.equal(results[1].status, "unsupported");
    assert.equal(results[2].totalRows, 1);
    assert.deepEqual(resultsSeen, [
      { name: "first.csv", index: 0 },
      { name: "middle.pdf", index: 1 },
      { name: "last.csv", index: 2 },
    ]);
  });
});

test("imports iterable file collections and handles an empty selection", async () => {
  await withBrowser(async () => {
    assert.deepEqual(await parseCsvFiles([]), []);
    const results = await parseCsvFiles(new Set([csv("a,b\n1,2")]));

    assert.equal(results.length, 1);
    assert.equal(results[0].totalRows, 1);
  });
});

test("falls back to local parsing when a browser refuses to start a worker", async () => {
  await withBrowser(async () => {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class BlockedWorker {
        constructor() {
          throw new Error("Worker blocked by browser policy");
        }
      },
    });

    const result = await parseCsvFile(csv("id,value\n1,local"));

    assert.equal(result.totalRows, 1);
    assert.deepEqual(result.preview[0].values, ["1", "local"]);
    assert.equal(result.parsingMode, "main-thread");
    assert.notEqual(result.status, "error");
    assert.ok(result.warningCount > 0);
  });
});

test("falls back and terminates the worker when its script fails to load", async () => {
  await withBrowser(async () => {
    let terminated = false;
    let errorHandled = false;
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class FailedWorker {
        onerror: ((event: ErrorEvent) => void) | null = null;

        constructor() {
          queueMicrotask(() => {
            this.onerror?.({
              preventDefault: () => {
                errorHandled = true;
              },
            } as ErrorEvent);
          });
        }

        terminate() {
          terminated = true;
        }
      },
    });

    const result = await parseCsvFile(csv("id,value\n1,local"));

    assert.equal(result.totalRows, 1);
    assert.equal(result.parsingMode, "main-thread");
    assert.ok(result.warnings.some((issue) => issue.code === "WorkerUnavailable"));
    assert.ok(terminated);
    assert.ok(errorHandled);
  });
});

test("uses the worker result and terminates the worker after completion", async () => {
  await withBrowser(async () => {
    let terminated = false;
    let sentFiles = 0;
    const input = csv("id,value\n1,background");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class SuccessfulWorker {
        onmessage: ((event: MessageEvent<CsvWorkerResponse>) => void) | null = null;

        constructor() {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: "ready" },
            } as MessageEvent<CsvWorkerResponse>);
          });
        }

        async postMessage(request: CsvWorkerRequest) {
          assert.equal(request.type, "parse");
          assert.equal(request.file, input);
          sentFiles += 1;
          const result = await parseFileContents(request.file, "worker");
          this.onmessage?.({
            data: { type: "result", result },
          } as MessageEvent<CsvWorkerResponse>);
        }

        terminate() {
          terminated = true;
        }
      },
    });

    const result = await parseCsvFile(input);

    assert.equal(result.parsingMode, "worker");
    assert.equal(result.status, "success");
    assert.deepEqual(result.preview[0].values, ["1", "background"]);
    assert.equal(sentFiles, 1);
    assert.ok(terminated);
  });
});

test("rejects server-side invocation without reading CSV contents", async () => {
  const input = csv("id,value\n1,private");
  Object.defineProperty(input, "arrayBuffer", {
    value: () => {
      assert.fail("CSV contents must not be read by the public API on the server");
    },
  });
  const result = await parseCsvFile(input);

  assert.equal(result.status, "error");
  assert.equal(result.totalRows, 0);
  assert.ok(result.errors.some((issue) => issue.code === "BrowserRequired"));
});
