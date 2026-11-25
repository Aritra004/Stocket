/** Starts a local download. Browsers do not expose whether the final disk save succeeds. */
export function requestArchiveDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  let requested = false;
  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    requested = true;
  } finally {
    anchor.remove();
    if (requested) {
      // Large Blob downloads can outlive the click handler. Give the browser
      // time to consume them; the URL is also released when the page closes.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else URL.revokeObjectURL(url);
  }
}
