import SkuBrowser from "@/src/components/history/sku-browser";
import { WorkspaceShell } from "@/src/components/workspace-shell";

export default function SkusPage() {
  return <WorkspaceShell active="skus"><SkuBrowser /></WorkspaceShell>;
}
