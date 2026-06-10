"use client";

import { useEffect, useRef, useState } from "react";

interface TradingViewWidgetProps {
  symbol: string;
}

export function TradingViewWidget({ symbol }: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    if (typeof document === "undefined") return;
    
    const initialTheme = document.documentElement.dataset.theme || "dark";
    setTheme(initialTheme);

    const observer = new MutationObserver(() => {
      const currentTheme = document.documentElement.dataset.theme || "dark";
      setTheme(currentTheme);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let tvWidget: any = null;
    const widgetId = "tradingview_chart_widget";

    if (containerRef.current) {
      containerRef.current.innerHTML = `<div id="${widgetId}" style="height: 100%; width: 100%;" />`;
    }

    const scriptId = "tradingview-widget-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    const initWidget = () => {
      if (typeof window !== "undefined" && (window as any).TradingView) {
        tvWidget = new (window as any).TradingView.widget({
          autosize: true,
          symbol: symbol.includes(":") ? symbol : `BINANCE:${symbol}`,
          interval: "1H",
          timezone: "America/Sao_Paulo",
          theme: theme === "light" ? "light" : "dark",
          style: "1",
          locale: "br",
          enable_publishing: false,
          hide_side_toolbar: false,
          allow_symbol_change: true,
          container_id: widgetId,
        });
      }
    };

    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://s3.tradingview.com/tv.js";
      script.type = "text/javascript";
      script.async = true;
      script.onload = initWidget;
      document.head.appendChild(script);
    } else {
      if ((window as any).TradingView) {
        initWidget();
      } else {
        script.addEventListener("load", initWidget);
      }
    }

    return () => {
      if (script) {
        script.removeEventListener("load", initWidget);
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [symbol, theme]);

  return (
    <div className="w-full h-[450px] bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] overflow-hidden border border-[var(--color-border)]">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
