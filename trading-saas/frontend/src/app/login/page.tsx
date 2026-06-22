"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Mail, Lock, Loader2, Sparkles, Eye, EyeOff } from "lucide-react";
import Script from "next/script";

interface CandleData {
  cx: number;
  top: number;
  bot: number;
  wick: number;
  body: number;
  col: string;
  o: number;
  wickY1: number;
  wickY2: number;
  delay: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [candles, setCandles] = useState<CandleData[]>([]);
  const [trendlinePath, setTrendlinePath] = useState("");

  useEffect(() => {
    const W = 600;
    const H = 320;
    const n = 34;
    const gap = W / n;
    const base: number[] = [];
    
    // Deterministic random generator to prevent SSR mismatches
    const seedRandom = (seed: number) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };

    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const v = Math.cos(t * Math.PI) * 0.5 + 0.5;
      const dip = 1 - Math.sin(t * Math.PI) * 0.55;
      base.push((v * 0.45 + dip * 0.55));
    }

    const pts: [number, number][] = [];
    const generatedCandles: CandleData[] = [];

    for (let i = 0; i < n; i++) {
      const cx = i * gap + gap / 2;
      const lvl = base[i];
      const mid = H - lvl * (H * 0.72) - H * 0.12;
      
      const r1 = seedRandom(i * 12);
      const r2 = seedRandom(i * 27);
      
      const wick = 12 + r1 * 18;
      const body = 10 + r2 * 16;
      const up = i === 0 ? true : base[i] >= base[i - 1];
      const col = up ? '#2ee6a6' : '#ff5a6a';
      const o = up ? 0.9 : 0.7;
      const top = mid - body / 2;
      const bot = mid + body / 2;
      
      pts.push([cx, mid]);
      
      generatedCandles.push({
        cx,
        top,
        bot,
        wick,
        body,
        col,
        o,
        wickY1: top - wick,
        wickY2: bot + wick * 0.5,
        delay: `${(i / n) * 0.9}s`
      });
    }

