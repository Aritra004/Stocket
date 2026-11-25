import SupplierBrowser from "@/src/components/history/supplier-browser";
import { WorkspaceShell } from "@/src/components/workspace-shell";

export default function SuppliersPage() {
  return <WorkspaceShell active="suppliers"><SupplierBrowser /></WorkspaceShell>;
}
