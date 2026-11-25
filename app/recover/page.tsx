import type { Metadata } from "next";
import { WorkspaceShell } from "@/src/components/workspace-shell";
import { RecoverLicense } from "@/src/components/payments/recover-license";

export const metadata: Metadata = { title: "Recover license | Stocky History Rescue", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function RecoverPage() { return <WorkspaceShell active="unlock"><RecoverLicense /></WorkspaceShell>; }
