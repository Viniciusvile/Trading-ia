import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 pb-20 lg:pb-6">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-7 fade-in">
            {children}
          </div>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
