// network-first の Service Worker。
// オンライン時は常にネットワークから最新を取得し（同一オリジンは no-store）、
// 取得できた応答は実行時キャッシュに保存する。
// ネットワーク失敗時のみキャッシュへフォールバックし、それも無ければ
// 本来のエラーを投げる（undefined を返して読み込みが固まるのを防ぐ）。
// → デプロイのたびに最新が読み込まれつつ、一時的な通信失敗でも復帰できる。

const RT_CACHE = "kuchihold-rt";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 同一オリジンの GET のみ介入（CDN 等のクロスオリジンは既定動作のまま）
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req, { cache: "no-store" });
        // 正常応答だけ実行時キャッシュへ（フォールバック用）
        if (res && res.ok) {
          try {
            const cache = await caches.open(RT_CACHE);
            cache.put(req, res.clone());
          } catch {
            /* キャッシュ不可な環境は無視 */
          }
        }
        return res;
      } catch (err) {
        // 通信失敗：キャッシュがあれば使う。無ければ本来のエラーを投げる。
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
