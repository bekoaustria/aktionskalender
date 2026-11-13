/* Aktionskalender – Serverlogik inkl. Konten & Zugangsschutz (Stand 13.11.2026) */
/* Aktionskalender – Serverlogik (Cloudflare Pages / Workers, KV-Bindung KALENDER)
   Endpunkte: /api/config /api/auth /api/whoami /api/approvals /api/approve /api/order /api/orders /api/file */
const MAX_CONFIG = 5 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;
const enc = new TextEncoder();

function json(data, status = 200, extra = {}){
  return new Response(JSON.stringify(data), { status, headers: Object.assign({ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' }, extra) });
}
const err = (msg, status = 400, extra) => json(Object.assign({ error: msg }, extra || {}), status);
function safeEqual(a, b){
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  let d = x.length ^ y.length; const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randHex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(v => v.toString(16).padStart(2, '0')).join(''); };
function isAdmin(req, env){
  const h = req.headers.get('authorization') || '';
  const pw = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!env.ADMIN_PASSWORD && !!pw && safeEqual(pw, env.ADMIN_PASSWORD);
}
async function readText(req, max){
  const len = +(req.headers.get('content-length') || 0); if (len > max) throw new Error('too_large');
  const t = await req.text(); if (t.length > max) throw new Error('too_large'); return t;
}
async function readJson(req, max){ try { return JSON.parse(await readText(req, max)); } catch(e){ return null; } }
async function kvJson(env, key, def){ const v = await env.KALENDER.get(key, 'json'); return v == null ? def : v; }

/* ---------- Datum (Wien) ---------- */
const todayVienna = () => new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Vienna', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const addDays = (s, n) => { const [y,m,d] = s.split('-').map(Number); return new Date(Date.UTC(y, m-1, d) + n * 864e5).toISOString().slice(0,10); };
const fmtShort = s => s.slice(8,10) + '.' + s.slice(5,7) + '.';
const eur = n => '€ ' + Number(n || 0).toLocaleString('de-AT', { minimumFractionDigits:2, maximumFractionDigits:2 });
function period(c){ const count = Math.max(1, Math.min(62, parseInt(c.count, 10) || 1)); return { a: c.start, b: addDays(c.start, count - 1) }; }
function rangeSpan(c, r){
  const { a, b } = period(c);
  if (r.xd) return { from: r.from, to: r.from };
  const from = r.full || !r.from || r.from < a || r.from > b ? a : r.from;
  const to = r.full || !r.to || r.to > b || r.to < a ? b : r.to;
  return { from, to: to < from ? from : to };
}
function productOf(c, k){
  const x = (c.extra || {})[k];
  if (x) return { brand: x.b || '', model: x.m || '', type: x.t || '' };
  const i = k.indexOf('|'); return { brand: k.slice(0, i), model: k.slice(i + 1), type: '' };
}
/* Liefert die heute bestellbare Aktion für einen Warenkorb-Eintrag oder einen Fehlertext.
   Slot „JJJJ-MM-TT“ = Hauptaktion des Tages, Slot „r-<id>“ = Zeitraum-Aktion oder zusätzliche Tagesaktion (xd) */
function dealForSlot(c, slot, k, t){
  if (!c || !c.start) return { error:'Keine Planung vorhanden' };
  const pool = (c.pool || {})[k] || {};
  if (/^r-[\w-]{1,40}$/.test(slot)){
    const r = (c.ranges || []).find(x => x && 'r-' + x.id === slot);
    if (!r || r.k !== k) return { error:'Diese Aktion gibt es nicht mehr' };
    const { a, b } = period(c);
    if (r.xd && (!r.from || r.from < a || r.from > b)) return { error:'Diese Aktion gibt es nicht mehr' };
    const s = rangeSpan(c, r);
    if (t < s.from || t > s.to) return { error: r.xd ? 'Die Aktion vom ' + fmtShort(s.from) + ' ist heute nicht bestellbar' : 'Diese Aktion ist heute nicht bestellbar' };
    if (r.price == null) return { error:'Für diese Aktion ist kein Preis hinterlegt' };
    const label = r.xd || (!r.full && s.from === s.to) ? fmtShort(s.from) : r.full ? 'Zeitraum ' + fmtShort(s.from) + '–' + fmtShort(s.to) : 'Zeitraum ' + fmtShort(s.from) + ' – ' + fmtShort(s.to);
    return { price: +r.price, qty: r.qty == null ? null : +r.qty, label, hek: r.hek != null ? r.hek : pool.hek };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot)) return { error:'Ungültige Aktion' };
  const { a, b } = period(c);
  if (slot !== t) return { error:'Die Aktion vom ' + fmtShort(slot) + ' ist nicht mehr bestellbar' };
  if (slot < a || slot > b) return { error:'Heute läuft keine Aktion' };
  const d = (c.days || {})[slot];
  if (!d || d.k !== k) return { error:'Die Tagesaktion hat sich geändert – bitte Seite neu laden' };
  if (d.price == null) return { error:'Für diese Aktion ist kein Preis hinterlegt' };
  return { price: +d.price, qty: d.qty == null ? null : +d.qty, label: fmtShort(slot), hek: d.hek != null ? d.hek : pool.hek };
}

/* ---------- Freigabe-Personen ---------- */
function eachPerson(c, fn){
  const p = (c && c.approval && c.approval.people) || {};
  Object.entries(p.pm || {}).forEach(([cat, arr]) => (arr || []).forEach(x => fn(x, 'pm:' + cat)));
  ['finance','marketing','sd'].forEach(k => (p[k] || []).forEach(x => fn(x, k)));
}
function publicConfig(c){
  const o = JSON.parse(JSON.stringify(c));
  eachPerson(o, x => { delete x.token; delete x.email; });
  return o;
}
function keepTokens(next, prev){
  const byPid = {}; eachPerson(prev, x => { if (x.pid && x.token) byPid[x.pid] = x.token; });
  const issued = {};
  eachPerson(next, x => {
    if (!x.pid) x.pid = randHex(6);
    if (!x.token) x.token = byPid[x.pid] || issued[x.pid] || randHex(16);
    issued[x.pid] = x.token;
  });
}
function personByToken(c, token){
  if (!token || String(token).length < 16) return null;
  let found = null; const keys = [];
  eachPerson(c, (x, key) => { if (x.token && safeEqual(x.token, token)){ found = found || x; keys.push(key); } });
  return found ? { p: found, keys } : null;
}

/* ---------- Mail ---------- */
function orderText(o, c){
  const lines = o.items.map(x => '- ' + x.qty + ' × ' + x.brand + ' ' + x.model + ' (Aktion ' + x.aktion + ') à ' + eur(x.price) + ' = ' + eur(x.line)).join('\n');
  const cu = o.customer;
  return 'Bestellung ' + o.no + ' aus dem ' + (c.title || 'Aktionskalender') + '\n\n' + lines + '\nGesamt exkl. MwSt.: ' + eur(o.total) +
    '\n\nFirma: ' + cu.firma + '\nKundennummer: ' + (cu.kdnr || '') + '\nAnsprechpartner:in: ' + cu.name + '\nE-Mail: ' + cu.email + '\nTelefon: ' + cu.tel +
    (cu.adresse ? '\nLieferadresse: ' + cu.adresse : '') + (cu.notiz ? '\nBemerkung: ' + cu.notiz : '') + '\n\nEingang: ' + o.at;
}
const h = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
function orderHtml(o, c, intro){
  const cu = o.customer;
  const rows = o.items.map(x => '<tr><td style="padding:6px;border-bottom:1px solid #ddd">' + x.qty + ' ×</td><td style="padding:6px;border-bottom:1px solid #ddd"><b>' + h(x.brand + ' ' + x.model) + '</b><br><small>' + h(x.type) + ' · Aktion ' + h(x.aktion) + '</small></td><td style="padding:6px;border-bottom:1px solid #ddd;text-align:right">' + h(eur(x.price)) + '</td><td style="padding:6px;border-bottom:1px solid #ddd;text-align:right"><b>' + h(eur(x.line)) + '</b></td></tr>').join('');
  const tel = t => '<a href="tel:' + h(String(t || '').replace(/[^+\d]/g, '')) + '">' + h(t) + '</a>';
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111"><p>' + h(intro) + '</p><h2 style="margin:0 0 4px">Bestellung ' + h(o.no) + '</h2><p style="margin:0 0 12px;color:#555">' + h(c.title || 'Aktionskalender') + ' · ' + h(o.at) + '</p>' +
    '<table style="border-collapse:collapse;width:100%"><tr><th align="left">Menge</th><th align="left">Gerät</th><th align="right">Aktions-HEK</th><th align="right">Summe</th></tr>' + rows +
    '<tr><td colspan="3" style="padding:6px"><b>Gesamt exkl. MwSt.</b></td><td style="padding:6px;text-align:right"><b>' + h(eur(o.total)) + '</b></td></tr></table>' +
    '<table style="margin-top:14px;border-collapse:collapse">' + [['Firma', h(cu.firma)], ['Kundennummer', h(cu.kdnr)], ['Ansprechpartner:in', h(cu.name)], ['E-Mail', '<a href="mailto:' + h(cu.email) + '">' + h(cu.email) + '</a>'], ['Telefon', tel(cu.tel)], ['Lieferadresse', h(cu.adresse)], ['Bemerkung', h(cu.notiz)]]
      .filter(r => r[1]).map(r => '<tr><td style="padding:2px 12px 2px 0;color:#555">' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>' +
    '<p style="margin-top:16px;color:#555;font-size:12px">' + h(c.impressum || 'Beko Austria AG · Pfarrgasse 77, 1230 Wien · FN 36236 p') + ' · Tel. ' + tel(c.orderPhone || '+43 1 615 39 00') + ' · <a href="mailto:' + h(c.orderEmail || 'order.austria@beko.com') + '">' + h(c.orderEmail || 'order.austria@beko.com') + '</a></p></div>';
}
async function sendMails(env, o, c){
  const to = c.orderEmail || 'order.austria@beko.com', copy = env.MAIL_COPY_TO_CUSTOMER !== 'false';
  const subject = 'Bestellung ' + o.no + ' – ' + o.customer.firma, text = orderText(o, c);
  try {
    if (env.RESEND_API_KEY && env.MAIL_FROM){
      const send = body => fetch('https://api.resend.com/emails', { method:'POST', headers:{ authorization:'Bearer ' + env.RESEND_API_KEY, 'content-type':'application/json' }, body: JSON.stringify(body) });
      const r = await send({ from: env.MAIL_FROM, to:[to], reply_to: o.customer.email, subject, text, html: orderHtml(o, c, 'Neue Bestellung aus dem Aktionskalender.') });
      if (copy) { try { await send({ from: env.MAIL_FROM, to:[o.customer.email], reply_to: to, subject:'Ihre Bestellung ' + o.no, text: 'Vielen Dank für Ihre Bestellung. Zuteilung nach Eingang, solange der Vorrat reicht.\n\n' + text, html: orderHtml(o, c, 'Vielen Dank für Ihre Bestellung. Zuteilung nach Eingang, solange der Vorrat reicht.') }); } catch(e) {} }
      return r.ok ? 'sent' : 'failed';
    }
    if (env.ORDER_WEBHOOK_URL){
      const headers = { 'content-type':'application/json' }; if (env.ORDER_WEBHOOK_SECRET) headers['x-webhook-secret'] = env.ORDER_WEBHOOK_SECRET;
      const r = await fetch(env.ORDER_WEBHOOK_URL, { method:'POST', headers, body: JSON.stringify({ type:'order', to, copyTo: copy ? o.customer.email : '', subject, text, html: orderHtml(o, c, 'Neue Bestellung aus dem Aktionskalender.'), order: o }) });
      return r.ok ? 'sent' : 'failed';
    }
  } catch(e){ return 'failed'; }
  return 'none';
}

/* ---------- Endpunkte ---------- */
async function apiConfig(req, env){
  if (req.method === 'GET'){
    const c = await kvJson(env, 'config', null), sold = await kvJson(env, 'sold', {});
    return json({ config: c ? (isAdmin(req, env) ? c : publicConfig(c)) : null, sold });
  }
  if (req.method === 'PUT'){
    if (!isAdmin(req, env)) return err('Nicht angemeldet', 401);
    let raw; try { raw = await readText(req, MAX_CONFIG); } catch(e){ return err('Planung zu groß (max. 5 MB) – bitte weniger oder kleinere Produktbilder verwenden', 413); }
    let c; try { c = JSON.parse(raw); } catch(e){ return err('Ungültige Daten'); }
    if (!c || typeof c !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(c.start || '')) return err('Ungültige Planung');
    const prev = await kvJson(env, 'config', null);
    keepTokens(c, prev); c.updatedAt = new Date().toISOString();
    if (prev) await env.KALENDER.put('backup:' + c.updatedAt, JSON.stringify(prev), { expirationTtl: 90 * 86400 });
    await env.KALENDER.put('config', JSON.stringify(c));
    return json({ ok:true, updatedAt: c.updatedAt });
  }
  return err('Methode nicht erlaubt', 405);
}
async function apiAuth(req, env){
  if (req.method !== 'POST') return err('Methode nicht erlaubt', 405);
  const b = await readJson(req, 4096);
  if (b && env.ADMIN_PASSWORD && safeEqual(b.password, env.ADMIN_PASSWORD)) return json({ ok:true });
  await sleep(400); return err('Falsches Passwort', 401);
}
async function apiWhoami(req, env){
  if (req.method !== 'POST') return err('Methode nicht erlaubt', 405);
  const b = await readJson(req, 4096), c = await kvJson(env, 'config', null);
  const m = b && personByToken(c, b.token);
  if (!m){ await sleep(400); return err('Link ungültig', 404); }
  return json({ pid: m.p.pid, name: m.p.name || '', keys: m.keys });
}
async function apiApprovals(req, env){
  if (req.method !== 'GET') return err('Methode nicht erlaubt', 405);
  return json({ byPid: await kvJson(env, 'approvals', {}) });
}
async function apiApprove(req, env){
  if (req.method !== 'POST') return err('Methode nicht erlaubt', 405);
  const b = await readJson(req, 16384), c = await kvJson(env, 'config', null);
  const m = b && personByToken(c, b.token);
  if (!m){ await sleep(400); return err('Link ungültig', 403); }
  const key = String(b.key || ''), status = b.status === 'ok' ? 'ok' : b.status === 'rejected' ? 'rejected' : null;
  if (!status || !m.keys.includes(key)) return err('Für diese Stufe nicht berechtigt', 403);
  const note = String(b.note || '').slice(0, 500).trim();
  if (status === 'rejected' && !note) return err('Bei Ablehnung ist ein Kommentar nötig');
  const all = await kvJson(env, 'approvals', {}), pid = m.p.pid, at = new Date().toISOString();
  const cur = all[pid] || { entries:{}, log:[] };
  cur.name = m.p.name || cur.name || '';
  cur.entries = Object.assign({}, cur.entries, { [key]: { status, note, hash: String(b.hash || '').slice(0, 40), at } });
  cur.log = [{ key, status, note, at }].concat(cur.log || []).slice(0, 100);
  all[pid] = cur; await env.KALENDER.put('approvals', JSON.stringify(all));
  return json({ ok:true });
}
async function apiOrder(req, env){
  if (req.method !== 'POST') return err('Methode nicht erlaubt', 405);
  const ip = req.headers.get('cf-connecting-ip') || 'x', rk = 'rl:' + ip + ':' + Math.floor(Date.now() / 60000);
  const n = +(await env.KALENDER.get(rk) || 0);
  if (n >= 8) return err('Zu viele Bestellungen – bitte in einer Minute erneut versuchen', 429);
  await env.KALENDER.put(rk, String(n + 1), { expirationTtl: 120 });
  const b = await readJson(req, 65536);
  if (!b || !Array.isArray(b.items) || !b.items.length || b.items.length > 30) return err('Der Warenkorb ist leer');
  const raw = b.customer || {}, cu = {};
  ['firma','kdnr','name','email','tel','adresse','notiz','konto'].forEach(f => cu[f] = String(raw[f] || '').trim().slice(0, f === 'notiz' ? 1000 : 300));
  if (!cu.konto) delete cu.konto;
  if (!cu.firma || !cu.name || !cu.tel || !/^\S+@\S+\.\S+$/.test(cu.email)) return err('Bitte Firma, Ansprechpartner:in, E-Mail und Telefon angeben');
  const c = await kvJson(env, 'config', null), t = todayVienna(), sold = await kvJson(env, 'sold', {});
  const items = [], want = {};
  for (const it of b.items){
    const slot = String(it.day || ''), k = String(it.k || ''), qty = Math.round(+it.qty);
    if (!(qty >= 1 && qty <= 9999)) return err('Ungültige Menge');
    const d = dealForSlot(c, slot, k, t); if (d.error) return err(d.error, 409, { sold });
    const p = productOf(c, k);
    want[slot] = (want[slot] || 0) + qty;
    if (d.qty != null && want[slot] > d.qty - (sold[slot] || 0)){ const rem = Math.max(0, d.qty - (sold[slot] || 0)); return err(p.model + ': ' + (rem ? 'nur mehr ' + rem + ' Stück verfügbar' : 'leider ausverkauft'), 409, { sold }); }
    items.push({ day: slot, aktion: d.label, k, brand: p.brand, model: p.model, type: p.type, qty, price: d.price, line: Math.round(d.price * qty * 100) / 100 });
  }
  Object.entries(want).forEach(([s, q]) => sold[s] = (sold[s] || 0) + q);
  await env.KALENDER.put('sold', JSON.stringify(sold));
  const o = { no: 'AK-' + t.replace(/-/g, '') + '-' + randHex(2).toUpperCase(), at: new Date().toISOString(), items, total: Math.round(items.reduce((a, x) => a + x.line, 0) * 100) / 100, customer: cu, title: c.title || 'Aktionskalender' };
  o.mail = await sendMails(env, o, c);
  const orders = await kvJson(env, 'orders', []); orders.unshift(o);
  await env.KALENDER.put('orders', JSON.stringify(orders.slice(0, 5000)));
  return json({ order: o, mailed: o.mail === 'sent', sold });
}
async function apiOrders(req, env){
  if (req.method !== 'GET') return err('Methode nicht erlaubt', 405);
  if (!isAdmin(req, env)) return err('Nicht angemeldet', 401);
  return json({ orders: await kvJson(env, 'orders', []), sold: await kvJson(env, 'sold', {}) });
}
async function apiFile(req, env, id){
  if (req.method === 'GET' && id){
    if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Nicht gefunden', { status:404 });
    const r = await env.KALENDER.getWithMetadata('file:' + id, 'arrayBuffer');
    if (!r || !r.value) return new Response('Nicht gefunden', { status:404 });
    const name = ((r.metadata || {}).name || 'Datenblatt.pdf').replace(/[^\w.\- äöüÄÖÜß]/g, '_');
    return new Response(r.value, { headers:{ 'content-type':'application/pdf', 'content-disposition':'inline; filename="' + name + '"', 'cache-control':'public, max-age=31536000, immutable', 'x-content-type-options':'nosniff' } });
  }
  if (req.method === 'POST' && !id){
    if (!isAdmin(req, env)) return err('Nicht angemeldet', 401);
    const len = +(req.headers.get('content-length') || 0); if (len > MAX_PDF) return err('PDF größer als 20 MB', 413);
    const buf = await req.arrayBuffer(); if (buf.byteLength > MAX_PDF) return err('PDF größer als 20 MB', 413);
    const head = new Uint8Array(buf.slice(0, 5)); if (String.fromCharCode(...head) !== '%PDF-') return err('Bitte eine PDF-Datei hochladen', 415);
    const fid = randHex(16), name = String(req.headers.get('x-file-name') || 'Datenblatt.pdf').slice(0, 120);
    await env.KALENDER.put('file:' + fid, buf, { metadata:{ name: decodeURIComponent(name), size: buf.byteLength, at: new Date().toISOString() } });
    return json({ id: fid });
  }
  return err('Methode nicht erlaubt', 405);
}
async function handleApi(req, env){
  if (!env.KALENDER) return err('KV-Bindung KALENDER fehlt – in Cloudflare unter Einstellungen → Bindungen anlegen und neu deployen', 500);
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  try {
    switch (path){
      case '/api/config': return await apiConfig(req, env);
      case '/api/auth': return await apiAuth(req, env);
      case '/api/whoami': return await apiWhoami(req, env);
      case '/api/approvals': return await apiApprovals(req, env);
      case '/api/approve': return await apiApprove(req, env);
      case '/api/order': return await apiOrder(req, env);
      case '/api/orders': return await apiOrders(req, env);
      case '/api/file': return await apiFile(req, env, null);
    }
    const f = path.match(/^\/api\/file\/([^/]+)$/); if (f) return await apiFile(req, env, f[1]);
    return err('Nicht gefunden', 404);
  } catch(e){ return err('Serverfehler', 500); }
}

/* ===================================================================================
   Konten & Zugangsschutz (Stand 13.11.2026)
   - Kunden: Auswahl aus Liste (Firma), Erstanmeldung nur mit persönlichem Einladungs-Link
     + Startpasswort (INITIAL_PASSWORD, Standard „bekoblackweeks“), danach sofort eigenes Passwort.
   - Team (Verwaltung = Admin/Editor): ADMIN_USERS (Standard: Harald Kasperowski, Pinar Top,
     Margit Anglmaier). Erstanmeldung mit Einladungs-Link + Startpasswort oder mit ADMIN_PASSWORD.
   - Kalender, Freigabe-Übersicht und Bestellen nur angemeldet (Freigabe-Links funktionieren weiter).
   - Datenblätter /api/file/<id> bleiben öffentlich (QR-Codes im Flyer).
   KV-Schlüssel: users, sess:<token>, tk:<ticket>, rlog:<ip>, last:<konto-id>
   =================================================================================== */
const COOKIE = 'ak_s';
const SESSION_TTL = 14 * 86400;
const TICKET_TTL = 15 * 60;
const MAX_FAILS = 10;
const DEFAULT_TEAM = 'Harald Kasperowski <harald.kasperowski@beko.com>, Pinar Top <pinar.top@beko.com>, Margit Anglmaier <margit.anglmaier@beko.com>';
const b64u = buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const rnd = (n = 24) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const lc = v => String(v || '').trim().toLowerCase();
const nowIso = () => new Date().toISOString();
const initialPw = env => String(env.INITIAL_PASSWORD || 'bekoblackweeks');
async function pbkdf2(pw, salt){
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return b64u(bits);
}
function teamList(env){
  return String(env.ADMIN_USERS || DEFAULT_TEAM).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*?)<([^>]+)>$/), email = lc(m ? m[2] : s);
    let name = m ? m[1].trim() : '';
    if (!name) name = email.split('@')[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    return { email, name };
  }).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email));
}
async function loadAccounts(env){
  let u = null; try { u = await env.KALENDER.get('users', 'json'); } catch(e) {}
  u = u && typeof u === 'object' ? u : {};
  const customers = Array.isArray(u.customers) ? u.customers : [];
  const old = new Map((Array.isArray(u.team) ? u.team : []).map(a => [a.email, a]));
  let dirty = false;
  const team = teamList(env).map(t => {
    const prev = old.get(t.email); if (!prev) dirty = true;
    return Object.assign({ mustChange: true, invite: rnd(18), pv: 1, created: nowIso() }, prev || {}, { id: 'team:' + t.email, role: 'admin', email: t.email, name: t.name });
  });
  const acc = { customers, team };
  if (dirty || team.length !== old.size) await saveAccounts(env, acc);
  return acc;
}
const saveAccounts = (env, acc) => env.KALENDER.put('users', JSON.stringify({ customers: acc.customers, team: acc.team }));
const findAcc = (acc, id) => id ? (acc.team.find(a => a.id === id) || acc.customers.find(a => a.id === id) || null) : null;
const labelOf = a => a.role === 'admin' ? a.name : a.firma + (a.ort ? ', ' + a.ort : '');
const pubUser = a => a.role === 'admin' ? { id: a.id, role: 'admin', label: a.name, name: a.name, email: a.email }
  : { id: a.id, role: 'kunde', label: labelOf(a), firma: a.firma, ort: a.ort || '', kdnr: a.kdnr || '', name: a.name || '', email: a.email || '', tel: a.tel || '' };
