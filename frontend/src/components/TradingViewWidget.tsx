"use client";

import { useEffect, useRef, useState } from "react";

const SCRIPT_ID = "tv-widget-script";
const SCRIPT_SRC = "https://s3.tradingview.com/tv.js";

// Carrega o tv.js UMA única vez, compartilhando a mesma promise entre montagens
// (antes havia dois caminhos de onload que podiam disparar buildWidget em duplicidade).
let tvScriptPromise: Promise<void> | null = null;
function loadTvScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).TradingView) return Promise.resolve();
  if (tvScriptPromise) return tvScriptPromise;
  tvScriptPromise = new Promise<void>((resolve, reject) => {
    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      tvScriptPromise = null; // permite tentar de novo numa próxima montagem
      reject(new Error("Falha ao carregar tv.js"));
    });
  });
  return tvScriptPromise;
}

function toTvSymbol(s: string) {
  return s.includes(":") ? s : `BINANCE:${s}`;
}

interface TradingViewWidgetProps {
  symbol: string;
}

export function TradingViewWidget({ symbol }: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  // ID ÚNICO por instância — evita colisão entre montagens (o id fixo anterior
  // causava chart bugado quando o componente remontava).
  const idRef = useRef(`tv_chart_${Math.random().toString(36).slice(2)}`);
  const [ready, setReady] = useState(false);

  // Detector de tema — separado para nunca recriar o widget.
  const themeRef = useRef("dark");
  useEffect(() => {
    if (typeof document === "undefined") return;
    themeRef.current = document.documentElement.dataset.theme || "dark";
    const obs = new MutationObserver(() => {
      themeRef.current = document.documentElement.dataset.theme || "dark";
      try {
        widgetRef.current?.changeTheme(themeRef.current === "light" ? "light" : "dark");
      } catch {}
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Cria (e RECRIA quando o símbolo muda) o widget, após o script carregar.
  // Recriar é o jeito confiável de trocar de ativo — o widget grátis do tv.js não
  // expõe activeChart().setSymbol() de forma consistente (por isso só mostrava BTC).
  useEffect(() => {
    let cancelled = false;
    const id = idRef.current;

    loadTvScript()
      .then(() => {
        if (cancelled || !containerRef.current || !(window as any).TradingView) return;

        // (re)cria o container interno com id único
        const mount = containerRef.current;
        mount.innerHTML = "";
        const div = document.createElement("div");
        div.id = id;
        div.style.height = "100%";
        div.style.width = "100%";
        mount.appendChild(div);

        try {
          widgetRef.current = new (window as any).TradingView.widget({
            autosize: true,
            symbol: toTvSymbol(symbol),
            interval: "60", // 60 min = 1H. tv.js NÃO aceita "1H" (era o bug do "Carregando" travado)
            timezone: "America/Sao_Paulo",
            theme: themeRef.current === "light" ? "light" : "dark",
            style: "1",
            locale: "br",
            enable_publishing: false,
            hide_side_toolbar: false,
            allow_symbol_change: true,
            container_id: id,
            onChartReady() {
              if (!cancelled) setReady(true);
            },
          });
        } catch {
          /* ignore: fallback de timeout esconde o loader */
        }
      })
      .catch(() => {});

    // Fallback: se onChartReady não disparar (widget lento/instável), esconde o
    // loader após 6s para não ficar preso em "Carregando gráfico...".
    const fallback = setTimeout(() => {
      if (!cancelled) setReady(true);
    }, 6000);

    return () => {
      cancelled = true;
      clearTimeout(fallback);
      setReady(false);
      try {
        widgetRef.current?.remove();
      } catch {}
      widgetRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, [symbol]); // recria o widget ao trocar de ativo

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
