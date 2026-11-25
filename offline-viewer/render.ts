import { viewerJavascript, viewerCss, viewerScriptHash, viewerStyleHash } from "./generated-assets";
import { validateOfflineArchive } from "./validate";

/** JSON stays inert even when a CSV cell contains closing script tags or HTML. */
export function serializeArchiveData(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029",
  })[character]!);
}

/** Browser/worker-safe renderer. All code, styles and records are embedded. */
export async function renderOfflineArchive(input: unknown): Promise<string> {
  const archive = validateOfflineArchive(input);
  const policy = `default-src 'none'; script-src '${viewerScriptHash}'; style-src '${viewerStyleHash}'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">
<title>Stocky History Rescue - Offline archive</title><style>${viewerCss}</style></head>
<body><a class="skip-link" href="#offline-app">Skip to archive</a><main id="offline-app" tabindex="-1"><p>Opening your offline archive...</p></main><noscript>This archive needs JavaScript enabled to search and inspect its embedded records. No network access is required.</noscript>
<script id="archive-data" type="application/json">${serializeArchiveData(archive)}</script>
<script>${viewerJavascript}</script></body></html>\n`;
}
