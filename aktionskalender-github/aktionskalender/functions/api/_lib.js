/* Aktionskalender Fachhandel – Serverlogik für Cloudflare Pages Functions.
   Alle Daten liegen im KV-Namespace mit der Bindung KALENDER.
   Variablen/Secrets: siehe LIESMICH.md */

export const MAX_CONFIG = 2 * 1024 * 1024;
export const MAX_FILE = 20 * 1024 * 1024;
const enc = new TextEncoder();

/* ---------- Antworten ---------- */
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra),
  });
}
export const err = (status, error, more) => json(Object.assign({ error }, more || {}), status);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function body(request) { try { return await request.json(); } catch (e) { return null; } }

/* ---------- Kleinkram ---------- */
export function randId(n) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return [...a].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  const x = enc.encode(a), y = enc.encode(b); let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0 && a.length > 0;
}
export function viennaToday() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).forEach(x => (p[x.type] = x.value));
  return p.year + '-' + p.month + '-' + p.day;
}
const pad = n => String(n).padStart(2, '0');
export function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d) + n * 864e5);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
}
export const fmtShort = s => +s.slice(8, 10) + '.' + +s.slice(5, 7) + '.';
export const clientIp = request => request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';

/* ---------- KV ---------- */
export function kv(env) {
  if (!env.KALENDER) throw new Error('KV-Bindung KALENDER fehlt');
  return env.KALENDER;
}
export async function getJSON(env, key, fallback = null) {
  const v = await kv(env).get(key, 'json'); return v == null ? fallback : v;
}
export const putJSON = (env, key, value, opt) => kv(env).put(key, JSON.stringify(value), opt);

/* ---------- Konten-Modus (optional) ---------- */
export const accountsOn = env => !!String(env.ADMIN_USERS || '').trim();
export const initialPw = env => String(env.INITIAL_PASSWORD || 'bekoblackweeks');
export function teamFromEnv(env) {
  const raw = String(env.ADMIN_USERS || '').trim(); if (!raw) return [];
  let list = [];
  try { const j = JSON.parse(raw); if (Array.isArray(j)) list = j.map(x => ({ name: String(x.name || x.email || ''), email: String(x.email || '') })); } catch (e) {
    list = raw.split(/[;\n]/).map(s => s.trim()).filter(Boolean).map(s => {
      const m = s.match(/^(.*?)<([^>]+)>$/); return m ? { name: m[1].trim() || m[2].trim(), email: m[2].trim() } : { name: s, email: s };
    });
  }
  return list.filter(x => x.email).map(x => ({ id: 't-' + x.email.toLowerCase().replace(/[^a-z0-9]+/g, '-'), role: 'admin', name: x.name, email: x.email.toLowerCase() }));
}
export async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function pwRuleError(env, pw) {
  pw = String(pw || '');
  if (pw.length < 8 || !/\d/.test(pw) || !/[A-Za-zÄÖÜäöüß]/.test(pw)) return 'Mindestens 8 Zeichen, mit Buchstaben und mindestens einer Ziffer.';
  if (pw === initialPw(env)) return 'Das Startpasswort ist nicht erlaubt.';
  return null;
}
/* Benutzerbestand: { customers:[…], team:{ id:{…geheime Felder} } } */
export async function loadUsers(env) {
  const u = await getJSON(env, 'users', { customers: [], team: {} });
  u.customers = Array.isArray(u.customers) ? u.customers : []; u.team = u.team || {};
  // Team aus ADMIN_USERS: fehlende Einträge anlegen (eingeladen)
  let changed = false;
  for (const t of teamFromEnv(env)) {
    if (!u.team[t.id]) { u.team[t.id] = { mustChange: true, invite: randId(20), sv: 1 }; changed = true; }
  }
  if (changed) await putJSON(env, 'users', u);
  return u;
}
export const saveUsers = (env, u) => putJSON(env, 'users', u);
export const custLabel = a => (a.firma || '') + (a.ort ? ', ' + a.ort : '');
export function findUser(env, users, id) {
  const t = teamFromEnv(env).find(x => x.id === id);
  if (t) return Object.assign({}, t, users.team[t.id] || {}, { label: t.name });
  const c = users.customers.find(x => x.id === id);
  return c ? Object.assign({ role: 'kunde', label: custLabel(c) }, c) : null;
}
export function publicUser(u) {
  if (!u) return null;
  const o = { id: u.id, role: u.role, label: u.label };
  if (u.role === 'kunde') Object.assign(o, { firma: u.firma || '', adresse: u.adresse || '', kdnr: u.kdnr || '', name: u.name || '', email: u.email || '', tel: u.tel || '', ort: u.ort || '' });
  else Object.assign(o, { name: u.name, email: u.email });
  return o;
}
export async function setUserSecret(env, users, id, patch) {
  if (users.team[id]) Object.assign(users.team[id], patch);
  else { const c = users.customers.find(x => x.id === id); if (!c) return false; Object.assign(c, patch); }
  await saveUsers(env, users); return true;
}

