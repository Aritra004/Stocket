import Link from "next/link";
import { Archive, LockKeyhole } from "lucide-react";
import { SkipToContent } from "./skip-to-content";

export function WorkspaceShell({
  active,
  children,
}: {
  active: "orders" | "import" | "suppliers" | "skus" | "quality" | "unlock";
  children: React.ReactNode;
}) {
  return (
    <>
      <SkipToContent />
      <header className="border-b border-slate-200/80 bg-white">
        <div className="mx-auto flex min-h-20 max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4 sm:px-8 lg:px-10">
          <Link
            href="/"
            aria-label="Stocky History Rescue workspace"
            className="flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-900 text-white shadow-sm">
              <Archive
                className="size-5"
                aria-hidden="true"
                strokeWidth={1.8}
              />
            </span>
            <span>
              <span className="block text-[15px] font-semibold tracking-tight text-slate-950">
                Stocky History Rescue
              </span>
              <span className="mt-0.5 block text-[11px] font-medium text-slate-500">
                Your history. In your hands.
              </span>
            </span>
          </Link>
          <nav
            aria-label="Workspace"
            className="order-last flex w-full flex-wrap gap-1 lg:order-none lg:mr-auto lg:ml-5 lg:w-auto"
          >
            {[
              { href: "/", label: "Purchase orders", id: "orders" },
              { href: "/suppliers", label: "Suppliers", id: "suppliers" },
              { href: "/skus", label: "SKUs", id: "skus" },
              { href: "/quality", label: "Data quality", id: "quality" },
              { href: "/import", label: "Import files", id: "import" },
              { href: "/unlock", label: "Unlock archive", id: "unlock" },
            ].map((link) => (
              <a
                key={link.id}
                href={link.href}
                aria-current={active === link.id ? "page" : undefined}
                className="rounded-md px-3 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-[current=page]:bg-emerald-50 aria-[current=page]:text-emerald-900"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <span className="hidden items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600 md:inline-flex">
            <span className="size-1.5 rounded-full bg-emerald-600" />
            Local workspace
          </span>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1440px] flex-1 px-5 pt-8 pb-8 sm:px-8 sm:pt-10 lg:px-10"
      >
        {children}
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/80 pt-5 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <LockKeyhole className="size-3" aria-hidden="true" />
            Your files stay on this device.
          </span>
          <span>Saved in this browser · No server copy</span>
        </footer>
      </main>
    </>
  );
}
