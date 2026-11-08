// GET  /api/config  -> liefert den aktuellen Kalender (öffentlich, für alle Händler)
// PUT  /api/config  -> speichert den Kalender (nur mit Verwaltungs-Passwort)
// Benötigt: KV-Bindung "KALENDER" und die geheime Umgebungsvariable "ADMIN_PASSWORD".

const KEY = 'config';
const MAX_BYTES = 2_000_000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function isAdmin(request, env) {
  const h = request.headers.get('authorization') || '';
  return !!env.ADMIN_PASSWORD && h.startsWith('Bearer ') && sameText(h.slice(7), env.ADMIN_PASSWORD);
}

export async function onRequestGet({ env }) {
  if (!env.KALENDER) return json({ error: 'KV-Bindung KALENDER fehlt' }, 500);
  const raw = await env.KALENDER.get(KEY);
  return json({ config: raw ? JSON.parse(raw) : null });
}

export async function onRequestPut({ request, env }) {
  if (!env.KALENDER) return json({ error: 'KV-Bindung KALENDER fehlt' }, 500);
  if (!isAdmin(request, env)) return json({ error: 'Nicht berechtigt' }, 401);
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: 'Daten zu groß' }, 413);
  let data;
  try { data = JSON.parse(text); } catch { return json({ error: 'Ungültiges JSON' }, 400); }
  if (!data || typeof data !== 'object' || typeof data.start !== 'string' || typeof data.days !== 'object' || typeof data.pool !== 'object') {
    return json({ error: 'Unvollständige Kalenderdaten' }, 400);
  }
  data.updatedAt = new Date().toISOString();
  const body = JSON.stringify(data);
  // Vorherigen Stand 90 Tage als Sicherung aufheben
  const prev = await env.KALENDER.get(KEY);
  if (prev) await env.KALENDER.put('backup:' + data.updatedAt, prev, { expirationTtl: 60 * 60 * 24 * 90 });
  await env.KALENDER.put(KEY, body);
  return json({ ok: true, updatedAt: data.updatedAt });
}