/* Sitzungen (Cookie ak_sess) */
const COOKIE = 'ak_sess';
export function readCookie(request, name = COOKIE) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
export function sessionCookie(token, maxAge) {
  return COOKIE + '=' + (token || '') + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + (maxAge == null ? 2592000 : maxAge);
}
export async function newSession(env, user) {
  const t = randId(32);
  await putJSON(env, 'sess:' + t, { id: user.id, sv: user.sv || 1 }, { expirationTtl: 2592000 });
  return t;
}
export async function currentUser(request, env) {
  if (!accountsOn(env)) return null;
  const t = readCookie(request); if (!t) return null;
  const s = await getJSON(env, 'sess:' + t); if (!s) return null;
  const users = await loadUsers(env); const u = findUser(env, users, s.id);
  if (!u || u.active === false || (u.sv || 1) !== (s.sv || 1) || u.mustChange) return null;
  return u;
}

/* Admin-Prüfung: Passwort (Bearer ADMIN_PASSWORD) oder Admin-Sitzung im Konten-Modus */
export async function isAdmin(request, env) {
  const h = request.headers.get('authorization') || '';
  const pw = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (env.ADMIN_PASSWORD && pw && pw !== 'session' && safeEqual(pw, env.ADMIN_PASSWORD)) return true;
  const u = await currentUser(request, env); return !!(u && u.role === 'admin');
}
/* Lesezugriff auf die Planung: im Konten-Modus nur angemeldet oder mit persönlichem Freigabe-Link */
export async function canRead(request, env) {
  if (!accountsOn(env)) return true;
  if (await isAdmin(request, env)) return true;
  if (await currentUser(request, env)) return true;
  const tok = request.headers.get('x-ak-token');
  if (tok) { const c = await getJSON(env, 'config'); if (c && personByToken(c, tok)) return true; }
  return false;
}

/* ---------- Freigabe ---------- */
export function approvalPeople(c) {
  const a = (c && c.approval && c.approval.people) || {}; const out = [];
  Object.entries(a.pm || {}).forEach(([cat, arr]) => (arr || []).forEach(p => out.push({ key: 'pm:' + cat, p })));
  ['finance', 'marketing', 'sd'].forEach(k => (a[k] || []).forEach(p => out.push({ key: k, p })));
  return out;
}
export function personByToken(c, token) {
  if (!token) return null; const hit = approvalPeople(c).find(x => x.p && x.p.token && safeEqual(x.p.token, token));
  return hit ? hit.p : null;
}
export function stripTokens(c) {
  if (!c || !c.approval || !c.approval.people) return c;
  const x = JSON.parse(JSON.stringify(c)); approvalPeople(x).forEach(({ p }) => { delete p.token; }); return x;
}
export function keepTokens(oldC, newC) {
  const old = new Map(approvalPeople(oldC).filter(x => x.p && x.p.pid && x.p.token).map(x => [x.p.pid, x.p.token]));
  approvalPeople(newC).forEach(({ p }) => { if (p && !p.token && p.pid && old.has(p.pid)) p.token = old.get(p.pid); if (p && !p.token) p.token = randId(16); });
  return newC;
}