function adminView(a, last){
  return Object.assign(a.role === 'admin' ? { id: a.id, role: 'admin', name: a.name, email: a.email }
    : { id: a.id, role: 'kunde', firma: a.firma, ort: a.ort || '', kdnr: a.kdnr || '', name: a.name || '', email: a.email || '', tel: a.tel || '', active: a.active !== false },
    { status: a.active === false ? 'gesperrt' : a.mustChange ? 'eingeladen' : 'aktiv', invite: a.mustChange && a.active !== false ? a.invite : null, created: a.created || null, changed: a.changed || null, lastLogin: last[a.id] || null });
}
function cookieOf(req){ const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ak_s=([A-Za-z0-9_-]{20,})/); return m ? m[1] : null; }
const setCookie = (tok, ttl) => COOKIE + '=' + tok + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + ttl;
async function newSession(env, a){
  const tok = rnd(32);
  await env.KALENDER.put('sess:' + tok, JSON.stringify({ id: a.id, pv: a.pv || 1, at: Date.now() }), { expirationTtl: SESSION_TTL });
  try { await env.KALENDER.put('last:' + a.id, '', { metadata: { at: nowIso() } }); } catch(e) {}
  return tok;
}
async function currentUser(req, env){
  const tok = cookieOf(req); if (!tok) return null;
  let s = null; try { s = await env.KALENDER.get('sess:' + tok, 'json'); } catch(e) {}
  if (!s) return null;
  const acc = await loadAccounts(env), a = findAcc(acc, s.id);
  if (!a || a.active === false || a.mustChange || (a.pv || 1) !== s.pv) return null;
  return { a, acc, tok };
}
const ipOf = req => req.headers.get('cf-connecting-ip') || 'x';
async function blocked(env, req){ return +(await env.KALENDER.get('rlog:' + ipOf(req)) || 0) >= MAX_FAILS; }
async function failed(env, req){ const k = 'rlog:' + ipOf(req), n = +(await env.KALENDER.get(k) || 0); await env.KALENDER.put(k, String(n + 1), { expirationTtl: 900 }); }
function pwProblem(pw, env){
  pw = String(pw || '');
  if (pw.length < 8) return 'Das neue Passwort braucht mindestens 8 Zeichen.';
  if (pw.length > 200) return 'Das neue Passwort ist zu lang.';
  if (safeEqual(pw, initialPw(env)) || (env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD))) return 'Bitte ein eigenes Passwort wählen – nicht das Startpasswort.';
  if (!/[A-Za-zÄÖÜäöüß]/.test(pw) || !/\d/.test(pw)) return 'Bitte Buchstaben und mindestens eine Ziffer verwenden.';
  return null;
}
async function approverOk(env, t){
  if (!t || !/^[a-f0-9]{16,64}$/i.test(t)) return false;
  const c = await kvJson(env, 'config', null); return !!personByToken(c, t);
}

