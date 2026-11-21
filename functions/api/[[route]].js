/* Alle /api/…-Endpunkte des Aktionskalenders (Cloudflare Pages Functions) */
import {
  json, err, sleep, body, randId, safeEqual, viennaToday, clientIp, kv, getJSON, putJSON, MAX_CONFIG, MAX_FILE,
  accountsOn, initialPw, teamFromEnv, hashPw, pwRuleError, loadUsers, saveUsers, findUser, publicUser, setUserSecret, custLabel,
  readCookie, sessionCookie, newSession, currentUser, isAdmin, canRead,
  approvalPeople, personByToken, stripTokens, keepTokens, dealBySlot, prodOf, rateLimit, sendOrderMail, checklistStats, runReminders, runNewsletters, nlRecipients, mailReady, inviteMailContent, sendMail,
} from './_lib.js';

export async function onRequest(context) {
  const { request, env } = context;
  try { return await route(request, env, context); }
  catch (e) { return err(500, 'Serverfehler: ' + (e && e.message ? e.message : 'unbekannt')); }
}

export async function route(request, env, context) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [a, b] = parts, m = request.method;
  if (!env.KALENDER) return err(500, 'KV-Bindung KALENDER fehlt – bitte in Cloudflare unter Settings → Bindings anlegen und neu deployen.');

  /* ----- Planung ----- */
  if (a === 'config' && m === 'GET') {
    if (!(await canRead(request, env))) return err(401, 'Bitte anmelden');
    const [c, sold] = await Promise.all([getJSON(env, 'config'), getJSON(env, 'sold', {})]);
    const admin = await isAdmin(request, env);
    return json({ config: admin ? c : stripTokens(c), sold });
  }
  if (a === 'config' && m === 'PUT') {
    if (!(await isAdmin(request, env))) return err(401, 'Nicht angemeldet');
    const text = await request.text();
    if (text.length > MAX_CONFIG) return err(413, 'Planung zu groß (max. 2 MB)');
    let c; try { c = JSON.parse(text); } catch (e) { return err(400, 'Ungültige Daten'); }
    if (!c || typeof c !== 'object' || !c.start || !c.count) return err(400, 'Ungültige Planung');
    const old = await kv(env).get('config');
    if (old) await kv(env).put('backup:' + new Date().toISOString(), old, { expirationTtl: 90 * 86400 });
    keepTokens(old ? JSON.parse(old) : null, c);
    c.updatedAt = new Date().toISOString();
    await putJSON(env, 'config', c);
    return json({ ok: true, updatedAt: c.updatedAt });
  }
  if (a === 'auth' && m === 'POST') {
    const j = await body(request);
    if (env.ADMIN_PASSWORD && j && safeEqual(j.password, env.ADMIN_PASSWORD)) return json({ ok: true });
    await sleep(400); return err(401, 'Passwort falsch');
  }

  /* ----- Freigabe ----- */
  if (a === 'whoami' && m === 'POST') {
    const j = await body(request); const c = await getJSON(env, 'config');
    const p = c && j && personByToken(c, j.token);
    if (!p) { await sleep(300); return err(404, 'Link ungültig'); }
    return json({ pid: p.pid, name: p.name || '' });
  }
  if (a === 'approvals' && m === 'GET') {
    if (!(await canRead(request, env))) return err(401, 'Bitte anmelden');
    return json({ byPid: await getJSON(env, 'approvals', {}) });
  }
  if (a === 'approve' && m === 'POST') {
    const j = await body(request); const c = await getJSON(env, 'config');
    const p = c && j && personByToken(c, j.token);
    if (!p) return err(403, 'Link ungültig');
    const key = String(j.key || ''), status = j.status, note = String(j.note || '').slice(0, 2000);
    if (!['ok', 'rejected'].includes(status)) return err(400, 'Ungültige Entscheidung');
    if (status === 'rejected' && !note.trim()) return err(400, 'Ablehnung nur mit Kommentar');
    if (!approvalPeople(c).some(x => x.key === key && x.p.pid === p.pid)) return err(403, 'Keine Berechtigung für diese Stufe');
    const all = await getJSON(env, 'approvals', {}); const at = new Date().toISOString();
    const cur = all[p.pid] || { entries: {}, log: [] };
    cur.name = p.name || cur.name || '';
    cur.entries = Object.assign({}, cur.entries, { [key]: { status, note, hash: String(j.hash || ''), at, name: cur.name } });
    cur.log = [{ key, status, note, at }].concat(cur.log || []).slice(0, 100);
    all[p.pid] = cur; await putJSON(env, 'approvals', all);
    return json({ ok: true });
  }

  /* ----- Bestellungen ----- */
  if (a === 'order' && m === 'POST') {
    if (!(await rateLimit(env, 'order', clientIp(request), 8))) return err(429, 'Zu viele Bestellungen in kurzer Zeit – bitte in einer Minute erneut versuchen.');
    let me = null;
    if (accountsOn(env)) { me = await currentUser(request, env); if (!me) return err(401, 'Bitte zuerst anmelden'); }
    const j = await body(request); if (!j || !Array.isArray(j.items) || !j.items.length) return err(400, 'Der Warenkorb ist leer');
    const cu = {}; ['firma', 'kdnr', 'name', 'email', 'tel', 'adresse', 'notiz'].forEach(k => (cu[k] = String((j.customer || {})[k] || '').trim().slice(0, 300)));
    if (me && me.role === 'kunde') { cu.firma = me.firma || cu.firma; cu.kdnr = me.kdnr || cu.kdnr; }
    for (const [k, l] of [['firma', 'die Firma'], ['name', 'die Ansprechperson'], ['email', 'die E-Mail'], ['tel', 'die Telefonnummer']]) if (!cu[k]) return err(400, 'Bitte ' + l + ' angeben.');
    if (!/^\S+@\S+\.\S+$/.test(cu.email)) return err(400, 'Bitte eine gültige E-Mail angeben.');
    const c = await getJSON(env, 'config'); if (!c) return err(409, 'Keine Planung vorhanden');
    const sold = await getJSON(env, 'sold', {}); const today = viennaToday(); const items = [];
    for (const it of j.items.slice(0, 50)) {
      const d = dealBySlot(c, it.day); const qty = Math.round(+it.qty || 0);
      if (!d || d.k !== it.k || today < d.from || today > d.to) return err(409, 'Eine Aktion im Warenkorb ist nicht mehr bestellbar.', { sold });
      if (d.price == null) return err(409, 'Für eine Aktion ist kein Preis hinterlegt – bitte telefonisch bestellen.', { sold });
      if (qty < 1 || qty > 999) return err(400, 'Ungültige Menge');
      const left = d.qty == null ? null : Math.max(0, d.qty - (sold[d.sk] || 0) - items.filter(x => x.day === d.sk).reduce((s, x) => s + x.qty, 0));
      if (left != null && qty > left) return err(409, left ? 'Nur mehr ' + left + ' Stück verfügbar.' : 'Leider ausverkauft.', { sold });
      const p = prodOf(c, d.k);
      items.push({ day: d.sk, aktion: d.label, k: d.k, brand: p.b, model: p.m, type: p.t, qty, price: d.price, line: Math.round(d.price * qty * 100) / 100 });
    }
    items.forEach(x => (sold[x.day] = (sold[x.day] || 0) + x.qty));
    await putJSON(env, 'sold', sold);
    const order = { no: 'AK-' + today.replace(/-/g, '') + '-' + randId(4).toUpperCase(), at: new Date().toISOString(), items, total: Math.round(items.reduce((s, x) => s + x.line, 0) * 100) / 100, customer: cu, title: c.title || 'Aktionskalender', user: me ? me.id : undefined };
    order.mail = await sendOrderMail(env, order, c.orderEmail || 'order.austria@beko.com');
    const orders = await getJSON(env, 'orders', []); orders.unshift(order); await putJSON(env, 'orders', orders.slice(0, 5000));
    return json({ order, mailed: order.mail === 'sent', sold });
  }
  if (a === 'orders' && m === 'GET') {
    if (!(await isAdmin(request, env))) return err(401, 'Nicht angemeldet');
    const [orders, sold] = await Promise.all([getJSON(env, 'orders', []), getJSON(env, 'sold', {})]);
    return json({ orders, sold });
  }

  /* ----- Dateien (Datenblätter als PDF) ----- */
  if (a === 'file' && !b && m === 'POST') {
    if (!(await isAdmin(request, env))) return err(401, 'Nicht angemeldet');
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return err(400, 'Leere Datei'); if (buf.byteLength > MAX_FILE) return err(413, 'Die PDF ist größer als 20 MB');
    const head = new Uint8Array(buf.slice(0, 5)); if (String.fromCharCode(...head) !== '%PDF-') return err(400, 'Bitte eine PDF-Datei wählen');
    const id = randId(20); let name = 'Datenblatt.pdf'; try { name = decodeURIComponent(request.headers.get('x-file-name') || name); } catch (e) {}
    await kv(env).put('file:' + id, buf, { metadata: { name: name.slice(0, 120), type: 'application/pdf' } });
    return json({ id });
  }
  if (a === 'file' && b && m === 'GET') {
    const r = await kv(env).getWithMetadata('file:' + b, 'arrayBuffer'); if (!r || !r.value) return err(404, 'Datei nicht gefunden');
    const name = (r.metadata && r.metadata.name) || 'Datenblatt.pdf';
    return new Response(r.value, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(name), 'cache-control': 'public, max-age=86400' } });
  }

  /* ----- Aktionen: Vorlagen, Archiv, Versionen ----- */
  if (a === 'aktionen') {
    if (!(await isAdmin(request, env))) return err(401, 'Nicht angemeldet');
    const kind = url.searchParams.get('kind'), id = url.searchParams.get('id');
    if (!['aktionen', 'versionen'].includes(kind)) return err(400, 'Unbekannte Art');
    const idxKey = 'akidx:' + kind, idx = await getJSON(env, idxKey, {});
    if (m === 'GET' && !id) return json({ items: Object.values(idx).sort((x, y) => String(y.at).localeCompare(String(x.at))) });
    if (!id || !/^[\w.-]{1,80}$/.test(id)) return err(400, 'Ungültige ID');
    if (m === 'GET') { const item = await getJSON(env, 'ak:' + kind + ':' + id); return item ? json({ item }) : err(404, 'Nicht gefunden'); }
    if (m === 'DELETE') { await kv(env).delete('ak:' + kind + ':' + id); delete idx[id]; await putJSON(env, idxKey, idx); return json({ ok: true }); }
    if (m === 'PUT') {
      const text = await request.text(); if (text.length > MAX_CONFIG) return err(413, 'Zu groß (max. 2 MB)');
      let o; try { o = JSON.parse(text); } catch (e) { return err(400, 'Ungültige Daten'); }
      o.id = id; await kv(env).put('ak:' + kind + ':' + id, JSON.stringify(o));
      const cc = o.config || {};
      const meta = { id, kind: o.kind, name: o.name, at: o.at, by: o.by || '', byName: o.byName || '', title: cc.title || '', theme: cc.theme, start: cc.start, count: cc.count,
        deals: Object.values(cc.days || {}).filter(d => d && d.k).length + (cc.ranges || []).length, sum: o.result ? o.result.sum : null,
        lead: cc.lead == null || cc.lead === '' ? 30 : +cc.lead || 0, cl: checklistStats(cc), owners: String(cc.owners || '') };
      idx[id] = meta;
      if (kind === 'versionen') { const ids = Object.values(idx).sort((x, y) => String(y.at).localeCompare(String(x.at))).map(x => x.id); for (const old of ids.slice(30)) { delete idx[old]; await kv(env).delete('ak:versionen:' + old); } }
      await putJSON(env, idxKey, idx); return json({ meta });
    }
    return err(405, 'Methode nicht erlaubt');
  }

  /* ----- Reminder ----- */
  if (a === 'reminders') {
    const origin = String(env.PUBLIC_URL || url.origin).replace(/\/+$/, '');
    if (b === 'run' && m === 'POST') {
      const h = request.headers.get('authorization') || '', key = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!((env.REMINDER_KEY && safeEqual(key, env.REMINDER_KEY)) || (await isAdmin(request, env)))) return err(401, 'Nicht berechtigt');
      const res = await runReminders(env, origin, null); const nl = await runNewsletters(env, origin, null);
      return json({ ok: true, sent: res.filter(x => x.ok).length, results: res, newsletters: nl });
    }
    if (!(await isAdmin(request, env))) return err(401, 'Nicht angemeldet');
    if (b === 'send' && m === 'POST') {
      const j = (await body(request)) || {}; if (!j.aid) return err(400, 'Aktion fehlt');
      const res = await runReminders(env, origin, String(j.aid)); if (!res.length) return err(404, 'Aktion nicht gefunden');
      const r = res[0]; if (!r.to.length) return err(400, 'Keine Verantwortlichen mit E-Mail eingetragen');
      return json({ sent: r.ok, result: r });
    }
    if (!b && m === 'GET') return json({ log: await getJSON(env, 'remlog', []) });
    return err(404, 'Unbekannt');
  }

  /* ----- Newsletter an die Händler ----- */
  if (a === 'newsletter') {
    const origin = String(env.PUBLIC_URL || url.origin).replace(/\/+$/, '');
    if (b === 'abmelden' && m === 'GET') {
      const id = url.searchParams.get('id') || '', t = url.searchParams.get('t') || ''; let ok = false;
      if (accountsOn(env)) { const users = await loadUsers(env); const c = users.customers.find(x => x.id === id); if (c && c.nlt && safeEqual(c.nlt, t)) { c.newsletter = false; await saveUsers(env, users); ok = true; } }
      const page = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Newsletter</title></head><body style="font-family:Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#111"><h2>' + (ok ? 'Sie wurden abgemeldet' : 'Abmeldung nicht möglich') + '</h2><p>' + (ok ? 'Sie erhalten keine Aktions-Newsletter mehr. Ihren Zugang zum Aktionskalender können Sie weiter nutzen.' : 'Der Link ist ungültig. Bitte wenden Sie sich an order.austria@beko.com.') + '</p></body></html>';
      return new Response(page, { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (!(await isAdmin(request, env))) return err(401, 'Nicht angemeldet');
    if (!b && m === 'GET') { const rec = await nlRecipients(env); return json({ recipients: rec ? rec.length : null, mail: mailReady(env), log: await getJSON(env, 'nllog', []) }); }
    if (b === 'send' && m === 'POST') {
      const j = (await body(request)) || {}; if (!j.aid) return err(400, 'Aktion fehlt');
      const res = await runNewsletters(env, origin, { aid: String(j.aid), test: !!j.test }); if (!res.length) return err(404, 'Aktion nicht gefunden');
      const r = res[0]; if (r.error) return err(400, r.error);
      if (j.test && !(r.to || []).length) return err(400, 'Für den Testversand bitte Verantwortliche mit E-Mail eintragen');
      if (!j.test && r.mail && !r.sent && !r.failed) return err(400, 'Keine Händler mit E-Mail-Adresse vorhanden');
      return json(r);
    }
    return err(404, 'Unbekannt');
  }

  /* ----- Konten (nur wenn ADMIN_USERS gesetzt ist) ----- */
  if (a === 'session') {
    if (!accountsOn(env)) return err(404, 'Konten sind nicht eingeschaltet');
    const users = await loadUsers(env);
    if (b === 'me') { const u = await currentUser(request, env); return json({ server: 'konten', user: publicUser(u) }); }
    if (b === 'users' && m === 'GET') {
      return json({ customers: users.customers.filter(x => x.active !== false).map(x => ({ id: x.id, label: custLabel(x) })).sort((x, y) => x.label.localeCompare(y.label, 'de')),
        team: teamFromEnv(env).map(t => ({ id: t.id, label: t.name })) });
    }
    if (b === 'invite' && m === 'GET') {
      const t = url.searchParams.get('t') || '';
      const all = teamFromEnv(env).map(x => findUser(env, users, x.id)).concat(users.customers.map(x => findUser(env, users, x.id)));
      const u = all.find(x => x && x.mustChange && x.invite && safeEqual(x.invite, t) && x.active !== false);
      return u ? json({ id: u.id, role: u.role, label: u.label }) : err(404, 'Dieser Einladungs-Link ist nicht mehr gültig.');
    }
    if (b === 'login' && m === 'POST') {
      if (!(await rateLimit(env, 'login', clientIp(request), 10))) return err(429, 'Zu viele Versuche – bitte eine Minute warten.');
      const j = (await body(request)) || {}; const u = findUser(env, users, String(j.id || ''));
      if (!u || u.active === false) { await sleep(400); return err(401, 'Benutzer oder Passwort falsch.'); }
      if (u.mustChange) {
        // Beko-Team: Erstanmeldung auch mit dem Verwaltungs-Passwort (ADMIN_PASSWORD) – so kommt der erste Admin ohne Einladung hinein
        const boot = u.role === 'admin' && env.ADMIN_PASSWORD && safeEqual(j.password, env.ADMIN_PASSWORD);
        if (!boot) {
          if (!j.invite || !u.invite || !safeEqual(j.invite, u.invite)) { await sleep(400); return err(401, 'Bitte für die Erstanmeldung den persönlichen Einladungs-Link verwenden.'); }
          if (!safeEqual(j.password, initialPw(env))) { await sleep(400); return err(401, 'Das Startpasswort stimmt nicht.'); }
        }
        const ticket = randId(24); await putJSON(env, 'ticket:' + ticket, { id: u.id }, { expirationTtl: 900 });
        return json({ mustChange: true, ticket, user: { label: u.label, role: u.role } });
      }
      if (!u.hash || !u.salt || !safeEqual(await hashPw(String(j.password || ''), u.salt), u.hash)) { await sleep(400); return err(401, 'Benutzer oder Passwort falsch.'); }
      await setUserSecret(env, users, u.id, { lastLogin: new Date().toISOString() });
      const t = await newSession(env, u);
      return json({ user: publicUser(u) }, 200, { 'set-cookie': sessionCookie(t) });
    }
    if (b === 'change' && m === 'POST') {
      const j = (await body(request)) || {}; let u = null, viaTicket = false;
      if (j.ticket) { const tk = await getJSON(env, 'ticket:' + j.ticket); if (!tk) return err(401, 'Die Anmeldung ist abgelaufen – bitte den Einladungs-Link erneut öffnen.'); u = findUser(env, users, tk.id); viaTicket = true; }
      else {
        u = await currentUser(request, env); if (!u) return err(401, 'Bitte anmelden');
        if (!safeEqual(await hashPw(String(j.old || ''), u.salt || ''), u.hash || '')) { await sleep(400); return err(401, 'Das bisherige Passwort stimmt nicht.'); }
      }
      if (!u) return err(404, 'Benutzer nicht gefunden');
      const bad = pwRuleError(env, j.password); if (bad) return err(400, bad);
      const salt = randId(16), hash = await hashPw(String(j.password), salt);
      await setUserSecret(env, users, u.id, { salt, hash, mustChange: false, invite: null, lastLogin: new Date().toISOString() });
      if (viaTicket) { await kv(env).delete('ticket:' + j.ticket); const t = await newSession(env, Object.assign({}, u, { sv: u.sv || 1 })); return json({ ok: true }, 200, { 'set-cookie': sessionCookie(t) }); }
      return json({ ok: true });
    }
    if (b === 'logout') { const t = readCookie(request); if (t) await kv(env).delete('sess:' + t); return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) }); }
    return err(404, 'Unbekannt');
  }

  if (a === 'users') {
    if (!accountsOn(env)) return err(404, 'Konten sind nicht eingeschaltet');
    const me = await currentUser(request, env); if (!me || me.role !== 'admin') return err(401, 'Nur für das Beko-Team');
    const users = await loadUsers(env);
    const view = () => ({
      customers: users.customers.map(x => ({ id: x.id, firma: x.firma || '', adresse: x.adresse || '', ort: x.ort || '', kdnr: x.kdnr || '', name: x.name || '', email: x.email || '', tel: x.tel || '', active: x.active !== false, newsletter: x.newsletter !== false,
        status: x.mustChange ? 'eingeladen' : 'aktiv', lastLogin: x.lastLogin || null, invite: x.mustChange ? x.invite : undefined, invitedAt: x.invitedAt || null, role: 'kunde' })),
      team: teamFromEnv(env).map(t => { const s = users.team[t.id] || {}; return { id: t.id, role: 'admin', name: t.name, email: t.email, status: s.mustChange ? 'eingeladen' : 'aktiv', lastLogin: s.lastLogin || null, invite: s.mustChange ? s.invite : undefined, invitedAt: s.invitedAt || null }; }),
      initial: initialPw(env), me: me.id,
    });
    if (m === 'GET') return json(view());
    if (m === 'PUT') {
      const j = await body(request); if (!j || !Array.isArray(j.customers)) return err(400, 'Ungültige Daten');
      const old = new Map(users.customers.map(x => [x.id, x])); const next = [];
      for (const x of j.customers.slice(0, 5000)) {
        const firma = String(x.firma || '').trim(); if (!firma) return err(400, 'Bitte bei jedem Kunden eine Firma eintragen');
        const pub = { firma, adresse: String(x.adresse || '').trim().slice(0, 200), ort: String(x.ort || '').trim(), kdnr: String(x.kdnr || '').trim(), name: String(x.name || '').trim(), email: String(x.email || '').trim(), tel: String(x.tel || '').trim(), active: x.active !== false, newsletter: x.newsletter !== false };
        const prev = x.id && old.get(x.id);
        next.push(prev ? Object.assign({}, prev, pub) : Object.assign({ id: 'k-' + randId(10), mustChange: true, invite: randId(20), sv: 1 }, pub));
      }
      users.customers = next; await saveUsers(env, users); return json(view());
    }
    if (m === 'POST') {
      const j = (await body(request)) || {};
      if (j.action === 'reset') {
        const u = findUser(env, users, String(j.id || '')); if (!u) return err(404, 'Zugang nicht gefunden');
        if (u.id === me.id) return err(400, 'Das eigene Passwort bitte über „Passwort ändern“ ändern.');
        await setUserSecret(env, users, u.id, { mustChange: true, invite: randId(20), hash: null, salt: null, sv: (u.sv || 1) + 1 });
        return json(view());
      }
      if (j.action === 'invite') {
        // Einladungen über den eingerichteten Mailversand; je Anfrage max. 40 (Grenze für ausgehende Anfragen)
        if (!mailReady(env)) return json(Object.assign(view(), { result: { sent: 0, failed: 0, mail: false, skipped: [] } }));
        const origin = String(env.PUBLIC_URL || url.origin).replace(/\/+$/, ''), c = (await getJSON(env, 'config')) || {};
        const ids = Array.isArray(j.ids) ? j.ids.map(String).slice(0, 40) : [];
        let sent = 0, failed = 0; const skipped = [], at = new Date().toISOString();
        for (const id of ids) {
          const u = findUser(env, users, id);
          if (!u || u.active === false || !u.mustChange || !u.invite) { skipped.push({ id, why: 'nicht eingeladen' }); continue; }
          if (!/^\S+@\S+\.\S+$/.test(String(u.email || '').trim())) { skipped.push({ id, why: 'keine E-Mail' }); continue; }
          const mcont = inviteMailContent(env, u, origin, c);
          const st = await sendMail(env, { to: [String(u.email).trim()], subject: mcont.subject, text: mcont.text, html: mcont.html, kind: 'invite' });
          if (st === 'sent') { sent++; if (users.team[u.id]) users.team[u.id].invitedAt = at; else { const cc = users.customers.find(x => x.id === u.id); if (cc) cc.invitedAt = at; } } else failed++;
        }
        if (sent) await saveUsers(env, users);
        return json(Object.assign(view(), { result: { sent, failed, mail: true, skipped } }));
      }
      return err(400, 'Unbekannte Aktion');
    }
    return err(405, 'Methode nicht erlaubt');
  }

  return err(404, 'Unbekannter Endpunkt');
}