/* ---------- Aktionen der Planung (wie in der Seite) ---------- */
export function periodDays(c) { const out = []; const n = Math.max(1, Math.min(62, +c.count || 1)); for (let i = 0; i < n; i++) out.push(addDays(c.start, i)); return out; }
const inPeriod = (c, d) => { const p = periodDays(c); return d >= p[0] && d <= p[p.length - 1]; };
export function prodOf(c, k) {
  const i = String(k).indexOf('|'); const e = (c.extra || {})[k] || {};
  return { k, b: e.b || String(k).slice(0, i), m: e.m || String(k).slice(i + 1), t: e.t || '' };
}
export function dealBySlot(c, sl) {
  sl = String(sl || '');
  if (sl.startsWith('r-')) {
    const r = (c.ranges || []).find(x => 'r-' + x.id === sl); if (!r || !r.k) return null;
    let from, to;
    if (r.xd) { if (!inPeriod(c, r.from)) return null; from = to = r.from; }
    else {
      const days = periodDays(c), a = days[0], b = days[days.length - 1];
      from = r.full || !r.from || r.from < a || r.from > b ? a : r.from;
      to = r.full || !r.to || r.to > b || r.to < a ? b : r.to; if (to < from) to = from;
    }
    const one = !r.full && from === to;
    return { slot: sl, sk: sl, from, to, k: r.k, price: r.price ?? null, qty: r.qty ?? null, label: one ? fmtShort(from) : 'Zeitraum ' + fmtShort(from) + '–' + fmtShort(to) };
  }
  if (!/^\d{4}-\d\d-\d\d$/.test(sl) || !inPeriod(c, sl)) return null;
  const d = (c.days || {})[sl]; if (!d || !d.k) return null;
  return { slot: sl, sk: sl, from: sl, to: sl, k: d.k, price: d.price ?? null, qty: d.qty ?? null, label: fmtShort(sl) };
}

/* ---------- Checkliste je Aktion: [erledigt, gesamt, überfällig] (wie in der Seite) ---------- */
const CL_DEFAULT = [['before', 30], ['before', 28], ['before', 25], ['before', 21], ['before', 18], ['before', 16], ['before', 14], ['before', 12], ['before', 10], ['before', 7], ['before', 3], ['after', 0], ['after', 7]];
export function checklistStats(c) {
  if (!c || !c.start) return null;
  const list = Array.isArray(c.checklist) ? c.checklist.filter(x => x && x.id) : CL_DEFAULT.map(([when, days]) => ({ when, days, done: false }));
  const t = viennaToday(), end = addDays(c.start, Math.max(1, +c.count || 1) - 1);
  const due = x => x.when === 'after' ? addDays(end, Math.max(0, parseInt(x.days, 10) || 0)) : addDays(c.start, -Math.max(0, parseInt(x.days, 10) || 0));
  return [list.filter(x => x.done).length, list.length, list.filter(x => !x.done && due(x) < t).length];
}

/* ---------- Rate-Limit (grob, je Minute) ---------- */
export async function rateLimit(env, name, ip, max) {
  const key = 'rl:' + name + ':' + ip + ':' + Math.floor(Date.now() / 60000);
  const n = +(await kv(env).get(key)) || 0; if (n >= max) return false;
  await kv(env).put(key, String(n + 1), { expirationTtl: 120 }); return true;
}

