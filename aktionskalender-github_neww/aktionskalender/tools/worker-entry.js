/* Einstieg für Cloudflare „Direct Upload“ (Advanced Mode, _worker.js): dieselbe Serverlogik wie functions/api */
import { route } from '../functions/api/[[route]].js';
import { err } from '../functions/api/_lib.js';
const SEC = { 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
function withHeaders(res, extra) { const h = new Headers(res.headers); Object.entries(Object.assign({}, SEC, extra || {})).forEach(([k, v]) => h.set(k, v)); return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h }); }
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) { try { return withHeaders(await route(request, env, ctx)); } catch (e) { return err(500, 'Serverfehler'); } }
    if (/^\/admin\/?$/.test(url.pathname)) { url.pathname = '/'; return withHeaders(await env.ASSETS.fetch(new Request(url.toString(), request)), { 'cache-control': 'no-cache' }); }
    const res = await env.ASSETS.fetch(request);
    return withHeaders(res, url.pathname === '/' || url.pathname === '/index.html' ? { 'cache-control': 'no-cache' } : {});
  },
};
