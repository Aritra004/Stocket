import { WorkspaceShell } from "@/src/components/workspace-shell";
import DataQualityDashboard from "@/src/components/quality/data-quality-dashboard";

export default function QualityPage() {
  return <WorkspaceShell active="quality"><DataQualityDashboard /></WorkspaceShell>;
}
