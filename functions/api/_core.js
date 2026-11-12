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
  ['firma','kdnr','name','email','tel','adresse','notiz'].forEach(f => cu[f] = String(raw[f] || '').trim().slice(0, f === 'notiz' ? 1000 : 300));
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

export { handleApi };
