/** Keep actionable browser limitations separate from archive validation errors. */
export function zipExportErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/QuotaExceeded/i.test(name)) return "The browser ran out of storage while reading or preparing this archive. Free device space, check browser storage permissions, then retry. Your saved imports have not been changed.";
  if (error instanceof RangeError || /out of memory|allocation failed|array buffer allocation|invalid typed array length/i.test(message)) return "There is not enough browser memory to create this ZIP. Close other tabs and retry on a device with more memory, or export a smaller set of imports. Keep your original CSV files before removing any saved import.";
  if (/MissingAPI|Security|InvalidState|DatabaseClosed|UnknownError|NotReadable/i.test(name)) return "The browser could not read the saved archive. Local storage may be blocked or unavailable. Check browser storage permissions and free device space, then reload and retry.";
  return message || "The offline ZIP could not be created. Reload the saved archive and try again. Your saved imports have not been changed.";
}
