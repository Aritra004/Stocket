/** Download an already-rendered report locally; no upload or network request. */
export function downloadHtmlReport(html: string, fileName: string): void {
  downloadTextFile(html, fileName, "text/html;charset=utf-8");
}

export function downloadTextFile(content: string, fileName: string, type: "text/html;charset=utf-8" | "application/json;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to consume the Blob before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
