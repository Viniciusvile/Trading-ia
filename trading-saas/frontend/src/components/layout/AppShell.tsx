"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Topbar } from "./Topbar";
import { Dock } from "./Dock";
import { PageTransition } from "@/components/fx";
import { CommandPalette } from "@/components/CommandPalette";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = pathname === "/login";
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const token = localStorage.getItem("token");

    // router.replace mantém a navegação SPA (sem reload completo),
    // preservando cache do SWR e as transições de página.
    if (!token && !isAuthPage) {
      router.replace("/login");
    } else if (token && isAuthPage) {
      router.replace("/");
    }
  }, [mounted, isAuthPage, router]);

  // Before mount, render children directly to avoid flash
  // (SSR will just render the page content)
  if (!mounted) {
    if (isAuthPage) {
      return <>{children}</>;
    }
    return (
      <div className="min-h-screen bg-transparent">
        <Topbar />
        <main className="pb-28">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            {children}
          </div>
        </main>
        <Dock />
        <CommandPalette />
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
    <div className="min-h-screen bg-transparent">
      <Topbar />
      <main className="pb-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>
      <Dock />
      <CommandPalette />
    </div>
  );
}
