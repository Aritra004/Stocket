/** Hash the exact original bytes, including BOMs/line endings; names are irrelevant. */
export async function hashFile(file: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 requires a secure browser context. Open this app over HTTPS or localhost to save imports.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
