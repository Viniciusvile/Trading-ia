// Service Worker VEXA — cache de shell + Web Push
const CACHE = "vexa-shell-v1";
const SHELL = ["/", "/dashboard", "/diario", "/bots", "/mercado"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Só trata navegação (páginas) com network-first; ignora API e estáticos
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});

// Web Push: exibe a notificação quando chega do backend
self.addEventListener("push", (e) => {
  let data = { title: "VEXA", body: "Nova notificação" };
  try { data = JSON.parse(e.data.text()); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "vexa-push",
      renotify: true,
      data: { url: "/" },
    })
  );
});

// Clique na notificação: abre/foca a aba da app
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = e.notification.data?.url || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
  );
});
