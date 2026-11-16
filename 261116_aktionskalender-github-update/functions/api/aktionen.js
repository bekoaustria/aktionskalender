/* Aktionskalender – gespeicherte Aktionen (Vorlagen, Archiv mit Ergebnis) und Versionen, Stand 13.11.2026
   Route: /api/aktionen  (hat Vorrang vor functions/api/[[path]].js)
   Nur für das Beko-Team (Verwaltungsrechte). Die Anmeldung prüft die bestehende Serverlogik in _core.js (/api/session/me).
   KV (Bindung KALENDER):  idx:<kind>  = Liste der Kurzinfos,  <kind>:<id> = vollständiger Eintrag
   kind = aktionen | versionen  (Versionen: die letzten 30 bleiben) */
import { handleRequest } from './_core.js';

const KINDS = new Set(['aktionen', 'versionen']);
const MAX_BYTES = 4 * 1024 * 1024, MAX_VERSIONS = 30;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const err = (msg, status) => json({ error: msg }, status);

function sameStr(a, b){ a = String(a || ''); b = String(b || ''); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0 && a.length > 0; }

async function whoAdmin(request, env){
  try {
    const u = new URL('/api/session/me', request.url);
    const h = new Headers(); const ck = request.headers.get('cookie'); if (ck) h.set('cookie', ck);
    const r = await handleRequest(new Request(u.toString(), { headers: h }), env);
    if (r && r.ok){ const j = await r.json().catch(() => null);
      if (j && j.server === 'konten'){ const us = j.user; return us && us.role === 'admin' ? { label: us.label || us.name || 'Beko-Team', id: us.id || us.label || '' } : null; } }
  } catch(e) {}
  /* ältere Installation ohne Zugänge: Verwaltungs-Passwort */
  const a = request.headers.get('authorization') || '';
  if (env.ADMIN_PASSWORD && a.startsWith('Bearer ') && sameStr(a.slice(7), env.ADMIN_PASSWORD)) return { label: 'Verwaltung', id: 'admin' };
  return null;
}
function meta(o){
  const c = o.config || {}, n = Object.values(c.days || {}).filter(d => d && d.k).length + (Array.isArray(c.ranges) ? c.ranges.length : 0);
  return { id: o.id, kind: o.kind, name: o.name, at: o.at, by: o.by || '', byName: o.byName || '', title: c.title || '', theme: c.theme, start: c.start, count: c.count, deals: n, sum: o.result ? o.result.sum || null : null };
}
async function readIdx(env, kind){ return (await env.KALENDER.get('idx:' + kind, 'json')) || []; }

export async function onRequest({ request, env }){
  if (!env.KALENDER) return err('KV-Bindung KALENDER fehlt', 500);
  const me = await whoAdmin(request, env);
  if (!me) return err('Nur für das Beko-Team', 401);
  const url = new URL(request.url), kind = url.searchParams.get('kind') || 'aktionen', id = url.searchParams.get('id') || '';
  if (!KINDS.has(kind)) return err('Unbekannte Art', 400);
  if (id && !/^[\w.-]{1,80}$/.test(id)) return err('Ungültige ID', 400);
  const m = request.method;
  try {
    if (m === 'GET'){
      if (!id) return json({ items: await readIdx(env, kind) });
      const it = await env.KALENDER.get(kind + ':' + id, 'json');
      return it ? json({ item: it }) : err('Nicht gefunden', 404);
    }
    if (m === 'PUT'){
      if (!id) return err('ID fehlt', 400);
      const txt = await request.text(); if (txt.length > MAX_BYTES) return err('Zu groß (max. 4 MB)', 413);
      let o; try { o = JSON.parse(txt); } catch(e){ return err('Ungültige Daten', 400); }
      if (!o || typeof o !== 'object' || !o.config || !o.config.start) return err('Planung fehlt', 400);
      o.id = id; o.kind = kind === 'versionen' ? 'version' : (o.kind === 'archiv' ? 'archiv' : 'vorlage');
      o.name = String(o.name || o.config.title || 'Aktion').slice(0, 120); o.at = new Date().toISOString(); o.by = me.id; o.byName = me.label;
      await env.KALENDER.put(kind + ':' + id, JSON.stringify(o));
      let idx = (await readIdx(env, kind)).filter(x => x.id !== id); idx.unshift(meta(o));
      if (kind === 'versionen' && idx.length > MAX_VERSIONS){ const drop = idx.slice(MAX_VERSIONS); idx = idx.slice(0, MAX_VERSIONS); for (const x of drop) await env.KALENDER.delete('versionen:' + x.id); }
      await env.KALENDER.put('idx:' + kind, JSON.stringify(idx));
      return json({ ok: true, meta: meta(o) });
    }
    if (m === 'DELETE'){
      if (!id) return err('ID fehlt', 400);
      await env.KALENDER.delete(kind + ':' + id);
      await env.KALENDER.put('idx:' + kind, JSON.stringify((await readIdx(env, kind)).filter(x => x.id !== id)));
      return json({ ok: true });
    }
    return err('Methode nicht erlaubt', 405);
  } catch(e){ return err('Serverfehler', 500); }
}
