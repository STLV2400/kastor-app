/* Kastor Campo — service worker
 * - Estaticos (/_next/static, iconos): cache-first (los archivos de Next llevan hash, nunca cambian).
 * - Navegacion a /campo y /campo/parte: network-first con respaldo en cache (la app abre sin senal).
 * - /api/*: nunca se cachea (la cola de partes vive en localStorage y se envia con fetch).
 */
const VERSION = "v1";
const STATIC = `kastor-static-${VERSION}`;
const PAGES = `kastor-pages-${VERSION}`;
const APP_PAGES = ["/campo", "/campo/parte"];
const STATIC_FILES = ["/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const s = await caches.open(STATIC);
      await Promise.all(STATIC_FILES.map((u) => s.add(u).catch(() => {})));
      const p = await caches.open(PAGES);
      await Promise.all(APP_PAGES.map((u) => cachePage(p, u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("kastor-") && k !== STATIC && k !== PAGES).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** Clave de cache de una pagina: solo la ruta (la maquina se elige en el cliente desde ?maquina= / ?alquiler=) */
function pageKey(url) {
  const u = new URL(url, self.location.origin);
  return new URL(u.pathname.replace(/\/$/, "") || "/", self.location.origin).toString();
}

function isAppPage(pathname) {
  const p = pathname.replace(/\/$/, "");
  return APP_PAGES.includes(p);
}

/** Solo guarda respuestas buenas que sigan siendo de la app (no la pantalla de ingreso tras un redirect) */
function cacheable(res) {
  if (!res || !res.ok || res.type === "opaque") return false;
  if (res.redirected) {
    const p = new URL(res.url).pathname;
    if (!p.startsWith("/campo")) return false;
  }
  return true;
}

async function cachePage(cache, path) {
  try {
    const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    if (!cacheable(res)) return;
    await cache.put(pageKey(path), res.clone());
    // Tambien guarda el JS/CSS que usa esa pagina (aunque el operador aun no la haya abierto)
    const html = await res.text();
    const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || [])].slice(0, 150);
    const s = await caches.open(STATIC);
    await Promise.all(
      assets.map(async (a) => {
        try {
          if (await s.match(a)) return;
          const r = await fetch(a);
          if (r.ok) await s.put(a, r);
        } catch {
          /* noop */
        }
      }),
    );
  } catch {
    /* sin senal */
  }
}

function isStatic(url) {
  return url.pathname.startsWith("/_next/static/") || /\.(?:svg|png|ico|webmanifest|woff2?)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // nunca cachear la API

  // Navegaciones de la app de campo
  if (req.mode === "navigate" && isAppPage(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES);
        try {
          const res = await fetch(req);
          if (cacheable(res)) cache.put(pageKey(req.url), res.clone()).catch(() => {});
          return res;
        } catch {
          const hit = await cache.match(pageKey(req.url));
          if (hit) return hit;
          const home = await cache.match(pageKey("/campo"));
          if (home) return home;
          return new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin señal</title>' +
              '<body style="background:#0b0d12;color:#e7eaf0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">' +
              '<div><h1 style="color:#ffc21a">Sin señal</h1><p>Abre la app de campo una vez con internet para poder usarla sin conexión.</p>' +
              '<button onclick="location.reload()" style="margin-top:16px;padding:14px 22px;border-radius:14px;border:0;background:#ffc21a;font-weight:700;font-size:16px">Reintentar</button></div>',
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
    return;
  }

  // Estaticos: cache-first
  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          return new Response("", { status: 504 });
        }
      })(),
    );
  }
});

/** La pagina nos manda los recursos que ya cargo antes de que el SW existiera, para tenerlos sin senal */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "CACHE_URLS") return;
  event.waitUntil(
    (async () => {
      const s = await caches.open(STATIC);
      const urls = Array.isArray(data.urls) ? data.urls.slice(0, 200) : [];
      await Promise.all(
        urls.map(async (u) => {
          try {
            const url = new URL(u, self.location.origin);
            if (url.origin !== self.location.origin || !isStatic(url)) return;
            if (await s.match(url.toString())) return;
            const res = await fetch(url.toString());
            if (res.ok) await s.put(url.toString(), res);
          } catch {
            /* noop */
          }
        }),
      );
      const p = await caches.open(PAGES);
      const pages = Array.isArray(data.pages) ? data.pages.filter((x) => isAppPage(x)) : [];
      await Promise.all(pages.map((x) => cachePage(p, x)));
    })(),
  );
});
