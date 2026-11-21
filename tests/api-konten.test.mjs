// Nur gegen eine lokale Testumgebung ausführen (npm run dev) – der Test schreibt Testdaten in den Speicher!
const B = process.env.BASE || 'http://localhost:8788', PW = process.env.ADMIN_PASSWORD || 'test-Passwort-123';
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Vienna'}).format(new Date());
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x ?? ''); } };
const jar = {}; const ck = n => jar[n] ? { cookie: 'ak_sess=' + jar[n] } : {};
async function j(p, o = {}, who) {
  o.headers = Object.assign({ 'content-type':'application/json' }, o.headers || {}, ck(who));
  const r = await fetch(B + p, o); const sc = r.headers.get('set-cookie'); if (sc && who){ const m = sc.match(/ak_sess=([^;]*)/); jar[who] = m ? m[1] : ''; }
  let b; try { b = await r.json(); } catch(e) { b = null; } return { s: r.status, b };
}
const P = o => ({ method:'POST', body: JSON.stringify(o) });
const ADM = 't-harald-test-at';
let u = await j('/api/session/users'); check('users list', u.b.team.length === 1 && u.b.team[0].id === ADM);
check('config locked', (await j('/api/config')).s === 401);
check('users noauth', (await j('/api/users')).s === 401);
const aw = await j('/api/session/login', P({ id:ADM, password:'start2026' }), 'adm'); check('admin wrong', aw.s === 401 && /Verwaltungs-Passwort/.test(aw.b.error), JSON.stringify(aw.b));
let r = await j('/api/session/login', P({ id:ADM, password:PW }), 'adm'); check('admin boot', r.s === 200 && r.b.mustChange && r.b.ticket, JSON.stringify(r.b));
check('weak pw', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'kurz' }), 'adm')).s === 400);
check('initial pw not allowed', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'start2026' }), 'adm')).s === 400);
check('set pw', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'Harald2026x' }), 'adm')).s === 200);
let me = await j('/api/session/me', {}, 'adm'); check('me admin', me.b.user && me.b.user.role === 'admin', JSON.stringify(me.b));
check('admin put config (session)', (await j('/api/config', { method:'PUT', headers:{ authorization:'Bearer session' }, body: JSON.stringify({ title:'BW', start: today, count:2, pool:{}, days:{ [today]:{ k:'Beko|X1', price:10, qty:3 } } }) }, 'adm')).s === 200);
let ul = await j('/api/users', {}, 'adm'); check('users get', ul.s === 200 && ul.b.initial === 'start2026' && ul.b.me === ADM && ul.b.team[0].invite === undefined);
ul = await j('/api/users', { method:'PUT', body: JSON.stringify({ customers:[{ firma:'Elektro Muster', adresse:'Hauptstraße 12', ort:'4020 Linz', kdnr:'100234', name:'Max', email:'max@muster.at', tel:'+43 732 1' }] }) }, 'adm');
check('adresse stored', ul.b.customers[0].adresse === 'Hauptstraße 12');
const cust = ul.b.customers[0]; check('cust created', cust && cust.id && cust.status === 'eingeladen' && cust.invite, JSON.stringify(ul.b));
check('invite lookup', (await j('/api/session/invite?t=' + cust.invite)).b.id === cust.id);
check('cust login no invite', (await j('/api/session/login', P({ id:cust.id, password:'start2026' }), 'k')).s === 401);
r = await j('/api/session/login', P({ id:cust.id, password:'start2026', invite:cust.invite }), 'k'); check('cust first login', r.b.mustChange);
check('cust set pw', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'Muster2026a' }), 'k')).s === 200);
me = await j('/api/session/me', {}, 'k'); check('me kunde', me.b.user.role === 'kunde' && me.b.user.firma === 'Elektro Muster');
check('kunde config read', (await j('/api/config', {}, 'k')).s === 200);
check('kunde no users', (await j('/api/users', {}, 'k')).s === 401);
check('kunde no config put', (await j('/api/config', { method:'PUT', headers:{ authorization:'Bearer session' }, body:'{}' }, 'k')).s === 401);
let o = await j('/api/order', P({ items:[{ day: today, k:'Beko|X1', qty:1 }], customer:{ firma:'Fake GmbH', name:'Max', email:'max@muster.at', tel:'1' } }), 'k');
check('kunde order firma locked', o.s === 200 && o.b.order.customer.firma === 'Elektro Muster' && o.b.order.customer.kdnr === '100234', JSON.stringify(o.b));
check('anon order blocked', (await j('/api/order', P({ items:[{ day: today, k:'Beko|X1', qty:1 }], customer:{ firma:'a', name:'b', email:'c@d.at', tel:'1' } }))).s === 401);
check('pw change old wrong', (await j('/api/session/change', P({ old:'xx', password:'Neu2026abc' }), 'k')).s === 401);
check('pw change', (await j('/api/session/change', P({ old:'Muster2026a', password:'Neu2026abc' }), 'k')).s === 200);
check('login new pw', (await j('/api/session/login', P({ id:cust.id, password:'Neu2026abc' }), 'k2')).s === 200);
ul = await j('/api/users', P({ action:'reset', id:cust.id }), 'adm'); check('reset', ul.b.customers[0].status === 'eingeladen');
check('old session dead', (await j('/api/session/me', {}, 'k2')).b.user === null);
check('old pw dead', (await j('/api/session/login', P({ id:cust.id, password:'Neu2026abc' }), 'k3')).s === 401);
ul = await j('/api/users', { method:'PUT', body: JSON.stringify({ customers:[Object.assign({}, ul.b.customers[0], { active:false })] }) }, 'adm');
check('deactivated hidden', (await j('/api/session/users')).b.customers.length === 0);
check('logout', (await j('/api/session/logout', P({}), 'adm')).s === 200 && (await j('/api/session/me', {}, 'adm')).b.user === null);
// Newsletter (lokal mit ORDER_WEBHOOK_URL und REMINDER_KEY)
if (process.env.REMINDER_KEY) {
  await j('/api/session/login', P({ id:ADM, password:'Harald2026x' }), 'adm');
  await j('/api/users', { method:'PUT', body: JSON.stringify({ customers:[{ firma:'A GmbH', email:'a@a.at', name:'Anna' }, { firma:'B KG', email:'b@b.at' }, { firma:'C OG', email:'c@c.at', newsletter:false }, { firma:'D eU', email:'' }] }) }, 'adm');
  const nlStart = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  const nc = { title:'Black Weeks', start: nlStart, count: 5, aid:'k-nl1', owners:'chef@beko.at', pool:{}, days:{}, ranges:[], newsletter:{ on:true, days:14, prices:true, subj:'Black Weeks – exklusiv', html:'<p>{{anrede}} Aktion <a href="{{abmelden}}">ab</a></p>', text:'{{anrede}} {{abmelden}}' } };
  check('nl cfg', (await j('/api/config', { method:'PUT', headers:{ authorization:'Bearer session' }, body: JSON.stringify(nc) }, 'adm')).s === 200);
  let ni = await j('/api/newsletter', {}, 'adm'); check('nl recipients', ni.b.recipients === 2, JSON.stringify(ni.b));
  let run = await j('/api/reminders/run', { method:'POST', headers:{ authorization:'Bearer ' + process.env.REMINDER_KEY } });
  check('nl auto', run.b.newsletters.some(x => x.aid === 'k-nl1' && x.sent === 2), JSON.stringify(run.b.newsletters));
  run = await j('/api/reminders/run', { method:'POST', headers:{ authorization:'Bearer ' + process.env.REMINDER_KEY } });
  check('nl once', !run.b.newsletters.some(x => x.aid === 'k-nl1'), JSON.stringify(run.b.newsletters));
  const tst = await j('/api/newsletter/send', P({ aid:'k-nl1', test:true }), 'adm'); check('nl test', tst.s === 200 && tst.b.to.includes('chef@beko.at'), JSON.stringify(tst.b));
  const users = (await j('/api/users', {}, 'adm')).b.customers; const a = users.find(x => x.firma === 'A GmbH');
  const fs = await import('fs'); const hook = fs.readFileSync('/tmp/hook.log', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(x => x && x.kind === 'newsletter');
  const ab = hook[0].recipients.find(r => r.email === 'a@a.at').abmelden; check('nl personal', /Guten Tag Anna/.test(hook[0].recipients.find(r => r.email === 'a@a.at').html));
  const ur = await fetch(ab.replace(/^https?:\/\/[^/]+/, B)); check('unsubscribe', ur.status === 200);
  ni = await j('/api/newsletter', {}, 'adm'); check('after unsub', ni.b.recipients === 1 && ni.b.log.length >= 2, JSON.stringify(ni.b));
  check('bad unsub', (await fetch(B + '/api/newsletter/abmelden?id=' + a.id + '&t=falsch')).status === 400);
}
// Einladungs-Mails
if (process.env.REMINDER_KEY) {
  await j('/api/session/login', P({ id:ADM, password:'Harald2026x' }), 'adm');
  let L = await j('/api/users', { method:'PUT', body: JSON.stringify({ customers:[{ firma:'Neu GmbH', email:'neu@neu.at', name:'Nina' }, { firma:'Ohne Mail KG', email:'' }] }) }, 'adm');
  const ids = L.b.customers.map(x => x.id);
  const iv = await j('/api/users', P({ action:'invite', ids }), 'adm');
  check('invite sent', iv.s === 200 && iv.b.result.sent === 1 && iv.b.result.skipped.length === 1 && iv.b.customers.find(x => x.firma === 'Neu GmbH').invitedAt, JSON.stringify(iv.b.result));
  const fs = await import('fs'); const inv = fs.readFileSync('/tmp/hook.log', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(x => x && x.kind === 'invite').pop();
  check('invite mail', inv && inv.to === 'neu@neu.at' && /einladung=/.test(inv.text) && /start2026/.test(inv.text) && /Guten Tag Nina/.test(inv.text), JSON.stringify(inv));
  const ivt = await j('/api/users', P({ action:'invite', ids:[ADM] }), 'adm'); check('no team invite', ivt.b.result.sent === 0 && /keine Einladung/.test(ivt.b.result.skipped[0].why), JSON.stringify(ivt.b.result));
  check('invite noauth', (await j('/api/users', P({ action:'invite', ids }))).s === 401);
}
console.log('OK', ok, 'FAIL', bad);