/* ---------- Mailversand für Bestellungen ---------- */
const eur = v => (Math.round((+v || 0) * 100) / 100).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const escH = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
export function orderText(o) {
  const lines = o.items.map(x => '- ' + x.qty + ' × ' + x.brand + ' ' + x.model + (/^Bundle/.test(x.type || '') ? ' – ' + x.type : '') + ' (Aktion ' + x.aktion + ') à ' + eur(x.price) + ' = ' + eur(x.line)).join('\n');
  const cu = o.customer;
  return 'Bestellung ' + o.no + ' aus dem ' + o.title + '\n\n' + lines + '\nGesamt exkl. MwSt.: ' + eur(o.total) +
    '\n\nFirma: ' + cu.firma + '\nKundennummer: ' + (cu.kdnr || '') + '\nAnsprechpartner:in: ' + cu.name + '\nE-Mail: ' + cu.email + '\nTelefon: ' + cu.tel +
    (cu.adresse ? '\nLieferadresse: ' + cu.adresse : '') + (cu.notiz ? '\nBemerkung: ' + cu.notiz : '');
}
export function orderHtml(o) {
  const cu = o.customer;
  return '<div style="font-family:Arial,sans-serif;font-size:14px"><h2 style="margin:0 0 8px">Bestellung ' + escH(o.no) + '</h2><p>' + escH(o.title) + '</p>' +
    '<table cellpadding="6" style="border-collapse:collapse"><tr style="background:#eee"><th align="left">Menge</th><th align="left">Gerät</th><th align="left">Aktion</th><th align="right">Preis</th><th align="right">Summe</th></tr>' +
    o.items.map(x => '<tr><td>' + x.qty + '</td><td>' + escH(x.brand + ' ' + x.model + (/^Bundle/.test(x.type || '') ? ' – ' + x.type : '')) + '</td><td>' + escH(x.aktion) + '</td><td align="right">' + eur(x.price) + '</td><td align="right">' + eur(x.line) + '</td></tr>').join('') +
    '<tr><td colspan="4"><b>Gesamt exkl. MwSt.</b></td><td align="right"><b>' + eur(o.total) + '</b></td></tr></table>' +
    '<p>Firma: <b>' + escH(cu.firma) + '</b><br>Kundennummer: ' + escH(cu.kdnr || '') + '<br>Ansprechpartner:in: ' + escH(cu.name) + '<br>E-Mail: <a href="mailto:' + escH(cu.email) + '">' + escH(cu.email) + '</a><br>Telefon: <a href="tel:' + escH(String(cu.tel).replace(/[^\d+]/g, '')) + '">' + escH(cu.tel) + '</a>' +
    (cu.adresse ? '<br>Lieferadresse: ' + escH(cu.adresse) : '') + (cu.notiz ? '<br>Bemerkung: ' + escH(cu.notiz) : '') + '</p></div>';
}
/* Allgemeiner Mailversand: Variante A Resend, Variante B Webhook. Ergebnis: 'sent' | 'failed' | 'none' */
export async function sendMail(env, m) {
  const to = (m.to || []).filter(Boolean), cc = (m.cc || []).filter(Boolean); if (!to.length) return 'none';
  try {
    if (env.RESEND_API_KEY && env.MAIL_FROM) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to, cc: cc.length ? cc : undefined, reply_to: m.replyTo || undefined, subject: m.subject, text: m.text, html: m.html }),
      });
      return r.ok ? 'sent' : 'failed';
    }
    if (env.ORDER_WEBHOOK_URL) {
      const r = await fetch(env.ORDER_WEBHOOK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ to: to.join(','), cc: cc.join(','), subject: m.subject, text: m.text, html: m.html, kind: m.kind || 'mail' }, m.extra || {})),
      });
      return r.ok ? 'sent' : 'failed';
    }
  } catch (e) { return 'failed'; }
  return 'none';
}
export async function sendOrderMail(env, o, to) {
  const copy = String(env.MAIL_COPY_TO_CUSTOMER || 'true') !== 'false';
  return sendMail(env, { to: [to], cc: copy ? [o.customer.email] : [], replyTo: o.customer.email, subject: 'Bestellung ' + o.no + ' – ' + o.customer.firma, text: orderText(o), html: orderHtml(o), kind: 'order', extra: { order: o } });
}

