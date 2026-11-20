// Nur gegen eine lokale Testumgebung ausführen (npm run dev) – der Test schreibt Testdaten in den Speicher!
const B = process.env.BASE || 'http://localhost:8788', PW = process.env.ADMIN_PASSWORD || 'test-Passwort-123';
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Vienna'}).format(new Date());
let ok = 0, bad = 0; const check = (n, c, extra) => { if (c) ok++; else { bad++; console.log('FAIL', n, extra ?? ''); } };
const j = async (p, o = {}) => { const r = await fetch(B + p, o); let b; try { b = await r.json(); } catch(e) { b = null; } return { s: r.status, b, h: r.headers }; };
const A = { authorization: 'Bearer ' + PW, 'content-type': 'application/json' };
check('auth wrong', (await j('/api/auth', { method:'POST', body: JSON.stringify({ password:'x' }) })).s === 401);
check('auth ok', (await j('/api/auth', { method:'POST', body: JSON.stringify({ password: PW }) })).s === 200);
const cfg = { title:'Test', theme:'black', start: today, count: 3, orderEmail:'order.austria@beko.com', pool:{ 'Beko|X1':{hek:200}, 'Beko|R1':{hek:80} },
  days: { [today]: { k:'Beko|X1', hek:200, price:100, qty:2 } }, ranges: [{ id:'r1', k:'Beko|R1', full:true, price:50, qty:5 }],
  extra: { 'Beko|R1': { b:'Beko', c:'Kühlen', m:'R1', t:'Testgerät' } },
  approval: { people: { pm: { 'Kühlen': [{ pid:'p1', name:'PM Kühlen', email:'a@b.at', token:'tok-123456789' }] }, finance: [], marketing: [], sd: [] } } };
