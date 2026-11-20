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
check('admin wrong', (await j('/api/session/login', P({ id:ADM, password:'start2026' }), 'adm')).s === 401);
let r = await j('/api/session/login', P({ id:ADM, password:PW }), 'adm'); check('admin boot', r.s === 200 && r.b.mustChange && r.b.ticket, JSON.stringify(r.b));
check('weak pw', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'kurz' }), 'adm')).s === 400);
check('initial pw not allowed', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'start2026' }), 'adm')).s === 400);
check('set pw', (await j('/api/session/change', P({ ticket:r.b.ticket, password:'Harald2026x' }), 'adm')).s === 200);
let me = await j('/api/session/me', {}, 'adm'); check('me admin', me.b.user && me.b.user.role === 'admin', JSON.stringify(me.b));
check('admin put config (session)', (await j('/api/config', { method:'PUT', headers:{ authorization:'Bearer session' }, body: JSON.stringify({ title:'BW', start: today, count:2, pool:{}, days:{ [today]:{ k:'Beko|X1', price:10, qty:3 } } }) }, 'adm')).s === 200);
let ul = await j('/api/users', {}, 'adm'); check('users get', ul.s === 200 && ul.b.initial === 'start2026' && ul.b.me === ADM);
ul = await j('/api/users', { method:'PUT', body: JSON.stringify({ customers:[{ firma:'Elektro Muster', ort:'Linz', kdnr:'100234', name:'Max', email:'max@muster.at', tel:'+43 732 1' }] }) }, 'adm');
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
console.log('OK', ok, 'FAIL', bad);
