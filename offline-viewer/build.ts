import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { renderOfflineArchive } from "./render";

export { renderOfflineArchive, serializeArchiveData } from "./render";

/** Validate first, then create index.html. Invalid input leaves prior output intact. */
export async function buildOfflineViewer(inputPath: string, outputDirectory: string): Promise<string> {
  const sourcePath = resolve(inputPath);
  const destination = join(resolve(outputDirectory), "index.html");
  if (sourcePath.toLowerCase() === destination.toLowerCase()) throw new Error("Input JSON and output index.html must be different files.");
  const text = await readFile(sourcePath, "utf8");
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error("The archive input must be valid JSON. No output was written."); }
  const html = await renderOfflineArchive(data);
  await mkdir(resolve(outputDirectory), { recursive: true });
  await writeFile(destination, html, "utf8");
  return destination;
}
