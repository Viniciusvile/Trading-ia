"use client";

import { useState, useEffect } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "sonner";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
}

async function getVapidKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/vapid-public-key");
    const data = await res.json();
    return data.publicKey || null;
  } catch {
    return null;
  }
}

async function apiPush(method: "POST" | "DELETE", body: object) {
  const token = localStorage.getItem("token");
  return fetch("/api/push/subscribe", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function PushPermission() {
  const [status, setStatus] = useState<"unsupported" | "default" | "granted" | "denied" | "loading">("loading");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    const perm = Notification.permission as string;
    if (perm === "denied") { setStatus("denied"); return; }

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setSubscription(sub);
        setStatus(sub ? "granted" : "default");
      });
    });
  }, []);

  async function handleEnable() {
    setStatus("loading");
    try {
      const vapidKey = await getVapidKey();
      if (!vapidKey) throw new Error("Chave VAPID não disponível");

      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setStatus("denied"); return; }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      const subJson = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await apiPush("POST", { endpoint: subJson.endpoint, keys: subJson.keys });
      setSubscription(sub);
      setStatus("granted");
      toast.success("Notificações push ativadas!");
    } catch (e: any) {
      setStatus("default");
      toast.error("Erro ao ativar push: " + e.message);
    }
  }

  async function handleDisable() {
    if (!subscription) return;
    setStatus("loading");
    try {
      const subJson = subscription.toJSON() as { endpoint: string; keys: object };
      await apiPush("DELETE", { endpoint: subJson.endpoint, keys: subJson.keys });
      await subscription.unsubscribe();
      setSubscription(null);
      setStatus("default");
      toast.success("Notificações push desativadas.");
    } catch {
      setStatus("granted");
    }
  }

  if (status === "unsupported") return null;

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-[var(--color-border)]">
      <div>
        <div className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
          <Bell size={15} />
          Notificações push
        </div>
        <div className="text-xs text-muted mt-0.5">
          {status === "granted"
            ? "Alertas de preço, trades e relatórios chegam mesmo com o site fechado."
            : status === "denied"
            ? "Permissão bloqueada pelo navegador. Reative em Configurações do navegador."
            : "Receba alertas de preço, trades e relatórios fora do site."}
        </div>
      </div>
      {status === "loading" ? (
        <Loader2 size={18} className="animate-spin text-muted shrink-0" />
      ) : status === "granted" ? (
        <Button variant="outline" size="sm" leftIcon={<BellOff size={14} />} onClick={handleDisable}>
          Desativar
        </Button>
      ) : status === "denied" ? (
        <span className="text-[11px] text-down font-medium shrink-0">Bloqueado</span>
      ) : (
        <Button variant="primary" size="sm" leftIcon={<Bell size={14} />} onClick={handleEnable}>
          Ativar
        </Button>
      )}
    </div>
  );
}