    const d = 'M' + pts.map(p => p[0] + ' ' + p[1]).join(' L');
    setCandles(generatedCandles);
    setTrendlinePath(d);
  }, []);

  const initializeGoogleSignIn = () => {
    if (typeof window !== "undefined" && (window as any).google) {
      const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
      if (!clientId) return;
      
      (window as any).google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCallback,
      });

      const buttonContainer = document.getElementById("google-signin-button");
      if (buttonContainer) {
        (window as any).google.accounts.id.renderButton(
          buttonContainer,
          { 
            theme: "outline", 
            size: "large", 
            width: "320", 
            shape: "pill",
            text: "signin_with",
            logo_alignment: "left"
          }
        );
      }
    }
  };

  const handleGoogleCallback = async (response: any) => {
    setLoading(true);
    try {
      const res = await api.loginGoogle(response.credential);
      if (res.success && res.token) {
        localStorage.setItem("token", res.token);
        const meRes = await api.me();
        if (meRes.success && meRes.user) {
          localStorage.setItem("user", JSON.stringify(meRes.user));
        }
        toast.success("Login com Google realizado!");
        setTimeout(() => {
          window.location.href = "/";
        }, 1000);
      } else {
        toast.error(res.error || "Erro no login com Google.");
      }
    } catch (err: any) {
      toast.error("Erro ao conectar com o servidor.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      initializeGoogleSignIn();
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error("Por favor, preencha todos os campos.");
      return;
    }

    if (isRegister && password !== confirmPassword) {
      toast.error("As senhas não coincidem.");
      return;
    }

    if (isRegister && password.length < 8) {
      toast.error("A senha deve ter pelo menos 8 caracteres.");
      return;
    }

    setLoading(true);
    try {
      if (isRegister) {
        const res = await api.register({ email, password });
        if (res.success && res.token) {
          localStorage.setItem("token", res.token);
          if (res.user) {
            localStorage.setItem("user", JSON.stringify(res.user));
          }
          toast.success("Conta criada com sucesso! Acessando...");
          setTimeout(() => {
            window.location.href = "/";
          }, 1000);
        } else {
          toast.error(res.error || "Erro ao cadastrar. Tente novamente.");
        }
      } else {
        const res = await api.login({ email, password });
        if (res.success && res.token) {
          localStorage.setItem("token", res.token);
          if (res.user) {
            localStorage.setItem("user", JSON.stringify(res.user));
          }
          toast.success("Login realizado com sucesso!");
          setTimeout(() => {
            window.location.href = "/";
          }, 1000);
        } else {
          toast.error(res.error || "E-mail ou senha incorretos.");
        }
      }
    } catch (err: any) {
      toast.error("Erro ao conectar com o servidor.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-shell">
      <style dangerouslySetInnerHTML={{ __html: `
        :root {
          --void: #050507;
          --surface: #0d0f14;
          --surface-2: #13161d;
          --line: #1f232c;
          --line-strong: #2a2f3a;
          --mint: #2ee6a6;
          --mint-deep: #0fae7e;
          --mint-glow: rgba(46,230,166,.16);
          --loss: #ff5a6a;
          --text: #f3f6f8;
          --muted: #8b919e;
          --muted-2: #5c6270;
          --r: 16px;
          --r-sm: 11px;
        }

        .login-shell {
          min-height: 100vh;
          display: grid;
          grid-template-columns: 1.15fr 0.85fr;
          background: var(--void);
          color: var(--text);
          font-family: 'Inter', system-ui, sans-serif;
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
          overflow-x: hidden;
        }

        .stage {
          position: relative;
          padding: 48px 56px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          overflow: hidden;
          background:
            radial-gradient(120% 90% at 12% 0%, rgba(46,230,166,.10), transparent 55%),
            radial-gradient(80% 70% at 100% 100%, rgba(46,230,166,.05), transparent 60%),
            var(--void);
          border-right: 1px solid var(--line);
        }

        .chart {
          position: absolute;
          inset: auto 0 0 0;
          height: 62%;
          width: 100%;
          opacity: .5;
          pointer-events: none;
          mask-image: linear-gradient(to top, #000 35%, transparent 92%);
          -webkit-mask-image: linear-gradient(to top, #000 35%, transparent 92%);
        }

        .candle {
          transform-origin: center bottom;
        }

        .candle rect, .candle line {
          animation: rise .9s cubic-bezier(.2,.8,.2,1) both;
        }

        @keyframes rise {
          from {
            transform: translateY(14px) scaleY(.4);
            opacity: 0;
          }
          to {
            transform: none;
            opacity: 1;
          }
        }

        .trendline {
          fill: none;
          stroke: var(--mint);
          stroke-width: 2;
          filter: drop-shadow(0 0 6px var(--mint-glow));
          stroke-dasharray: 1400;
          stroke-dashoffset: 1400;
          animation: draw 2.2s ease-out .3s forwards;
        }

        @keyframes draw {
          to {
            stroke-dashoffset: 0;
          }
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 14px;
          position: relative;
          z-index: 2;
        }

        .mark {
          width: 46px;
          height: 46px;
          flex: none;
        }

        .wordmark {
          display: flex;
          flex-direction: column;
          line-height: 1;
        }

        .wordmark b {
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 700;
          font-size: 22px;
          letter-spacing: .06em;
        }

        .wordmark span {
          font-family: 'Space Mono', monospace;
          font-size: 10.5px;
          letter-spacing: .34em;
          color: var(--muted);
          margin-top: 4px;
          text-transform: uppercase;
        }

        .pitch {
          position: relative;
          z-index: 2;
          max-width: 38ch;
        }

        .eyebrow {
          font-family: 'Space Mono', monospace;
          font-size: 11px;
          letter-spacing: .28em;
          text-transform: uppercase;
          color: var(--mint);
          margin-bottom: 22px;
          display: flex;
          align-items: center;
          gap: 9px;
        }

        .eyebrow::before {
          content: "";
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--mint);
          box-shadow: 0 0 10px var(--mint);
        }

        .slogan {
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 600;
          font-size: clamp(34px, 3.6vw, 52px);
          line-height: 1.04;
          letter-spacing: -.02em;
        }

        .slogan em {
          font-style: normal;
          color: var(--mint);
        }

        .subline {
          margin-top: 22px;
          font-size: 15.5px;
          line-height: 1.6;
          color: var(--muted);
          max-width: 34ch;
        }

        .ticker {
          position: relative;
          z-index: 2;
          display: flex;
          gap: 34px;
          flex-wrap: wrap;
          font-family: 'Space Mono', monospace;
        }

        .ticker div {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .ticker dt {
          font-size: 20px;
          color: var(--text);
          letter-spacing: .02em;
        }

        .ticker dd {
          font-size: 10.5px;
          letter-spacing: .2em;
          text-transform: uppercase;
          color: var(--muted-2);
        }

        .ticker .up {
          color: var(--mint);
        }

        .panel {
          background: var(--surface);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 48px 40px;
        }

        .form-container {
          width: 100%;
          max-width: 380px;
        }

        .hello {
          font-family: 'Space Mono', monospace;
          font-size: 11px;
          letter-spacing: .26em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 12px;
        }

        .form-container h1 {
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 600;
          font-size: 28px;
          letter-spacing: -.01em;
          margin-bottom: 24px;
        }

        .tabs-header {
          display: flex;
          padding: 4px;
          background: var(--surface-2);
          border: 1px solid var(--line);
          border-radius: 9999px;
          margin-bottom: 24px;
        }

        .tab-btn {
          flex: 1;
          text-align: center;
          padding: 8px 0;
          font-size: 13.5px;
          font-weight: 600;
          border-radius: 9999px;
          transition: all 0.2s;
          cursor: pointer;
          background: transparent;
          border: none;
          color: var(--muted);
        }

        .tab-btn.active {
          background: var(--line);
          color: var(--text);
        }

        .field {
          margin-bottom: 18px;
        }

        .field label {
          display: block;
          font-size: 12.5px;
          color: var(--muted);
          margin-bottom: 9px;
          letter-spacing: .01em;
        }

        .input-wrap {
          position: relative;
          display: flex;
          align-items: center;
        }

        .input-wrap input {
          width: 100%;
          background: var(--surface-2);
          border: 1px solid var(--line);
          color: var(--text);
          font-family: inherit;
          font-size: 14.5px;
          padding: 14px 15px;
          padding-left: 44px;
          border-radius: var(--r-sm);
          transition: border-color .18s, box-shadow .18s, background .18s;
        }

        .input-wrap input::placeholder {
          color: var(--muted-2);
        }

        .input-wrap input:focus {
          outline: none;
          border-color: var(--mint);
          background: #10141a;
          box-shadow: 0 0 0 3px var(--mint-glow);
        }

        .input-icon {
          position: absolute;
          left: 14px;
          color: var(--muted);
          pointer-events: none;
        }

        .toggle-btn {
          position: absolute;
          right: 6px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          color: var(--muted);
          cursor: pointer;
          font-family: 'Space Mono', monospace;
          font-size: 10.5px;
          letter-spacing: .12em;
          padding: 8px 10px;
          border-radius: 8px;
          text-transform: uppercase;
        }

        .toggle-btn:hover {
          color: var(--mint);
        }

        .form-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 6px 0 26px;
        }

        .remember {
          display: flex;
          align-items: center;
          gap: 9px;
          font-size: 13px;
          color: var(--muted);
          cursor: pointer;
          user-select: none;
        }

        .remember input {
          position: absolute;
          opacity: 0;
          width: 0;
          height: 0;
        }

        .checkbox-box {
          width: 17px;
          height: 17px;
          border-radius: 5px;
          border: 1px solid var(--line-strong);
          display: grid;
          place-items: center;
          transition: .15s;
          flex: none;
        }

        .remember input:checked + .checkbox-box {
          background: var(--mint);
          border-color: var(--mint);
        }

        .checkbox-box svg {
          opacity: 0;
          transition: .15s;
        }

        .remember input:checked + .checkbox-box svg {
          opacity: 1;
        }

        .remember input:focus-visible + .checkbox-box {
          box-shadow: 0 0 0 3px var(--mint-glow);
        }

        .link {
          color: var(--muted);
          font-size: 13px;
          text-decoration: none;
          transition: color .15s;
          background: transparent;
          border: none;
          cursor: pointer;
        }

        .link:hover {
          color: var(--mint);
        }

        .submit-btn {
          width: 100%;
          border: none;
          cursor: pointer;
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 600;
          font-size: 15.5px;
          color: #04130d;
          background: linear-gradient(180deg, var(--mint), var(--mint-deep));
          padding: 15px;
          border-radius: var(--r-sm);
          letter-spacing: .01em;
          box-shadow: 0 8px 24px -8px var(--mint-glow), inset 0 1px 0 rgba(255,255,255,.25);
          transition: transform .12s, box-shadow .2s, filter .2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .submit-btn:hover {
          filter: brightness(1.05);
          box-shadow: 0 12px 30px -8px var(--mint-glow), inset 0 1px 0 rgba(255,255,255,.25);
        }

        .submit-btn:active {
          transform: translateY(1px);
        }

        .submit-btn:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px var(--void), 0 0 0 5px var(--mint);
        }

        .sep {
          display: flex;
          align-items: center;
          gap: 14px;
          margin: 26px 0;
          color: var(--muted-2);
          font-size: 11px;
          letter-spacing: .12em;
          text-transform: uppercase;
        }

        .sep::before, .sep::after {
          content: "";
          height: 1px;
          flex: 1;
          background: var(--line);
        }

        .create-text {
          text-align: center;
          font-size: 13.5px;
          color: var(--muted);
          margin-top: 20px;
        }

        .create-text button {
          background: transparent;
          border: none;
          color: var(--text);
          font-weight: 500;
          border-bottom: 1px solid var(--mint);
          padding-bottom: 1px;
          cursor: pointer;
          transition: color 0.15s;
        }

        .create-text button:hover {
          color: var(--mint);
        }

        .secure {
          margin-top: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-family: 'Space Mono', monospace;
          font-size: 9.5px;
          letter-spacing: .12em;
          color: var(--muted-2);
          text-transform: uppercase;
          text-align: center;
          line-height: 1.5;
        }

        .secure svg {
          flex: none;
        }

        @media (max-width: 880px) {
          .login-shell {
            grid-template-columns: 1fr;
          }

          .stage {
            padding: 30px 26px 40px;
            min-height: auto;
            border-right: none;
            border-bottom: 1px solid var(--line);
          }

          .chart {
            height: 78%;
            opacity: .4;
          }

          .pitch {
            margin: 28px 0;
          }

          .slogan {
            font-size: clamp(28px, 8vw, 40px);
          }

          .subline {
            display: none;
          }

          .ticker {
            gap: 24px;
          }

          .ticker dt {
            font-size: 16px;
          }

          .panel {
            padding: 38px 22px 56px;
          }
        }

        @media (max-width: 420px) {
          .ticker div:last-child {
            display: none;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .candle rect, .candle line {
            animation: none;
          }
          .trendline {
            animation: none;
            stroke-dashoffset: 0;
          }
        }
      ` }} />

      {/* ───────── LADO ESQUERDO: marca + atmosfera ───────── */}
      <section className="stage">
        <svg className="chart" viewBox="0 0 600 320" preserveAspectRatio="none" aria-hidden="true">
          {candles.map((candle, idx) => (
            <g key={idx} className="candle">
              <line
                x1={candle.cx}
                x2={candle.cx}
                y1={candle.wickY1}
                y2={candle.wickY2}
                stroke={candle.col}
                strokeWidth="1.4"
                opacity={candle.o * 0.6}
                style={{ animationDelay: candle.delay }}
              />
              <rect
                x={candle.cx - (600 / 34) * 0.28}
                width={(600 / 34) * 0.56}
                y={candle.top}
                height={Math.max(candle.body, 3)}
                rx="2"
                fill={candle.col}
                opacity={candle.o}
                style={{ animationDelay: candle.delay }}
              />
            </g>
          ))}
          {trendlinePath && (
            <path d={trendlinePath} className="trendline" />
          )}
        </svg>

        <header className="brand">
          <svg className="mark" viewBox="0 0 48 48" fill="none" aria-label="Vexa Cripto">
            <rect x="1" y="1" width="46" height="46" rx="13" fill="#0d0f14" stroke="#1f232c"/>
            <defs>
              <linearGradient id="g" x1="14" y1="34" x2="34" y2="12" gradientUnits="userSpaceOnUse">
                <stop stop-color="#0fae7e"/><stop offset="1" stop-color="#2ee6a6"/>
              </linearGradient>
            </defs>
            <path d="M13 14 L23 32 L31 18 L40 8" stroke="url(#g)" stroke-width="3.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M34 8 L40 8 L40 14" stroke="#2ee6a6" stroke-width="3.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div className="wordmark">
            <b>VEXA</b>
            <span>Cripto</span>
          </div>
        </header>

        <div className="pitch">
          <div className="eyebrow">Trading automatizado</div>
          <h1 className="slogan">Suas regras,<br/>no <em>piloto automático.</em></h1>
          <p className="subline">Bots executam a estratégia que você desenhou — 24 horas por dia, sem emoção e sem perder o sinal.</p>
        </div>

        <dl className="ticker">
          <div><dt className="up">24/7</dt><dd>Mercado ao vivo</dd></div>
          <div><dt>3</dt><dd>Bots por conta</dd></div>
          <div><dt>0,3s</dt><dd>Execução média</dd></div>
        </dl>
      </section>

      {/* ───────── LADO DIREITO: formulário ───────── */}
      <section className="panel">
        <div className="form-container">
          <form onSubmit={handleSubmit} id="form" noValidate>
            <p className="hello">Bem-vindo de volta</p>
            <h1>{isRegister ? "Criar sua conta" : "Entrar na sua conta"}</h1>

            {/* Tabs */}
            <div className="tabs-header">
              <button
                type="button"
                className={`tab-btn ${!isRegister ? "active" : ""}`}
                onClick={() => {
                  setIsRegister(false);
                  setEmail("");
                  setPassword("");
                  setConfirmPassword("");
                }}
              >
                Entrar
              </button>
              <button
                type="button"
                className={`tab-btn ${isRegister ? "active" : ""}`}
                onClick={() => {
                  setIsRegister(true);
                  setEmail("");
                  setPassword("");
                  setConfirmPassword("");
                }}
              >
                Criar Conta
              </button>
            </div>

            <div className="field">
              <label htmlFor="email">E-mail</label>
              <div className="input-wrap">
                <span className="input-icon">
                  <Mail className="w-4 h-4" />
                </span>
                <input
                  type="email"
                  id="email"
                  name="email"
                  placeholder="voce@email.com"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="senha">Senha</label>
              <div className="input-wrap">
                <span className="input-icon">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  id="senha"
                  name="senha"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="toggle-btn"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? "Ocultar" : "Mostrar"}
                </button>
              </div>
            </div>

            {/* Confirmar Senha (apenas no Cadastro) */}
            {isRegister && (
              <div className="field" style={{ animation: "fadeIn 0.2s ease-out" }}>
                <label htmlFor="confirmar-senha">Confirmar Senha</label>
                <div className="input-wrap">
                  <span className="input-icon">
                    <Lock className="w-4 h-4" />
                  </span>
                  <input
                    type={showPassword ? "text" : "password"}
                    id="confirmar-senha"
                    name="confirmar-senha"
                    placeholder="••••••••"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="form-row">
              <label className="remember">
                <input type="checkbox" name="lembrar" />
                <span className="checkbox-box">
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6.2L4.8 8.5L9.5 3.5"
                      stroke="#04130d"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                Manter conectado
              </label>
              <button type="button" className="link">Esqueci a senha</button>
            </div>

            <button type="submit" className="submit-btn" disabled={loading}>
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isRegister ? (
                <>
                  <Sparkles className="w-4 h-4" />
                  Criar Conta
                </>
              ) : (
                "Acessar Painel"
              )}
            </button>
          </form>

          <div className="sep">Ou continue com</div>

          {/* Google Sign In Button */}
          <div className="flex justify-center w-full min-h-[44px]">
            <div id="google-signin-button" />
          </div>

          <p className="create-text">
            {isRegister ? (
              <>
                Já possui uma conta?{" "}
                <button type="button" onClick={() => setIsRegister(false)}>
                  Entrar aqui
                </button>
              </>
            ) : (
              <>
                Ainda não opera com a Vexa?{" "}
                <button type="button" onClick={() => setIsRegister(true)}>
                  Criar conta grátis
                </button>
              </>
            )}
          </p>

          <div className="secure">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 1L2 3v3.5c0 3 2.1 5.2 5 6.5 2.9-1.3 5-3.5 5-6.5V3L7 1z"
                stroke="#5c6270"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <div>Conexão criptografada · chaves de API com permissão apenas de trading</div>
          </div>
        </div>
      </section>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onLoad={initializeGoogleSignIn}
      />
    </div>
  );
}