check('put no auth', (await j('/api/config', { method:'PUT', body: JSON.stringify(cfg) })).s === 401);
check('put ok', (await j('/api/config', { method:'PUT', headers:A, body: JSON.stringify(cfg) })).s === 200);
let g = await j('/api/config'); check('public strip', g.b.config.approval.people.pm['Kühlen'][0].token === undefined, JSON.stringify(g.b.config.approval));
g = await j('/api/config', { headers: A }); check('admin token', g.b.config.approval.people.pm['Kühlen'][0].token === 'tok-123456789');
const c2 = JSON.parse(JSON.stringify(cfg)); delete c2.approval.people.pm['Kühlen'][0].token; c2.title = 'Test 2';
await j('/api/config', { method:'PUT', headers:A, body: JSON.stringify(c2) });
g = await j('/api/config', { headers: A }); check('token kept', g.b.config.approval.people.pm['Kühlen'][0].token === 'tok-123456789' && g.b.config.title === 'Test 2');
check('whoami bad', (await j('/api/whoami', { method:'POST', body: JSON.stringify({ token:'nope' }) })).s === 404);
const w = await j('/api/whoami', { method:'POST', body: JSON.stringify({ token:'tok-123456789' }) }); check('whoami', w.b && w.b.pid === 'p1');
check('approve wrong stage', (await j('/api/approve', { method:'POST', body: JSON.stringify({ token:'tok-123456789', key:'finance', status:'ok', hash:'h' }) })).s === 403);
check('reject no note', (await j('/api/approve', { method:'POST', body: JSON.stringify({ token:'tok-123456789', key:'pm:Kühlen', status:'rejected', hash:'h' }) })).s === 400);
check('approve', (await j('/api/approve', { method:'POST', body: JSON.stringify({ token:'tok-123456789', key:'pm:Kühlen', status:'ok', hash:'h1' }) })).s === 200);
const ap = await j('/api/approvals'); check('approvals', ap.b.byPid.p1.entries['pm:Kühlen'].status === 'ok');
const cu = { firma:'Elektro Muster', name:'Max', email:'max@muster.at', tel:'+43 1 234' };
let o = await j('/api/order', { method:'POST', body: JSON.stringify({ items:[{ day: today, k:'Beko|X1', qty:1 }, { day:'r-r1', k:'Beko|R1', qty:2 }], customer: cu }) });
check('order', o.s === 200 && o.b.order.total === 200 && o.b.sold[today] === 1 && o.b.sold['r-r1'] === 2, JSON.stringify(o.b));
check('order items', o.b.order.items[1].model === 'R1' && o.b.order.items[1].aktion.startsWith('Zeitraum'), JSON.stringify(o.b.order.items));
o = await j('/api/order', { method:'POST', body: JSON.stringify({ items:[{ day: today, k:'Beko|X1', qty:5 }], customer: cu }) });
check('stock limit', o.s === 409 && /Nur mehr 1/.test(o.b.error), JSON.stringify(o.b));
o = await j('/api/order', { method:'POST', body: JSON.stringify({ items:[{ day: today, k:'Beko|WRONG', qty:1 }], customer: cu }) });
check('wrong product', o.s === 409);
o = await j('/api/order', { method:'POST', body: JSON.stringify({ items:[{ day: today, k:'Beko|X1', qty:1 }], customer: { firma:'x' } }) });
check('missing fields', o.s === 400);
check('orders noauth', (await j('/api/orders')).s === 401);
const ol = await j('/api/orders', { headers:A }); check('orders', ol.b.orders.length === 1 && ['none', 'sent'].includes(ol.b.orders[0].mail));
const pdf = new TextEncoder().encode('%PDF-1.4 test');
const f = await j('/api/file', { method:'POST', headers:{ authorization:'Bearer ' + PW, 'content-type':'application/pdf', 'x-file-name': encodeURIComponent('Datenblatt Ä.pdf') }, body: pdf });
check('file up', f.s === 200 && f.b.id);
const fr = await fetch(B + '/api/file/' + f.b.id); check('file get', fr.status === 200 && fr.headers.get('content-type') === 'application/pdf' && (await fr.text()).startsWith('%PDF'));
check('file not pdf', (await j('/api/file', { method:'POST', headers:{ authorization:'Bearer ' + PW }, body: 'hello' })).s === 400);
const ak = { id:'a1', kind:'vorlage', name:'Black Weeks', at: new Date().toISOString(), config: cfg };
check('ak put', (await j('/api/aktionen?kind=aktionen&id=a1', { method:'PUT', headers:A, body: JSON.stringify(ak) })).b.meta.deals === 2);
check('ak list', (await j('/api/aktionen?kind=aktionen', { headers:A })).b.items.length === 1);
check('ak get', (await j('/api/aktionen?kind=aktionen&id=a1', { headers:A })).b.item.name === 'Black Weeks');
check('ak noauth', (await j('/api/aktionen?kind=aktionen')).s === 401);
for (let i = 0; i < 32; i++) await j('/api/aktionen?kind=versionen&id=v' + i, { method:'PUT', headers:A, body: JSON.stringify({ id:'v'+i, kind:'version', at: new Date(Date.now() + i*1000).toISOString(), config: cfg }) });
const vl = (await j('/api/aktionen?kind=versionen', { headers:A })).b.items; check('versions capped', vl.length === 30 && vl[0].id === 'v31', vl.length);
check('ak del', (await j('/api/aktionen?kind=aktionen&id=a1', { method:'DELETE', headers:A })).s === 200 && (await j('/api/aktionen?kind=aktionen', { headers:A })).b.items.length === 0);
const big = JSON.stringify(Object.assign({}, cfg, { pad: 'x'.repeat(2.2e6) }));
check('too big', (await j('/api/config', { method:'PUT', headers:A, body: big })).s === 413);
check('session off', (await j('/api/session/me')).s === 404);
check('unknown', (await j('/api/nix')).s === 404);
// Bundle + Vorlauf/Checkliste
const cb = JSON.parse(JSON.stringify(cfg)); cb.extra['Beko|Set A'] = { b:'Beko', c:'Backöfen', m:'Set A', t:'Bundle: X1 + R1', u:999, bundle:['Beko|X1','Beko|R1'] };
cb.days[today] = { k:'Beko|Set A', price:777, qty:3 }; cb.lead = 45; cb.checklist = [{ id:'c1', text:'A', when:'before', days:60, done:true }, { id:'c2', text:'B', when:'before', days:50, done:false }, { id:'c3', text:'C', when:'after', days:7, done:false }];
check('put bundle cfg', (await j('/api/config', { method:'PUT', headers:A, body: JSON.stringify(cb) })).s === 200);
o = await j('/api/order', { method:'POST', body: JSON.stringify({ items:[{ day: today, k:'Beko|Set A', qty:2 }], customer: cu }) });
check('bundle order', o.s === 200 && o.b.order.items[0].model === 'Set A' && /^Bundle/.test(o.b.order.items[0].type) && o.b.order.total === 1554, JSON.stringify(o.b));
const mk = (await j('/api/aktionen?kind=aktionen&id=p1', { method:'PUT', headers:A, body: JSON.stringify({ id:'p1', kind:'geplant', name:'Plan', at:new Date().toISOString(), config: cb }) })).b.meta;
check('meta lead/cl', mk.lead === 45 && mk.cl[0] === 1 && mk.cl[1] === 3 && mk.cl[2] === 1, JSON.stringify(mk));
const mk2 = (await j('/api/aktionen?kind=aktionen&id=p2', { method:'PUT', headers:A, body: JSON.stringify({ id:'p2', kind:'geplant', name:'Plan2', at:new Date().toISOString(), config: cfg }) })).b.meta;
check('meta default cl', mk2.lead === 30 && mk2.cl[1] === 13, JSON.stringify(mk2));
// Reminder (lokal mit ORDER_WEBHOOK_URL/REMINDER_KEY testen)
if (process.env.REMINDER_KEY) {
  const start = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const rc = { title:'Frühling', start, count: 10, lead: 30, owners:'pm@beko.at, sales@beko.at', aid:'k-test1', pool:{}, days:{}, ranges:[], checklist:[{ id:'c1', text:'Sortiment festlegen', when:'before', days:25, who:'Sales', done:false }] };
  check('put rem cfg', (await j('/api/config', { method:'PUT', headers:A, body: JSON.stringify(rc) })).s === 200);
  check('run noauth', (await j('/api/reminders/run', { method:'POST' })).s === 401);
  let rr = await j('/api/reminders/run', { method:'POST', headers:{ authorization:'Bearer ' + process.env.REMINDER_KEY } });
  check('run sends lead', rr.s === 200 && rr.b.results.some(x => x.aid === 'k-test1' && x.type === 'lead' && x.ok && x.to.length === 3), JSON.stringify(rr.b));
  rr = await j('/api/reminders/run', { method:'POST', headers:{ authorization:'Bearer ' + process.env.REMINDER_KEY } });
  check('run dedupe', rr.b.results.filter(x => x.aid === 'k-test1').length === 0, JSON.stringify(rr.b));
  const ms = await j('/api/reminders/send', { method:'POST', headers:A, body: JSON.stringify({ aid:'k-test1' }) }); check('manual send', ms.s === 200 && ms.b.sent === true, JSON.stringify(ms.b));
  const lg = await j('/api/reminders', { headers:A }); check('rem log', lg.b.log.length >= 2 && lg.b.log[0].type === 'manual');
}
console.log('OK', ok, 'FAIL', bad);
