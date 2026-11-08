// Aktionskalender Fachhandel – Serverlogik (Cloudflare Pages / Workers)
// Bindungen/Variablen im Cloudflare-Projekt:
//   KALENDER        KV-Namespace (Pflicht)
//   ADMIN_PASSWORD  Secret, Passwort der Verwaltung (Pflicht)
//   RESEND_API_KEY  Secret, für automatischen Mailversand über resend.com (optional, Variante A)
//   MAIL_FROM       Absender, z. B. "Aktionskalender <aktionen@bekoaustria.com>" (zu Variante A)
//   ORDER_WEBHOOK_URL  Secret, z. B. Power-Automate-/Make-/Zapier-Webhook, der die Mail verschickt (optional, Variante B)
//   MAIL_COPY_TO_CUSTOMER  "false" schaltet die Kopie an den Händler ab (Standard: Kopie an Händler)

const MAX_BYTES = 2_000_000;
const DEF_MAIL = 'order.austria@beko.com';

export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export const isAdmin = (request, env) => {
  const h = request.headers.get('authorization') || '';
  return !!env.ADMIN_PASSWORD && h.startsWith('Bearer ') && sameText(h.slice(7), env.ADMIN_PASSWORD);
};
async function readJson(request, max = 100_000) {
  const t = await request.text(); if (t.length > max) throw new Error('too_large');
  return JSON.parse(t || '{}');
}
async function kvJson(env, key, fallback) { const v = await env.KALENDER.get(key); return v ? JSON.parse(v) : fallback; }
function viennaToday() {
  const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  return p.year + '-' + p.month + '-' + p.day;
}
const fmtDay = d => d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4);
const eur = n => (n == null || isNaN(n)) ? '–' : '€ ' + Number(n).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function allPeople(cfg) {
  const a = (cfg && cfg.approval && cfg.approval.people) || {}; const out = [];
  Object.entries(a.pm || {}).forEach(([cat, arr]) => (arr || []).forEach(p => out.push({ key: 'pm:' + cat, p })));
  ['finance', 'marketing', 'sd'].forEach(k => (a[k] || []).forEach(p => out.push({ key: k, p })));
  return out;
}
function stripTokens(cfg) {
  if (!cfg || !cfg.approval || !cfg.approval.people) return cfg;
  const c = JSON.parse(JSON.stringify(cfg)); allPeople(c).forEach(({ p }) => { delete p.token; delete p.email; }); return c;
}

/* ---------- /api/config ---------- */
export async function configGet(request, env) {
  if (!env.KALENDER) return json({ error: 'KV-Bindung KALENDER fehlt' }, 500);
  const cfg = await kvJson(env, 'config', null);
  const sold = await kvJson(env, 'sold', {});
  return json({ config: cfg ? (isAdmin(request, env) ? cfg : stripTokens(cfg)) : null, sold });
}
export async function configPut(request, env) {
  if (!env.KALENDER) return json({ error: 'KV-Bindung KALENDER fehlt' }, 500);
  if (!isAdmin(request, env)) return json({ error: 'Nicht berechtigt' }, 401);
  let data; try { data = await readJson(request, MAX_BYTES); } catch { return json({ error: 'Ungültige Daten' }, 400); }
  if (!data || typeof data !== 'object' || typeof data.start !== 'string' || typeof data.days !== 'object' || typeof data.pool !== 'object')
    return json({ error: 'Unvollständige Kalenderdaten' }, 400);
  const prevRaw = await env.KALENDER.get('config');
  if (prevRaw) {
    const prev = JSON.parse(prevRaw), tok = {};
    allPeople(prev).forEach(({ p }) => { if (p.pid && p.token) tok[p.pid] = p.token; });
    allPeople(data).forEach(({ p }) => { if (p.pid && !p.token && tok[p.pid]) p.token = tok[p.pid]; });
  }
  data.updatedAt = new Date().toISOString();
  if (prevRaw) await env.KALENDER.put('backup:' + data.updatedAt, prevRaw, { expirationTtl: 60 * 60 * 24 * 90 });
  await env.KALENDER.put('config', JSON.stringify(data));
  return json({ ok: true, updatedAt: data.updatedAt });
}

