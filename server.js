'use strict';
// Dependency-free backend (Node 18+). Serves the app, user accounts, the admin panel and USDT (TRC20) deposit checks.
// Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), util = require('util');
const scrypt = util.promisify(crypto.scrypt);

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const INDEX = path.join(__dirname, 'public', 'index.html');
const DEMO_ANY_RECIPIENT = process.env.ALLOW_ANY_RECIPIENT === '1'; // demo only: accept USDT sent to any address
const USDT_HEX = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'; // USDT contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
const TRANSFER = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const r2 = n => Math.round(n * 100) / 100;

/* ---------- storage ---------- */
let db = { admin: null, key: '', addr: '', claimed: {}, users: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch {}
function persist() {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA);
}
let pending = null;
const persistSoon = () => { if (!pending) pending = setTimeout(() => { pending = null; persist(); }, 1000); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { persist(); } catch {} process.exit(0); });
// "Forgot passcode?": needs a key only the server operator can see (printed at startup, or set ADMIN_RESET_KEY).
const RESET_KEY = process.env.ADMIN_RESET_KEY || crypto.randomBytes(8).toString('hex');
const apiKey = () => db.key || process.env.TRONGRID_API_KEY || '';

/* ---------- auth ---------- */
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const newSalt = () => crypto.randomBytes(16).toString('hex');
const sessions = new Map(); // token -> { exp, role: 'admin'|'user', user }
function newSession(role, user) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { exp: Date.now() + (role === 'admin' ? 12 : 24 * 7) * 3600e3, role, user });
  return t;
}
function sess(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return { ...s, token: m[1] };
}
const needAdmin = req => { const s = sess(req); if (!s || s.role !== 'admin') throw err(401, 'Please log in again.'); return s; };
const needUser = req => {
  const s = sess(req);
  if (!s || s.role !== 'user' || !Object.hasOwn(db.users, s.user)) throw err(401, 'Please sign in again.');
  return db.users[s.user];
};
const dropSessions = (pred) => { for (const [t, s] of sessions) if (pred(s)) sessions.delete(t); };
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  return ++h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
  for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
}, 600e3).unref();
// Behind Netlify / a tunnel set TRUST_PROXY=1 so rate limits see the real visitor, not the proxy.
const clientIp = req => process.env.TRUST_PROXY
  ? (req.headers['x-nf-client-connection-ip'] || req.headers['cf-connecting-ip'] ||
     (req.headers['x-forwarded-for'] || '').split(',')[0]).toString().trim() || req.socket.remoteAddress
  : req.socket.remoteAddress;

/* ---------- users ---------- */
const uname = s => typeof s === 'string' ? s.trim().toLowerCase() : '';
const validName = n => /^[a-z0-9_]{3,20}$/.test(n) && !(n in Object.prototype);
const validPw = p => typeof p === 'string' && p.length >= 8 && p.length <= 72;
const pub = u => ({ username: u.name, dep: u.dep, deps: u.deps, pnl: u.pnl, trades: u.trades });
async function createUser(name, pw) {
  if (!validName(name)) throw err(400, 'Username: 3–20 letters, numbers or underscores.');
  if (!validPw(pw)) throw err(400, 'Password must be 8–72 characters.');
  if (Object.hasOwn(db.users, name)) throw err(409, 'That username is taken.');
  const salt = newSalt(), h = await hashPw(pw, salt);
  if (Object.hasOwn(db.users, name)) throw err(409, 'That username is taken.'); // re-check after await
  db.users[name] = { name, salt, h, created: Date.now(), dep: 0, deps: [], pnl: 0, pnlAt: Date.now(), budget: 3, trades: [] };
  persist();
  return db.users[name];
}
const userList = () => Object.values(db.users)
  .map(u => ({ username: u.name, created: u.created, dep: u.dep, pnl: u.pnl, trades: u.trades.length }))
  .sort((a, b) => b.created - a.created);

