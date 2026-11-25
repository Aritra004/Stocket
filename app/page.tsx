import PurchaseOrderDashboard from "@/src/components/dashboard/purchase-order-dashboard";
import { WorkspaceShell } from "@/src/components/workspace-shell";

export default function Home() {
  return <WorkspaceShell active="orders"><PurchaseOrderDashboard /></WorkspaceShell>;
}