/* ---------- /api/auth ---------- */
export async function auth(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD ist nicht gesetzt' }, 500);
  let body = {}; try { body = await readJson(request); } catch {}
  if (sameText(body.password, env.ADMIN_PASSWORD)) return json({ ok: true });
  await new Promise(r => setTimeout(r, 800));
  return json({ error: 'Falsches Passwort' }, 401);
}

/* ---------- Freigabe ---------- */
async function personByToken(env, token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const cfg = await kvJson(env, 'config', null); if (!cfg) return null;
  const hits = allPeople(cfg).filter(({ p }) => p.token && sameText(p.token, token));
  return hits.length ? { pid: hits[0].p.pid, name: hits[0].p.name || '', keys: hits.map(h => h.key) } : null;
}
export async function whoami(request, env) {
  let b = {}; try { b = await readJson(request); } catch {}
  const me = await personByToken(env, b.token);
  return me ? json({ pid: me.pid, name: me.name, keys: me.keys }) : json({ error: 'Link ungültig' }, 401);
}
export async function approvalsGet(request, env) {
  const a = await kvJson(env, 'approvals', { byPid: {} });
  return json({ byPid: a.byPid || {} });
}
export async function approve(request, env) {
  let b = {}; try { b = await readJson(request); } catch { return json({ error: 'Ungültige Daten' }, 400); }
  const me = await personByToken(env, b.token); if (!me) return json({ error: 'Link ungültig' }, 401);
  if (!me.keys.includes(b.key)) return json({ error: 'Keine Berechtigung für diese Stufe' }, 403);
  if (!['ok', 'rejected'].includes(b.status)) return json({ error: 'Ungültige Entscheidung' }, 400);
  const note = String(b.note || '').slice(0, 500).trim();
  if (b.status === 'rejected' && !note) return json({ error: 'Kommentar fehlt' }, 400);
  const at = new Date().toISOString();
  const a = await kvJson(env, 'approvals', { byPid: {} }); a.byPid = a.byPid || {};
  const cur = a.byPid[me.pid] || { entries: {}, log: [] };
  cur.name = me.name;
  cur.entries = Object.assign({}, cur.entries, { [b.key]: { status: b.status, note, hash: String(b.hash || '').slice(0, 40), at } });
  cur.log = [{ key: b.key, status: b.status, note, at }].concat(cur.log || []).slice(0, 100);
  a.byPid[me.pid] = cur;
  await env.KALENDER.put('approvals', JSON.stringify(a));
  return json({ ok: true, at });
}

