"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    const isAuthPage = pathname === "/login";

    if (!token && !isAuthPage) {
      router.push("/login");
    } else if (token && isAuthPage) {
      router.push("/");
    } else {
      setCheckingAuth(false);
    }
  }, [pathname, router]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-[var(--color-brand-500)]" />
      </div>
    );
  }

  const isAuthPage = pathname === "/login";
  if (isAuthPage) {
    return <div className="min-h-screen bg-[var(--color-bg)] flex flex-col justify-center">{children}</div>;
  }

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