/* ---------- tron helpers ---------- */
function b58dec(a) {
  let n = 0n;
  for (const c of a) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  return Buffer.from(n.toString(16).padStart(50, '0'), 'hex');
}
function validTron(a) {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return false;
  const b = b58dec(a);
  if (!b || b.length !== 25 || b[0] !== 0x41) return false;
  const sha = x => crypto.createHash('sha256').update(x).digest();
  return sha(sha(b.subarray(0, 21))).subarray(0, 4).equals(b.subarray(21));
}
const addrHex = a => b58dec(a).subarray(1, 21).toString('hex');
function b58enc(buf) {
  let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
function tronAddr(h20) { // 20-byte hex -> T... address
  const sha = x => crypto.createHash('sha256').update(x).digest();
  const p = Buffer.concat([Buffer.from([0x41]), Buffer.from(h20, 'hex')]);
  return b58enc(Buffer.concat([p, sha(sha(p)).subarray(0, 4)]));
}
const norm = x => String(x || '').replace(/^0x/i, '').toLowerCase();

async function tg(p, value) {
  const k = apiKey();
  const r = await fetch('https://api.trongrid.io/' + p, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', accept: 'application/json', ...(k ? { 'TRON-PRO-API-KEY': k } : {}) },
    body: JSON.stringify({ value })
  });
  if (!r.ok) throw new Error('TronGrid HTTP ' + r.status);
  return r.json();
}
async function testKey(k) {
  try {
    const r = await fetch('https://api.trongrid.io/wallet/getnowblock', {
      method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'TRON-PRO-API-KEY': k, accept: 'application/json' }
    });
    return r.ok;
  } catch { return null; }
}
// USDT (TRC20) only. Counts transfers of the official USDT contract to the deposit address.
async function checkTron(h) {
  const i = await tg('wallet/gettransactioninfobyid', h);
  if (!i || !i.id) {
    const t = await tg('wallet/gettransactionbyid', h);
    return { state: t && t.txID ? 'pending' : 'notfound' };
  }
  const want = db.addr ? addrHex(db.addr) : '';
  let amt = 0, other = null; // other = biggest USDT transfer that went to a different address
  for (const l of i.log || []) {
    const la = norm(l.address).replace(/^41(?=[0-9a-f]{40}$)/, '');
    const tp = (l.topics || []).map(norm);
    if (la !== USDT_HEX || tp.length < 3 || tp[0] !== TRANSFER) continue; // USDT transfers only
    const to = tp[2].slice(24), val = Number(BigInt('0x' + (norm(l.data) || '0'))) / 1e6;
    if (want && to !== want) { if (!other || val > other.amt) other = { to: tronAddr(to), amt: Math.round(val * 1e6) / 1e6 }; continue; }
    amt += val;
  }
  const bad = i.result === 'FAILED' || (i.receipt && i.receipt.result && i.receipt.result !== 'SUCCESS');
  if (bad) return { state: 'failed' };
  const fin = await tg('walletsolidity/gettransactioninfobyid', h); // confirmed (solidified) only
  return { state: fin && fin.id ? 'success' : 'pending', amt: Math.round(amt * 1e6) / 1e6, other };
}
const inflight = new Set();

/* ---------- live market prices (CoinGecko, Binance public data as fallback) ---------- */
const COINS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', TRX: 'tron' };
let priceCache = { at: 0, data: null }, priceBusy = null;
async function pullPrices() {
  const out = {}, want = Object.keys(COINS);
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_24hr_change=true&ids=' + Object.values(COINS).join(','),
      { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (r.ok) { const j = await r.json(); for (const [k, id] of Object.entries(COINS)) if (j[id] && j[id].usd > 0) out[k] = { p: j[id].usd, c: Number(j[id].usd_24h_change) || 0 }; }
  } catch {}
  if (want.some(k => !out[k])) {
    try {
      const syms = want.filter(k => !out[k]).map(k => k + 'USDT');
      const r = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(syms)),
        { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (r.ok) for (const x of await r.json()) { const k = String(x.symbol).replace(/USDT$/, ''); if (COINS[k] && +x.lastPrice > 0) out[k] = { p: +x.lastPrice, c: Number(x.priceChangePercent) || 0 }; }
    } catch {}
  }
  if (!Object.keys(out).length) throw new Error('no price source reachable');
  return out;
}
async function getPrices() {
  if (priceCache.data && Date.now() - priceCache.at < 15000) return priceCache;
  if (!priceBusy) priceBusy = pullPrices().then(d => { priceCache = { at: Date.now(), data: { ...(priceCache.data || {}), ...d } }; }).finally(() => { priceBusy = null; });
  try { await priceBusy; } catch (e) { if (!priceCache.data) throw err(502, 'Live prices are unavailable right now.'); } // stale-if-error
  return priceCache;
}

