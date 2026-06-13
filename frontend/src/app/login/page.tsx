"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Mail, Lock, Loader2, Sparkles, TrendingUp, Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
    <div className="min-h-screen w-full flex items-center justify-center p-4 relative overflow-hidden bg-[var(--color-bg)]">
      {/* Glow central sutil (estilo Welcome to Fey) */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-15%] left-1/2 -translate-x-1/2 w-[720px] h-[420px] rounded-full bg-[var(--color-brand-500)]/8 blur-[120px]" />
      </div>

      <div className="w-full max-w-sm z-10 slide-up">
        {/* Logo and header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-[var(--color-text)] text-[var(--color-bg)] mb-5">
            <TrendingUp className="w-6 h-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text)]">
            Bem-vindo ao Trading SaaS
          </h1>
          <p className="text-sm text-[var(--color-muted)] mt-3">
            Entre para acompanhar seus robôs, estratégias e resultados.
          </p>
        </div>

        {/* Auth card */}
        <div className="bg-[var(--color-surface)]/60 backdrop-blur-xl border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)] p-6 sm:p-8">
          {/* Tabs */}
          <div className="flex p-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-full mb-6">
            <button
              type="button"
              className={`flex-1 text-center py-2 text-sm font-semibold rounded-full transition-all ${
                !isRegister
                  ? "bg-[var(--color-surface-3)] text-[var(--color-text)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
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
              className={`flex-1 text-center py-2 text-sm font-semibold rounded-full transition-all ${
                isRegister
                  ? "bg-[var(--color-surface-3)] text-[var(--color-text)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
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

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* E-mail field */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)] mb-1.5">
                E-mail
              </label>
              <div className="relative flex items-center">
                <span className="absolute left-4 text-[var(--color-muted)]">
                  <Mail className="w-4 h-4" />
                </span>
                <input
                  type="email"
                  required
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] placeholder-[var(--color-muted-2)] focus:outline-none focus:border-[var(--color-border-strong)] transition-all text-sm"
                />
              </div>
            </div>

            {/* Password field */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)] mb-1.5">
                Senha
              </label>
              <div className="relative flex items-center">
                <span className="absolute left-4 text-[var(--color-muted)]">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  placeholder="Sua senha secreta"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-11 py-3 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] placeholder-[var(--color-muted-2)] focus:outline-none focus:border-[var(--color-border-strong)] transition-all text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 text-[var(--color-muted)] hover:text-[var(--color-text)] focus:outline-none"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Confirm Password (only for Register) */}
            {isRegister && (
              <div className="fade-in">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)] mb-1.5">
                  Confirmar Senha
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-4 text-[var(--color-muted)]">
                    <Lock className="w-4 h-4" />
                  </span>
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    placeholder="Repita sua senha secreta"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full pl-11 pr-11 py-3 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] placeholder-[var(--color-muted-2)] focus:outline-none focus:border-[var(--color-border-strong)] transition-all text-sm"
                  />
                </div>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              style={{ backgroundColor: "var(--color-text)", color: "var(--color-bg)" }}
              className="w-full flex items-center justify-center gap-2 py-3.5 px-4 mt-6 text-sm font-semibold rounded-full hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isRegister ? (
                <>
                  <Sparkles className="w-4 h-4" />
                  Criar Minha Conta
                </>
              ) : (
                "Acessar Painel"
              )}
            </button>
          </form>

          {/* Footnote */}
          <div className="mt-6 text-center">
            <p className="text-xs text-[var(--color-muted)]">
              {isRegister ? (
                <>
                  Já possui uma conta?{" "}
                  <button
                    type="button"
                    onClick={() => setIsRegister(false)}
                    className="font-semibold text-[var(--color-brand-300)] hover:underline"
                  >
                    Entrar aqui
                  </button>
                </>
              ) : (
                <>
                  Novo por aqui?{" "}
                  <button
                    type="button"
                    onClick={() => setIsRegister(true)}
                    className="font-semibold text-[var(--color-brand-300)] hover:underline"
                  >
                    Crie sua conta grátis
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
