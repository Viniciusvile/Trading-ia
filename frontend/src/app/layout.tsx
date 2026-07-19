import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vexa Cripto — Painel de Operações",
  description:
    "Painel inteligente para acompanhar seus bots, mercado e operações em tempo real.",
  applicationName: "Vexa Cripto",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#050507" },
    { media: "(prefers-color-scheme: dark)", color: "#050507" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
          }
        `}} />
      </head>
      <body className={inter.variable}>
        <AppShell>{children}</AppShell>
        <Toaster
          position="top-right"
          richColors
          theme="system"
          toastOptions={{
            classNames: {
              toast:
                "rounded-[14px] border border-[var(--color-border)] shadow-[var(--shadow-pop)]",
            },
          }}
        />
      </body>
    </html>
  );
}
