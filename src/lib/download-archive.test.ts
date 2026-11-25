import assert from "node:assert/strict";
import test from "node:test";
import { requestArchiveDownload } from "./download-archive";

test("ZIP download starts with a Blob URL and releases it after the browser can consume it", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const blob = new Blob(["ZIP"], { type: "application/zip" });
  const revoked: string[] = [];
  let release: (() => void) | undefined;
  let attached = false;
  let clicked = 0;
  let clickError = false;
  const anchor = {
    href: "", download: "", hidden: false,
    click() { assert.equal(attached, true); if (clickError) throw new Error("Download blocked"); clicked += 1; },
    remove() { attached = false; },
  };
  URL.createObjectURL = (value) => { assert.equal(value, blob); return "blob:local-archive"; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, body: { append: () => { attached = true; } } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: (callback: () => void, milliseconds: number) => { assert.equal(milliseconds, 60_000); release = callback; } } });
  try {
    requestArchiveDownload(blob, "history.zip");
    assert.equal(anchor.download, "history.zip");
    assert.equal(anchor.href, "blob:local-archive");
    assert.equal(clicked, 1);
    assert.equal(attached, false);
    assert.deepEqual(revoked, []);
    release?.();
    assert.deepEqual(revoked, ["blob:local-archive"]);
    clickError = true;
    assert.throws(() => requestArchiveDownload(blob, "blocked.zip"), /Download blocked/);
    assert.equal(attached, false);
    assert.deepEqual(revoked, ["blob:local-archive", "blob:local-archive"]);
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