/* ---------- Reminder: Aktionen rechtzeitig planen ---------- */
const splitMails = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(x => /^\S+@\S+\.\S+$/.test(x));
const fmtLong = s => +s.slice(8, 10) + '.' + +s.slice(5, 7) + '.' + s.slice(0, 4);
export function reminderMail(c, name, link, type) {
  const lead = c.lead == null || c.lead === '' ? 30 : +c.lead || 0, ls = addDays(c.start, -lead), end = addDays(c.start, Math.max(1, +c.count || 1) - 1);
  const due = x => x.when === 'after' ? addDays(end, +x.days || 0) : addDays(c.start, -(+x.days || 0));
  const open = (Array.isArray(c.checklist) ? c.checklist : []).filter(x => x && !x.done).sort((a, b) => due(a).localeCompare(due(b)));
  const period = fmtLong(c.start) + (end !== c.start ? ' – ' + fmtLong(end) : '');
  const head = type === 'week' ? 'Die Aktion „' + name + '“ startet in 7 Tagen (' + period + ') und es sind noch Punkte offen.' : 'Die Aktion „' + name + '“ (' + period + ') ist jetzt zu planen. Der Vorlauf von ' + lead + ' Tagen beginnt am ' + fmtLong(ls) + '.';
  const subject = (type === 'week' ? 'Start in 7 Tagen: ' : 'Jetzt planen: ') + name + ' (' + period + ')';
  const text = 'Hallo,\n\n' + head + '\n\nOffene Punkte der Checkliste:\n' + (open.map(x => '- ' + fmtLong(due(x)) + ': ' + x.text + (x.who ? ' (' + x.who + ')' : '')).join('\n') || '- keine') + '\n\nZur Aktion: ' + link + '\n\nViele Grüße\nAktionskalender Fachhandel';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px"><p>Hallo,</p><p>' + escH(head) + '</p><p><b>Offene Punkte der Checkliste</b></p><table cellpadding="5" style="border-collapse:collapse">' +
    (open.map(x => '<tr><td style="white-space:nowrap">' + fmtLong(due(x)) + '</td><td>' + escH(x.text) + '</td><td style="color:#666">' + escH(x.who || '') + '</td></tr>').join('') || '<tr><td>keine</td></tr>') +
    '</table><p><a href="' + escH(link) + '" style="display:inline-block;background:#1D5A43;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Aktion öffnen</a></p><p>Viele Grüße<br>Aktionskalender Fachhandel</p></div>';
  return { subject, text, html, open: open.length, leadStart: ls };
}
async function reminderTargets(env) {
  const out = new Map(); const live = await getJSON(env, 'config');
  if (live && live.start) out.set(live.aid || 'live', { aid: live.aid || 'live', name: live.title || 'Aktionskalender', cfg: live });
  const idx = await getJSON(env, 'akidx:aktionen', {});
  for (const m of Object.values(idx)) {
    if (!m || !m.start || out.has(m.id) || !['aktion', 'geplant'].includes(m.kind)) continue;
    const it = await getJSON(env, 'ak:aktionen:' + m.id); if (it && it.config && it.config.start) out.set(m.id, { aid: m.id, name: it.name || it.config.title || 'Aktion', cfg: it.config });
  }
  return [...out.values()];
}
/* ---------- Newsletter an die Händler ---------- */
export const mailReady = env => !!((env.RESEND_API_KEY && env.MAIL_FROM) || env.ORDER_WEBHOOK_URL);
export async function nlRecipients(env) {
  if (!accountsOn(env)) return null;
  const users = await loadUsers(env); let changed = false;
  const list = users.customers.filter(c => c.active !== false && c.newsletter !== false && /^\S+@\S+\.\S+$/.test(String(c.email || '').trim()));
  list.forEach(c => { if (!c.nlt) { c.nlt = randId(20); changed = true; } });
  if (changed) await saveUsers(env, users);
  return list.map(c => ({ id: c.id, email: String(c.email).trim(), name: c.name || '', firma: c.firma || '', nlt: c.nlt }));
}
function nlPersonal(tpl, r, origin) {
  const unsub = origin + '/api/newsletter/abmelden?id=' + encodeURIComponent(r.id) + '&t=' + encodeURIComponent(r.nlt || '');
  const greet = r.name ? 'Guten Tag ' + r.name + ',' : 'Guten Tag,';
  return { html: String(tpl.html || '').replace(/\{\{anrede\}\}/g, escH(greet)).replace(/\{\{abmelden\}\}/g, escH(unsub)), text: String(tpl.text || '').replace(/\{\{anrede\}\}/g, greet).replace(/\{\{abmelden\}\}/g, unsub), unsub };
}
/* Versand an viele Empfänger: Resend in Paketen zu 100 (wenige Anfragen), Webhook mit Empfängerliste in einer Anfrage */
export async function sendNewsletter(env, tpl, recipients, origin) {
  if (!recipients.length) return { sent: 0, failed: 0, mail: mailReady(env) };
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    let sent = 0, failed = 0;
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100).map(r => { const p = nlPersonal(tpl, r, origin); return { from: env.MAIL_FROM, to: [r.email], subject: tpl.subj, html: p.html, text: p.text, headers: { 'List-Unsubscribe': '<' + p.unsub + '>' } }; });
      try { const res = await fetch('https://api.resend.com/emails/batch', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(chunk) }); if (res.ok) sent += chunk.length; else failed += chunk.length; } catch (e) { failed += chunk.length; }
    }
    return { sent, failed, mail: true };
  }
  if (env.ORDER_WEBHOOK_URL) {
    const list = recipients.map(r => { const p = nlPersonal(tpl, r, origin); return { email: r.email, name: r.name, firma: r.firma, abmelden: p.unsub, html: p.html, text: p.text }; });
    try { const res = await fetch(env.ORDER_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'newsletter', subject: tpl.subj, recipients: list, to: '', cc: '', html: list[0].html, text: list[0].text }) });
      return res.ok ? { sent: list.length, failed: 0, mail: true } : { sent: 0, failed: list.length, mail: true }; } catch (e) { return { sent: 0, failed: list.length, mail: true }; }
  }
  return { sent: 0, failed: 0, mail: false };
}
async function logNl(env, e) { const log = await getJSON(env, 'nllog', []); log.unshift(e); await putJSON(env, 'nllog', log.slice(0, 200)); }
export async function runNewsletters(env, origin, opt) {
  opt = opt || {}; const today = viennaToday(), out = [];
  for (const t of await reminderTargets(env)) {
    if (opt.aid && t.aid !== opt.aid) continue;
    const c = t.cfg, N = c.newsletter || {};
    if (!N.html || !N.subj) { if (opt.aid) out.push({ aid: t.aid, error: 'Kein Newsletter-Inhalt – bitte in der Planung „Automatisch senden“ aktivieren und speichern' }); continue; }
    const days = N.days == null || N.days === '' ? 14 : +N.days || 0, key = 'nl:' + t.aid + ':' + c.start;
    if (!opt.aid) { if (!N.on || today < addDays(c.start, -days) || today > c.start || (await kv(env).get(key))) continue; }
    let rec;
    if (opt.test) rec = [...new Set(splitMails(c.owners).concat(splitMails(env.REMINDER_TO)))].map(e => ({ id: 'test', email: e, name: '', firma: '', nlt: 'test' }));
    else rec = (await nlRecipients(env)) || [];
    const res = await sendNewsletter(env, N, rec, origin);
    const e = { aid: t.aid, name: t.name, at: new Date().toISOString(), test: !!opt.test, auto: !opt.aid, sent: res.sent, failed: res.failed, to: opt.test ? rec.map(r => r.email) : undefined, note: !res.mail ? 'kein Mailversand eingerichtet' : !rec.length ? 'keine Empfänger' : '' };
    out.push(Object.assign({ mail: res.mail }, e)); await logNl(env, e);
    if (!opt.test && !opt.aid && res.mail && rec.length && res.sent) await kv(env).put(key, new Date().toISOString(), { expirationTtl: 400 * 86400 });
    if (!opt.test && opt.aid && res.sent) await kv(env).put(key, new Date().toISOString(), { expirationTtl: 400 * 86400 });
  }
  return out;
}
async function logReminder(env, e) { const log = await getJSON(env, 'remlog', []); log.unshift(e); await putJSON(env, 'remlog', log.slice(0, 300)); }
export async function runReminders(env, origin, onlyAid) {
  const today = viennaToday(), res = [];
  for (const t of await reminderTargets(env)) {
    if (onlyAid && t.aid !== onlyAid) continue;
    const c = t.cfg, lead = c.lead == null || c.lead === '' ? 30 : +c.lead || 0, ls = addDays(c.start, -lead);
    const to = [...new Set(splitMails(c.owners).concat(splitMails(env.REMINDER_TO)))];
    const types = [];
    if (onlyAid) types.push('manual');
    else {
      if (today >= ls && today <= c.start) types.push('lead');
      if (today >= addDays(c.start, -7) && today < c.start) types.push('week');
    }
    for (const type of types) {
      const key = 'rem:' + t.aid + ':' + type + ':' + c.start;
      if (type !== 'manual' && (await kv(env).get(key))) continue;
      const m = reminderMail(c, t.name, origin + '/admin#ak-' + t.aid, type === 'manual' ? 'lead' : type);
      if (type === 'week' && !m.open) { await kv(env).put(key, 'skip', { expirationTtl: 400 * 86400 }); continue; }
      if (!to.length) { const e = { aid: t.aid, name: t.name, type, at: new Date().toISOString(), to: [], ok: false, note: 'keine Empfänger' }; res.push(e); if (type !== 'manual') { await logReminder(env, e); await kv(env).put(key, 'noto', { expirationTtl: 86400 }); } continue; }
      const st = await sendMail(env, { to, subject: m.subject, text: m.text, html: m.html, kind: 'reminder' });
      const e = { aid: t.aid, name: t.name, type, at: new Date().toISOString(), to, ok: st === 'sent', note: st === 'none' ? 'kein Mailversand eingerichtet' : '' };
      res.push(e); await logReminder(env, e);
      if (st === 'sent' && type !== 'manual') await kv(env).put(key, new Date().toISOString(), { expirationTtl: 400 * 86400 });
    }
  }
  return res;
}
