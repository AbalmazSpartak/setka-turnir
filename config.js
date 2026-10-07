// Адрес посредника на Cloudflare (worker/worker.js): Setka не отдаёт данные сайтам напрямую.
// На компьютере при разработке — локальный посредник из tools/dev-server.mjs
export const API_URL = location.hostname === "localhost" ? "/api" : "https://setka-turnir.abalmazspartak.workers.dev/";