/* ---------- http ---------- */
function err(status, message) { return Object.assign(new Error(message), { status }); }
const readBody = req => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 100000) { no(err(413, 'Request too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(err(400, 'Bad JSON')); } });
  req.on('error', no);
});
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
const adminView = () => { const k = apiKey(); return { addr: db.addr, hasKey: !!k, hint: k.slice(-4) }; };
const cleanTrades = a => (Array.isArray(a) ? a : []).slice(0, 200).map(t => ({
  p: String(t && t.p || '').slice(0, 12), side: String(t && t.side || '').slice(0, 6),
  t: String(t && t.t || '').slice(0, 16), pl: r2(Number(t && t.pl) || 0)
}));

const routes = {
  'GET /api/config': async () => ({ addr: db.addr, admin: !!db.admin }),
  'GET /api/prices': async (req) => {
    if (limited('prices:' + clientIp(req), 90, 60e3)) throw err(429, 'Too many requests.');
    const c = await getPrices();
    return { prices: c.data, at: c.at };
  },

  /* --- user accounts --- */
  'POST /api/auth/register': async (req, body) => {
    if (limited('reg:' + clientIp(req), 10, 900e3)) throw err(429, 'Too many attempts. Try again later.');
    const u = await createUser(uname(body.username), body.password);
    return { token: newSession('user', u.name), user: pub(u) };
  },
  'POST /api/auth/login': async (req, body) => {
    if (limited('login:' + clientIp(req), 20, 900e3)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
    const n = uname(body.username), pw = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const u = Object.hasOwn(db.users, n) ? db.users[n] : null;
    const h = await hashPw(pw, u ? u.salt : '0'.repeat(32)); // same work whether or not the user exists
    if (!u || !same(h, u.h)) throw err(401, 'Wrong username or password.');
    return { token: newSession('user', u.name), user: pub(u) };
  },
  'POST /api/auth/logout': async (req) => { const s = sess(req); if (s) sessions.delete(s.token); return { ok: true }; },
  'GET /api/me': async (req) => pub(needUser(req)),
  // Trading is a client-side simulation. The server only accepts P/L that is plausible for the elapsed time:
  // every 2.2s of real time earns one "tick" of budget (max 30 banked); a net gain spends ticks at the bot's max win size.
  'POST /api/me/state': async (req, body) => {
    const u = needUser(req);
    const pnl = r2(Number(body.pnl));
    if (!Number.isFinite(pnl)) throw err(400, 'Bad state.');
    const now = Date.now();
    const budget = Math.min((u.budget ?? 3) + Math.max(0, now - (u.pnlAt || now)) / 2200, 30);
    const perTick = 0.0009 * Math.max(u.dep + u.pnl, 0) + 0.01;
    const need = Math.max(0, pnl - u.pnl) / perTick;
    if (need > budget + 0.05 || pnl < -u.dep - 0.005) throw err(409, 'State out of sync.');
    u.budget = Math.max(0, budget - need); u.pnl = pnl; u.pnlAt = now; u.trades = cleanTrades(body.trades);
    persistSoon();
    return { ok: true };
  },

  /* --- deposits (signed-in users) --- */
  'POST /api/deposit/verify': async (req, body) => {
    const u = needUser(req);
    if (limited('verify:' + u.name, 20, 60e3)) throw err(429, 'Too many checks. Wait a minute.');
    if (!db.addr && !DEMO_ANY_RECIPIENT) throw err(503, 'Deposits are not open yet. The admin has not set a wallet address.');
    const h = typeof body.hash === 'string' ? body.hash.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(h)) throw err(400, 'That is not a valid Tron transaction hash.');
    if (db.claimed[h]) throw err(409, 'This transaction was already deposited.');
    if (inflight.has(h)) throw err(409, 'This transaction is already being checked.');
    inflight.add(h);
    try {
      let r;
      try { r = await checkTron(h); } catch (e) { console.error('tron check:', e.message); throw err(502, 'Could not reach TronGrid. Try again.'); }
      let credited = false;
      if (r.state === 'success' && r.amt > 0) {
        if (db.users[u.name] !== u) throw err(401, 'Please sign in again.'); // removed while checking
        const at = Date.now();
        db.claimed[h] = { amt: r.amt, at, user: u.name };
        u.dep = r2(u.dep + r.amt);
        u.deps.unshift({ h, amt: r.amt, at }); u.deps = u.deps.slice(0, 100);
        persist(); credited = true;
      }
      return { ...r, credited, dep: u.dep, deps: u.deps };
    } finally { inflight.delete(h); }
  },

  /* --- admin --- */
  'POST /api/admin/setup': async (req, body) => {
    if (db.admin) throw err(409, 'Admin is already set up.');
    if (limited('setup:' + clientIp(req), 10, 900e3)) throw err(429, 'Too many attempts. Try later.');
    if (typeof body.passcode !== 'string' || body.passcode.length < 6) throw err(400, 'Use at least 6 characters.');
    const salt = newSalt(), h = await hashPw(body.passcode, salt);
    if (db.admin) throw err(409, 'Admin is already set up.');
    db.admin = { salt, h }; persist();
    return { token: newSession('admin') };
  },
  'POST /api/admin/login': async (req, body) => {
    if (limited('alogin:' + clientIp(req), 10, 900e3)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
    if (!db.admin) throw err(409, 'Admin is not set up yet.');
    const h = await hashPw(typeof body.passcode === 'string' ? body.passcode.slice(0, 200) : '', db.admin.salt);
    if (!same(h, db.admin.h)) throw err(401, 'Wrong passcode.');
    return { token: newSession('admin') };
  },
  'POST /api/admin/logout': async (req) => { const s = sess(req); if (s && s.role === 'admin') sessions.delete(s.token); return { ok: true }; },
  'POST /api/admin/reset': async (req, body) => {
    if (limited('areset:' + clientIp(req), 5, 900e3)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
    if (!db.admin) throw err(409, 'Admin is not set up yet.');
    const k = typeof body.key === 'string' ? body.key.trim() : '';
    if (!k || !same(k, RESET_KEY)) throw err(401, 'Wrong reset key. Check the server console.');
    if (typeof body.passcode !== 'string' || body.passcode.length < 6) throw err(400, 'Use at least 6 characters.');
    const salt = newSalt();
    db.admin = { salt, h: await hashPw(body.passcode, salt) }; persist();   // only the passcode changes
    dropSessions(x => x.role === 'admin');
    return { token: newSession('admin') };
  },
  'GET /api/admin/config': async (req) => { needAdmin(req); return adminView(); },
  'POST /api/admin/config': async (req, body) => {
    needAdmin(req);
    let keyOk;
    if ('addr' in body) {
      const a = typeof body.addr === 'string' ? body.addr.trim() : '';
      if (a && !validTron(a)) throw err(400, 'That is not a valid Tron address. Check for typos.');
      db.addr = a;
    }
    if ('key' in body) {
      const k = typeof body.key === 'string' ? body.key.trim() : '';
      if (k.length > 200) throw err(400, 'Key is too long.');
      db.key = k;
      if (k) keyOk = await testKey(k);
    }
    persist();
    return { ...adminView(), keyOk };
  },
  'POST /api/admin/passcode': async (req, body) => {
    const s = needAdmin(req);
    if (typeof body.passcode !== 'string' || body.passcode.length < 6) throw err(400, 'Use at least 6 characters.');
    const salt = newSalt();
    db.admin = { salt, h: await hashPw(body.passcode, salt) }; persist();
    dropSessions(x => x.role === 'admin' && x !== sessions.get(s.token));
    return { ok: true };
  },
  'GET /api/admin/users': async (req) => { needAdmin(req); return { users: userList() }; },
  'POST /api/admin/users': async (req, body) => {
    needAdmin(req);
    await createUser(uname(body.username), body.password);
    return { users: userList() };
  },
  'POST /api/admin/users/delete': async (req, body) => {
    needAdmin(req);
    const n = uname(body.username);
    if (!Object.hasOwn(db.users, n)) throw err(404, 'User not found.');
    delete db.users[n];
    dropSessions(s => s.role === 'user' && s.user === n);
    persist();
    return { users: userList() };
  }
};

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html'))
      return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html');
    const route = routes[req.method + ' ' + pathname];
    if (!route) return send(res, 404, { error: 'Not found' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await route(req, body));
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}).listen(PORT, HOST, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(process.env.ADMIN_RESET_KEY ? 'Admin reset key: (from ADMIN_RESET_KEY)' : `Admin reset key: ${RESET_KEY}   (use it under "Forgot passcode?" on the #admin screen)`);
});
