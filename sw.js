// network-first の Service Worker。
// オンライン時は常にネットワークから最新を取得し（同一オリジンのみ no-store）、
// 取得できない時だけキャッシュにフォールバックする。
// → デプロイのたびに確実に最新のコードが読み込まれる（古いキャッシュで止まらない）。

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 同一オリジンの GET のみ介入（CDN 等のクロスオリジンは既定動作のまま）
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: "no-store" }).catch(() => caches.match(req))
  );
});
