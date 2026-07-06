"use client";

import { useEffect, useRef, useState } from "react";

const CONTAINER_ID = "tv_chart_main";
const SCRIPT_ID = "tv-widget-script";

interface TradingViewWidgetProps {
  symbol: string;
}

function toTvSymbol(s: string) {
  return s.includes(":") ? s : `BINANCE:${s}`;
}

export function TradingViewWidget({ symbol }: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  // Theme detector — kept separate so it never triggers widget recreation
  const themeRef = useRef("dark");
  useEffect(() => {
    if (typeof document === "undefined") return;
    themeRef.current = document.documentElement.dataset.theme || "dark";
    const obs = new MutationObserver(() => {
      themeRef.current = document.documentElement.dataset.theme || "dark";
      // Update running widget's theme without full reload
      try {
        widgetRef.current?.changeTheme(themeRef.current === "light" ? "light" : "dark");
      } catch {}
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Symbol ref keeps latest value for the async script-load callback
  const symbolRef = useRef(symbol);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);

  // --- Create the widget once on mount ---
  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    function buildWidget() {
      if (!(window as any).TradingView || !containerRef.current) return;

      // Ensure inner div with stable id exists
      if (!document.getElementById(CONTAINER_ID)) {
        const div = document.createElement("div");
        div.id = CONTAINER_ID;
        div.style.height = "100%";
        div.style.width = "100%";
        containerRef.current.appendChild(div);
      }

      const tvTheme = themeRef.current === "light" ? "light" : "dark";
      widgetRef.current = new (window as any).TradingView.widget({
        autosize: true,
        symbol: toTvSymbol(symbolRef.current),
        interval: "1H",
        timezone: "America/Sao_Paulo",
        theme: tvTheme,
        style: "1",
        locale: "br",
        enable_publishing: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        container_id: CONTAINER_ID,
        onChartReady() {
          setReady(true);
        },
      });
    }

    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = "https://s3.tradingview.com/tv.js";
      script.async = true;
      script.onload = buildWidget;
      document.head.appendChild(script);
    } else if ((window as any).TradingView) {
      buildWidget();
    } else {
      script.addEventListener("load", buildWidget);
    }

    return () => {
      setReady(false);
      try { widgetRef.current?.remove(); } catch {}
      widgetRef.current = null;
      if (mount) mount.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — widget lives for the lifetime of this mount

  // --- Symbol changes: update existing chart without reload ---
  useEffect(() => {
    if (!ready || !widgetRef.current) return;
    try {
      widgetRef.current.activeChart().setSymbol(toTvSymbol(symbol), () => {});
    } catch {}
  }, [symbol, ready]);

  return (
    <div className="relative w-full h-[450px] bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] overflow-hidden border border-[var(--color-border)]">
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-xs text-muted animate-pulse">Carregando gráfico...</span>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