/* ---------- /api/session/* ---------- */
async function apiSession(req, env, sub){
  const m = req.method;
  if (sub === 'me' && m === 'GET'){
    const cu = await currentUser(req, env);
    return json({ server: 'konten', user: cu ? pubUser(cu.a) : null });
  }
  if (sub === 'users' && m === 'GET'){
    const acc = await loadAccounts(env);
    const customers = acc.customers.filter(a => a.active !== false).map(a => ({ id: a.id, label: labelOf(a) })).sort((x, y) => x.label.localeCompare(y.label, 'de'));
    return json({ customers, team: acc.team.map(a => ({ id: a.id, label: a.name })) });
  }
  if (sub === 'invite' && m === 'GET'){
    const t = new URL(req.url).searchParams.get('t') || '';
    if (/^[A-Za-z0-9_-]{16,64}$/.test(t)){
      const acc = await loadAccounts(env);
      const a = [...acc.team, ...acc.customers].find(x => x.mustChange && x.active !== false && x.invite && safeEqual(x.invite, t));
      if (a) return json({ id: a.id, label: labelOf(a), role: a.role });
    }
    await sleep(300); return err('Dieser Einladungs-Link ist nicht mehr gültig. Wurde das Passwort schon festgelegt? Dann bitte normal anmelden.', 404);
  }
  if (sub === 'login' && m === 'POST'){
    if (await blocked(env, req)) return err('Zu viele Fehlversuche – bitte in 15 Minuten erneut versuchen.', 429);
    const b = await readJson(req, 4096) || {};
    await sleep(350);
    const acc = await loadAccounts(env), a = findAcc(acc, String(b.id || '')), pw = String(b.password || '');
    const bad = async (msg, extra) => { await failed(env, req); return err(msg || 'Benutzer oder Passwort stimmt nicht.', 401, extra); };
    if (!a || a.active === false) return bad();
    if (a.mustChange){
      const viaInvite = !!a.invite && !!b.invite && safeEqual(a.invite, String(b.invite)) && safeEqual(pw, initialPw(env));
      const viaAdminPw = a.role === 'admin' && !!env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD);
      if (!viaInvite && !viaAdminPw){
        if (safeEqual(pw, initialPw(env))) return bad('Für die Erstanmeldung bitte den persönlichen Link aus der Einladungs-E-Mail öffnen.', { needInvite: true });
        return bad();
      }
      const ticket = rnd(24);
      await env.KALENDER.put('tk:' + ticket, JSON.stringify({ id: a.id }), { expirationTtl: TICKET_TTL });
      return json({ mustChange: true, ticket, user: pubUser(a) });
    }
    if (!a.hash || !a.salt || !safeEqual(await pbkdf2(pw, a.salt), a.hash)) return bad();
    const tok = await newSession(env, a);
    return json({ user: pubUser(a) }, 200, { 'set-cookie': setCookie(tok, SESSION_TTL) });
  }
  if (sub === 'change' && m === 'POST'){
    const b = await readJson(req, 4096) || {};
    let acc, a, oldTok = null;
    if (b.ticket){
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(b.ticket))) return err('Ungültige Anfrage', 400);
      const t = await kvJson(env, 'tk:' + b.ticket, null);
      if (!t) return err('Die Zeit für die Passwortänderung ist abgelaufen – bitte erneut über den Einladungs-Link anmelden.', 401);
      acc = await loadAccounts(env); a = findAcc(acc, t.id);
    } else {
      if (await blocked(env, req)) return err('Zu viele Fehlversuche – bitte in 15 Minuten erneut versuchen.', 429);
      const cu = await currentUser(req, env); if (!cu) return err('Bitte zuerst anmelden.', 401);
      acc = cu.acc; a = cu.a; oldTok = cu.tok;
      await sleep(250);
      if (!a.hash || !safeEqual(await pbkdf2(String(b.old || ''), a.salt), a.hash)){ await failed(env, req); return err('Das bisherige Passwort stimmt nicht.', 401); }
    }
    if (!a || a.active === false) return err('Dieser Zugang ist nicht aktiv.', 401);
    const prob = pwProblem(b.password, env); if (prob) return err(prob, 400);
    a.salt = rnd(16); a.hash = await pbkdf2(String(b.password), a.salt);
    a.mustChange = false; a.invite = null; a.pv = (a.pv || 1) + 1; a.changed = nowIso();
    await saveAccounts(env, acc);
    if (b.ticket) await env.KALENDER.delete('tk:' + b.ticket);
    if (oldTok) await env.KALENDER.delete('sess:' + oldTok);
    const tok = await newSession(env, a);
    return json({ user: pubUser(a) }, 200, { 'set-cookie': setCookie(tok, SESSION_TTL) });
  }
  if (sub === 'logout' && m === 'POST'){
    const tok = cookieOf(req); if (tok) await env.KALENDER.delete('sess:' + tok);
    return json({ ok: true }, 200, { 'set-cookie': COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }
  return err('Nicht gefunden', 404);
}

/* ---------- /api/users (nur Verwaltung) ---------- */
async function lastLogins(env){
  const out = {};
  try { let cur; do { const r = await env.KALENDER.list({ prefix: 'last:', cursor: cur }); r.keys.forEach(k => { if (k.metadata && k.metadata.at) out[k.name.slice(5)] = k.metadata.at; }); cur = r.list_complete ? null : r.cursor; } while (cur); } catch(e) {}
  return out;
}
async function usersPayload(env, acc, me){
  const last = await lastLogins(env);
  return json({ initial: initialPw(env), me: me.id, customers: acc.customers.map(a => adminView(a, last)), team: acc.team.map(a => adminView(a, last)) });
}
async function apiUsers(req, env){
  const cu = await currentUser(req, env);
  if (!cu || cu.a.role !== 'admin') return err('Nur für die Verwaltung.', 401);
  const acc = cu.acc;
  if (req.method === 'GET') return usersPayload(env, acc, cu.a);
  if (req.method === 'PUT'){
    const b = await readJson(req, 2 * 1024 * 1024);
    if (!b || !Array.isArray(b.customers)) return err('Ungültige Daten');
    if (b.customers.length > 5000) return err('Höchstens 5000 Kunden-Zugänge');
    const byId = new Map(acc.customers.map(a => [a.id, a])), out = [], seen = new Set();
    for (const r of b.customers){
      const firma = clip(r && r.firma, 120); if (!firma) return err('Jeder Kunde braucht einen Firmennamen.');
      const base = r.id && byId.get(r.id); if (base && seen.has(base.id)) continue;
      const rec = base || { id: 'k:' + rnd(9), role: 'kunde', mustChange: true, invite: rnd(18), pv: 1, created: nowIso() };
      const wasActive = rec.active !== false;
      Object.assign(rec, { firma, ort: clip(r.ort, 80), kdnr: clip(r.kdnr, 40), name: clip(r.name, 120), email: clip(r.email, 160), tel: clip(r.tel, 60), active: r.active !== false });
      if (base && wasActive && rec.active === false) rec.pv = (rec.pv || 1) + 1;   // Sperren beendet offene Sitzungen
      seen.add(rec.id); out.push(rec);
    }
    acc.customers = out; await saveAccounts(env, acc);
    return usersPayload(env, acc, cu.a);
  }
  if (req.method === 'POST'){
    const b = await readJson(req, 4096) || {};
    if (b.action === 'reset'){
      const a = findAcc(acc, String(b.id || '')); if (!a) return err('Zugang nicht gefunden', 404);
      if (a.id === cu.a.id) return err('Das eigene Passwort bitte über „Passwort ändern“ ändern.');
      Object.assign(a, { mustChange: true, hash: null, salt: null, invite: rnd(18), pv: (a.pv || 1) + 1, changed: nowIso() });
      await saveAccounts(env, acc);
      return usersPayload(env, acc, cu.a);
    }
    return err('Unbekannte Aktion');
  }
  return err('Methode nicht erlaubt', 405);
}

/* ---------- Zugangsschutz vor der bisherigen Serverlogik ---------- */
async function handleRequest(req, env){
  if (!env.KALENDER) return err('KV-Bindung KALENDER fehlt – in Cloudflare unter Einstellungen → Bindungen anlegen und neu deployen', 500);
  const path = new URL(req.url).pathname.replace(/\/+$/, ''), m = req.method.toUpperCase();
  try {
    if (path.startsWith('/api/session/')) return await apiSession(req, env, path.slice(13));
    if (path === '/api/users') return await apiUsers(req, env);
    // Datenblätter bleiben öffentlich (QR-Codes im Flyer)
    if (/^\/api\/file\/[^/]+$/.test(path) && (m === 'GET' || m === 'HEAD')) return handleApi(req, env);
    const hd = new Headers(req.headers); hd.delete('authorization');
    // Freigabe-Links funktionieren wie bisher ohne Anmeldung
    if (path === '/api/whoami' || path === '/api/approve') return handleApi(new Request(req, { headers: hd }), env);
    const cu = await currentUser(req, env), role = cu ? cu.a.role : null;
    if (role === 'admin' && env.ADMIN_PASSWORD) hd.set('authorization', 'Bearer ' + env.ADMIN_PASSWORD);
    const pass = () => handleApi(new Request(req, { headers: hd }), env);
    if (path === '/api/auth') return role === 'admin' ? json({ ok: true }) : err('Bitte als Verwaltung anmelden.', 401, { login: true });
    if ((path === '/api/config' || path === '/api/approvals') && m === 'GET'){
      if (role || await approverOk(env, req.headers.get('x-ak-token'))) return pass();
      return err('Bitte anmelden.', 401, { login: true });
    }
    if (path === '/api/order' && m === 'POST'){
      if (!role) return err('Bitte anmelden, um zu bestellen.', 401, { login: true });
      const b = await readJson(req, 65536); if (!b || typeof b !== 'object') return err('Ungültige Bestellung');
      const c0 = b.customer && typeof b.customer === 'object' ? b.customer : {};
      b.customer = Object.assign({}, c0, role === 'kunde' ? { firma: cu.a.firma, kdnr: cu.a.kdnr || '' } : {}, { konto: cu.a.id });
      hd.set('content-type', 'application/json'); hd.delete('content-length');
      return handleApi(new Request(req.url, { method: 'POST', headers: hd, body: JSON.stringify(b) }), env);
    }
    // Speichern, Datenblatt-Upload, Bestellliste: nur Verwaltung
    if (role !== 'admin') return err('Nur für die Verwaltung.', 401, { login: true });
    return pass();
  } catch(e){ return err('Serverfehler', 500); }
}

export { handleRequest, handleApi };
