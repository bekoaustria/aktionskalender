// POST /api/auth  { "password": "…" }  -> 200 wenn das Verwaltungs-Passwort stimmt, sonst 401

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

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD ist nicht gesetzt' }, 500);
  let body = {};
  try { body = await request.json(); } catch {}
  if (sameText(body.password, env.ADMIN_PASSWORD)) return json({ ok: true });
  await new Promise(r => setTimeout(r, 800)); // bremst Rateversuche
  return json({ error: 'Falsches Passwort' }, 401);
}
