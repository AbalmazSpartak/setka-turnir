// Сайт как приложение: без этого файла Chrome не предлагает «Установить».
// Страница и скрипты — сначала из сети (всегда свежие), без сети — сохранённая копия.
// Данные турниров (посредник на Cloudflare) не сохраняются: они идут мимо, с другого адреса
const CACHE = "turnir-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match("./"))),
  );
});
