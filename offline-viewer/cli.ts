import { buildOfflineViewer } from "./build";

const usage = "Usage: npm run build:offline -- --input <archive.json> --out <output-directory>";
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--input", "--out"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  if (!options.has("--input") || !options.has("--out")) throw new Error(usage);
  const path = await buildOfflineViewer(options.get("--input")!, options.get("--out")!);
  process.stdout.write(`Created ${path}\nOpen this file directly in your browser. No server or internet connection is needed.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "The offline archive could not be built."}\n`);
  process.exitCode = 1;
});
