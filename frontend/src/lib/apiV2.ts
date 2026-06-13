// Cliente do backend Python (FastAPI :8000 via rewrite /api/v2).
// Cresce uma fatia da migração por vez. Reaproveita as interfaces de ./api.ts.
import { V2_BASE } from "@/config/backend";

export async function v2<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("token");
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(`${V2_BASE}${path}`, { ...init, headers, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export const apiV2 = {
  // métodos adicionados fatia por fatia (Fase 3 em diante)
};