/* ---------- Bestellungen ---------- */
async function rateLimited(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  const key = 'rl:' + ip + ':' + Math.floor(Date.now() / 60000);
  const n = +(await env.KALENDER.get(key) || 0);
  if (n >= 8) return true;
  await env.KALENDER.put(key, String(n + 1), { expirationTtl: 120 });
  return false;
}
function orderText(o, cfg) {
  return 'Neue Bestellung ' + o.no + ' aus dem ' + o.title + '\nEingang: ' + new Date(o.at).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }) + '\n\n' +
    o.items.map(x => x.qty + ' × ' + x.brand + ' ' + x.model + ' (Aktion ' + fmtDay(x.day) + ') à ' + eur(x.price) + ' = ' + eur(x.line)).join('\n') +
    '\n\nGesamt exkl. MwSt.: ' + eur(o.total) + '\n\nFirma: ' + o.customer.firma + '\nKundennummer: ' + (o.customer.kdnr || '–') + '\nAnsprechpartner:in: ' + o.customer.name +
    '\nE-Mail: ' + o.customer.email + '\nTelefon: ' + o.customer.tel + (o.customer.adresse ? '\nLieferadresse: ' + o.customer.adresse : '') + (o.customer.notiz ? '\nBemerkung: ' + o.customer.notiz : '') +
    '\n\nZuteilung nach Eingang, solange der Vorrat reicht. Preise = Aktions-HEK exkl. MwSt.\n' + (cfg.impressum || '');
}
function orderHtml(o, cfg) {
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ddd"', tdr = 'style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap"';
  const rows = o.items.map(x => '<tr><td ' + td + '>' + escH(fmtDay(x.day)) + '</td><td ' + td + '><b>' + escH(x.brand + ' ' + x.model) + '</b></td><td ' + tdr + '>' + x.qty + '</td><td ' + tdr + '>' + escH(eur(x.price)) + '</td><td ' + tdr + '><b>' + escH(eur(x.line)) + '</b></td></tr>').join('');
  const c = o.customer, line = (l, v) => v ? '<tr><td style="padding:3px 12px 3px 0;color:#555">' + l + '</td><td style="padding:3px 0">' + escH(v) + '</td></tr>' : '';
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:680px">' +
    '<h2 style="margin:0 0 4px">Bestellung ' + escH(o.no) + '</h2><p style="margin:0 0 14px;color:#555">' + escH(o.title) + ' · Eingang ' + escH(new Date(o.at).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })) + '</p>' +
    '<table style="border-collapse:collapse;width:100%"><thead><tr><th ' + td + ' align="left">Aktion</th><th ' + td + ' align="left">Gerät</th><th ' + tdr + '>Menge</th><th ' + tdr + '>Aktions-HEK</th><th ' + tdr + '>Summe</th></tr></thead><tbody>' + rows + '</tbody>' +
    '<tfoot><tr><td colspan="4" style="padding:8px"><b>Gesamt exkl. MwSt.</b></td><td style="padding:8px;text-align:right"><b>' + escH(eur(o.total)) + '</b></td></tr></tfoot></table>' +
    '<h3 style="margin:18px 0 6px">Händler</h3><table>' + line('Firma', c.firma) + line('Kundennummer', c.kdnr) + line('Ansprechpartner:in', c.name) + line('E-Mail', c.email) + line('Telefon', c.tel) + line('Lieferadresse', c.adresse) + line('Bemerkung', c.notiz) + '</table>' +
    '<p style="margin-top:18px;font-size:12px;color:#666">Zuteilung nach Eingang, solange der Vorrat reicht. Preise = Aktions-HEK exkl. MwSt.<br>' + escH(cfg.impressum || '') + '</p></div>';
}
async function sendOrderMail(env, cfg, o) {
  const to = cfg.orderEmail || DEF_MAIL;
  const subject = 'Bestellung ' + o.no + ' – ' + o.customer.firma + ' – ' + o.title;
  const copy = env.MAIL_COPY_TO_CUSTOMER !== 'false';
  const html = orderHtml(o, cfg), text = orderText(o, cfg);
  try {
    if (env.RESEND_API_KEY && env.MAIL_FROM) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], cc: copy ? [o.customer.email] : undefined, reply_to: o.customer.email, subject, html, text }) });
      return r.ok ? 'sent' : 'failed';
    }
    if (env.ORDER_WEBHOOK_URL) {
      const r = await fetch(env.ORDER_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, cc: copy ? o.customer.email : '', replyTo: o.customer.email, subject, html, text, order: o }) });
      return r.ok ? 'sent' : 'failed';
    }
  } catch { return 'failed'; }
  return 'none';
}
export async function order(request, env, ctx) {
  if (!env.KALENDER) return json({ error: 'KV-Bindung KALENDER fehlt' }, 500);
  if (await rateLimited(request, env)) return json({ error: 'Zu viele Bestellungen in kurzer Zeit – bitte kurz warten.' }, 429);
  let b; try { b = await readJson(request, 20_000); } catch { return json({ error: 'Ungültige Daten' }, 400); }
  const cfg = await kvJson(env, 'config', null); if (!cfg) return json({ error: 'Kein Kalender aktiv' }, 409);
  const cu = {}, F = { firma: 1, kdnr: 0, name: 1, email: 1, tel: 1, adresse: 0, notiz: 0 };
  for (const [k, req] of Object.entries(F)) { cu[k] = String((b.customer || {})[k] || '').trim().slice(0, 300); if (req && !cu[k]) return json({ error: 'Bitte alle Pflichtfelder ausfüllen.' }, 400); }
  if (!/^\S+@\S+\.\S+$/.test(cu.email)) return json({ error: 'Bitte eine gültige E-Mail-Adresse angeben.' }, 400);
  const items = Array.isArray(b.items) ? b.items.slice(0, 20) : []; if (!items.length) return json({ error: 'Der Warenkorb ist leer.' }, 400);
  const t = viennaToday(), sold = await kvJson(env, 'sold', {}), want = {}, out = [];
  for (const it of items) {
    const day = String(it.day || ''), d = (cfg.days || {})[day], qty = Math.floor(+it.qty);
    if (!d || !d.k || d.k !== it.k) return json({ error: 'Ein Gerät im Warenkorb ist keine gültige Aktion mehr.', sold }, 409);
    if (day !== t) return json({ error: 'Die Aktion vom ' + fmtDay(day) + ' ist abgelaufen – bestellbar nur am Aktionstag bis 23:59 Uhr.', sold }, 409);
    if (!(qty >= 1 && qty <= 999)) return json({ error: 'Ungültige Menge.' }, 400);
    if (d.price == null) return json({ error: 'Für dieses Gerät ist kein Aktionspreis hinterlegt.' }, 409);
    want[day] = (want[day] || 0) + qty;
    if (d.qty != null && want[day] > d.qty - (sold[day] || 0)) return json({ error: 'Leider sind nur mehr ' + Math.max(0, d.qty - (sold[day] || 0)) + ' Stück verfügbar.', sold }, 409);
    const [brand, ...m] = d.k.split('|');
    out.push({ day, k: d.k, brand, model: m.join('|'), qty, price: +d.price, line: Math.round(+d.price * qty * 100) / 100 });
  }
  Object.entries(want).forEach(([day, q]) => sold[day] = (sold[day] || 0) + q);
  await env.KALENDER.put('sold', JSON.stringify(sold));
  const at = new Date().toISOString(), rnd = [...crypto.getRandomValues(new Uint8Array(2))].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const o = { no: 'AK-' + t.replace(/-/g, '') + '-' + rnd, at, title: cfg.title || 'Aktionskalender', items: out, total: Math.round(out.reduce((a, x) => a + x.line, 0) * 100) / 100, customer: cu };
  o.mail = await sendOrderMail(env, cfg, o);
  await env.KALENDER.put('order:' + at + ':' + o.no, JSON.stringify(o));
  return json({ ok: true, order: o, mailed: o.mail === 'sent', sold });
}
export async function ordersGet(request, env) {
  if (!isAdmin(request, env)) return json({ error: 'Nicht berechtigt' }, 401);
  const keys = []; let cursor;
  do { const l = await env.KALENDER.list({ prefix: 'order:', cursor }); keys.push(...l.keys.map(k => k.name)); cursor = l.list_complete ? null : l.cursor; } while (cursor && keys.length < 2000);
  keys.sort().reverse();
  const orders = (await Promise.all(keys.slice(0, 1000).map(k => env.KALENDER.get(k)))).filter(Boolean).map(v => JSON.parse(v));
  return json({ orders, sold: await kvJson(env, 'sold', {}) });
}

/* ---------- Router ---------- */
export async function route(request, env, ctx) {
  const { pathname } = new URL(request.url), m = request.method;
  if (pathname === '/api/config') return m === 'GET' ? configGet(request, env) : m === 'PUT' ? configPut(request, env) : json({ error: 'Methode nicht erlaubt' }, 405);
  if (pathname === '/api/auth' && m === 'POST') return auth(request, env);
  if (pathname === '/api/whoami' && m === 'POST') return whoami(request, env);
  if (pathname === '/api/approvals' && m === 'GET') return approvalsGet(request, env);
  if (pathname === '/api/approve' && m === 'POST') return approve(request, env);
  if (pathname === '/api/order' && m === 'POST') return order(request, env, ctx);
  if (pathname === '/api/orders' && m === 'GET') return ordersGet(request, env);
  return null;
}
