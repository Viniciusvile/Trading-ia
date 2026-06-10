"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname === "/login";
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const token = localStorage.getItem("token");

    if (!token && !isAuthPage) {
      window.location.href = "/login";
    } else if (token && isAuthPage) {
      window.location.href = "/";
    }
  }, [mounted, isAuthPage]);

  // Before mount, render children directly to avoid flash
  // (SSR will just render the page content)
  if (!mounted) {
    if (isAuthPage) {
      return <>{children}</>;
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

  // After mount: check auth
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;

  // If redirecting, show nothing
  if (!token && !isAuthPage) {
    return null;
  }
  if (token && isAuthPage) {
    return null;
  }

  // Auth page: no sidebar
  if (isAuthPage) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex flex-col justify-center">
        {children}
      </div>
    );
  }

  // Normal dashboard layout
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
