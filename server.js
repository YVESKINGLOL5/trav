'use strict';
/*
 * Travolium sync server
 * ---------------------
 * Serves trav2.html and a small JSON API so every device sees the same data.
 * No dependencies: only Node.js 18+ built-ins.
 *
 *   node server.js
 *
 * Environment variables (all optional):
 *   PORT             port to listen on (default 3000)
 *   DATA_FILE        where data is stored (default ./data/db.json)
 *   ADMIN_EMAIL      email of the first admin account (default admin@travolium.rw)
 *   ADMIN_PASSWORD   password of the first admin account (random if not set, printed once)
 *   TRUST_PROXY      set to 1 when running behind a reverse proxy / hosting platform
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const HTML_FILE = path.join(__dirname, 'trav2.html');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const WELCOME_BONUS = 7500;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_CHARS = 5.5 * 1024 * 1024;
const IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ storage */

let db;

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    db = null;
  }
  if (!db) {
    db = { meta: { rev: 1, nextId: 1 }, users: [], transactions: [], resets: [], messages: [], notifications: [], sessions: {} };
  }
  db.sessions = db.sessions || {};
  purgeExpiredSessions();
  seedAdmin();
  saveDb();
}

function saveDb() {
  db.meta.rev += 1;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

function nextId() {
  return db.meta.nextId++;
}

function seedAdmin() {
  if (db.users.some(u => u.role === 'admin')) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@travolium.rw').trim();
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');
  db.users.push({
    id: nextId(), fullName: 'System Admin', email, phone: '+250 780 000 000',
    passHash: hashPassword(password), screenshot: null, role: 'admin', is_approved: 1
  });
  console.log('\n  Admin account created');
  console.log('  Email:    ' + email);
  console.log('  Password: ' + (generated ? password + '   (generated, shown only once, change ADMIN_PASSWORD to choose your own)' : '(from ADMIN_PASSWORD)'));
  console.log('');
}

/* ----------------------------------------------------------------- security */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return 's1$' + salt.toString('hex') + '$' + hash.toString('hex');
}

const DUMMY_HASH = hashPassword('not-a-real-password');

function verifyPassword(pw, stored) {
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_TTL_MS };
  return token;
}

function purgeExpiredSessions() {
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].expires < now) delete db.sessions[k];
}

function dropSessionsOf(userId) {
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === userId) delete db.sessions[k];
}

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (b.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k); }, 60000).unref();

/* ------------------------------------------------------------------ helpers */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const pub = u => ({ id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, screenshot: u.screenshot, role: u.role, is_approved: u.is_approved });

const fmt = n => Number(n).toLocaleString('en-US');

function cleanStr(v, label, min, max) {
  if (typeof v !== 'string') throw new HttpError(400, label + ' is required.');
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, label + ' is required.');
  if (s.length > max) throw new HttpError(400, label + ' is too long.');
  return s;
}

function cleanAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e10) throw new HttpError(400, 'Enter valid amount.');
  return Math.round(n * 100) / 100;
}

function cleanImage(v) {
  if (typeof v !== 'string' || v.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(v)) {
    throw new HttpError(400, 'Please attach a valid image (PNG, JPG, GIF or WebP, under 4 MB).');
  }
  return v;
}

function cleanPassword(v) {
  if (typeof v !== 'string' || v.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
  if (v.length > 200) throw new HttpError(400, 'Password is too long.');
  return v;
}

const findUserByEmail = email => db.users.find(u => u.email.toLowerCase() === String(email).trim().toLowerCase());
const findUserById = id => db.users.find(u => u.id === Number(id));

// Funds a user can still withdraw: approved deposits minus approved withdrawals
// minus withdrawals that are still waiting for approval (they are reserved).
function availableFor(userId) {
  let total = 0;
  for (const t of db.transactions) {
    if (t.userId !== userId) continue;
    if (t.type === 'deposit' && t.status === 'approved') total += t.amount;
    else if (t.type === 'withdraw' && (t.status === 'approved' || t.status === 'pending')) total -= t.amount;
  }
  return Math.max(0, Math.round(total * 100) / 100);
}

function notify(userId, text) {
  db.notifications.push({ id: nextId(), userId, text, ts: Date.now(), read: false });
}

function requireAdmin(ctx) {
  if (!ctx.user || ctx.user.role !== 'admin') throw new HttpError(403, 'Admin access required.');
}
function requireApprovedUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in.');
  if (ctx.user.role === 'admin') throw new HttpError(403, 'Not available for admin accounts.');
  if (ctx.user.is_approved !== 1) throw new HttpError(403, 'Your account has not been approved yet.');
}
function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
}

function stateFor(u) {
  if (u.role === 'admin') {
    return {
      rev: db.meta.rev, user: pub(u),
      users: db.users.map(pub),
      transactions: db.transactions,
      resets: db.resets.map(r => ({ id: r.id, email: r.email, status: r.status, ts: r.ts })),
      messages: db.messages,
      notifications: []
    };
  }
  return {
    rev: db.meta.rev, user: pub(u), users: [pub(u)],
    transactions: db.transactions.filter(t => t.userId === u.id),
    resets: [],
    messages: db.messages.filter(m => m.userId === u.id),
    notifications: db.notifications.filter(n => n.userId === u.id)
  };
}

/* ---------------------------------------------------------------- API routes */

const routes = {};
const route = (method, p, handler) => { routes[method + ' ' + p] = handler; };

route('POST', '/api/register', ctx => {
  rateLimit('register:' + ctx.ip, 15, 60 * 60 * 1000);
  const fullName = cleanStr(ctx.body.fullName, 'Full name', 2, 80);
  const email = cleanStr(ctx.body.email, 'Email', 3, 120);
  const phone = cleanStr(ctx.body.phone, 'Phone number', 5, 30);
  const password = cleanPassword(ctx.body.password);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (fullName.toLowerCase() === 'system admin') throw new HttpError(400, 'Please choose a different name.');
  if (findUserByEmail(email)) throw new HttpError(409, 'Email already exists.');
  const user = { id: nextId(), fullName, email, phone, passHash: hashPassword(password), screenshot: null, role: 'user', is_approved: 0 };
  db.users.push(user);
  const token = createSession(user.id);
  saveDb();
  return { token, user: pub(user) };
});

route('POST', '/api/login', ctx => {
  const email = typeof ctx.body.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  rateLimit('login:' + ctx.ip + ':' + email, 8, 15 * 60 * 1000);
  const user = findUserByEmail(email);
  const ok = verifyPassword(password, user ? user.passHash : DUMMY_HASH) && !!user;
  if (!ok) throw new HttpError(401, 'Invalid credentials.');
  const token = createSession(user.id);
  saveDb();
  return { token, user: pub(user) };
});

route('POST', '/api/logout', ctx => {
  if (ctx.tokenHash && db.sessions[ctx.tokenHash]) { delete db.sessions[ctx.tokenHash]; saveDb(); }
  return { ok: true };
});

route('GET', '/api/me', ctx => { requireAuth(ctx); return { user: pub(ctx.user) }; });
route('GET', '/api/rev', ctx => { requireAuth(ctx); return { rev: db.meta.rev }; });
route('GET', '/api/state', ctx => { requireAuth(ctx); return stateFor(ctx.user); });

route('POST', '/api/payment-proof', ctx => {
  requireAuth(ctx);
  if (ctx.user.role === 'admin') throw new HttpError(403, 'Not available for admin accounts.');
  ctx.user.screenshot = cleanImage(ctx.body.screenshot);
  saveDb();
  return { user: pub(ctx.user) };
});

route('POST', '/api/deposit', ctx => {
  requireApprovedUser(ctx);
  const amount = cleanAmount(ctx.body.amount);
  const method = cleanStr(ctx.body.method, 'Method', 1, 40);
  const screenshot = cleanImage(ctx.body.screenshot);
  db.transactions.push({ id: nextId(), userId: ctx.user.id, ts: Date.now(), amount, type: 'deposit', method, screenshot, status: 'pending', isBonus: false });
  notify(ctx.user.id, `Deposit request of ${fmt(amount)} RWF submitted for admin approval.`);
  saveDb();
  return { ok: true };
});

route('POST', '/api/withdraw', ctx => {
  requireApprovedUser(ctx);
  let amount, method, isBonus = false;
  if (ctx.body.bonus === true) {
    const hasBonus = db.transactions.some(t => t.userId === ctx.user.id && t.isBonus && t.type === 'deposit' && t.status === 'approved');
    const alreadyRequested = db.transactions.some(t => t.userId === ctx.user.id && t.isBonus && t.type === 'withdraw' && t.status !== 'rejected');
    if (!hasBonus) throw new HttpError(400, 'No welcome bonus is available on this account.');
    if (alreadyRequested) throw new HttpError(400, 'A welcome bonus withdrawal has already been requested.');
    amount = WELCOME_BONUS; method = 'Bonus Withdrawal'; isBonus = true;
  } else {
    amount = cleanAmount(ctx.body.amount); method = 'Payout';
  }
  const available = availableFor(ctx.user.id);
  if (amount > available) {
    throw new HttpError(400, available > 0
      ? `Insufficient balance. You can withdraw up to ${fmt(available)} RWF.`
      : 'Insufficient balance. You have no funds available to withdraw.');
  }
  db.transactions.push({ id: nextId(), userId: ctx.user.id, ts: Date.now(), amount, type: 'withdraw', method, screenshot: null, status: 'pending', isBonus });
  saveDb();
  return { ok: true };
});

route('POST', '/api/message', ctx => {
  requireApprovedUser(ctx);
  const text = cleanStr(ctx.body.text, 'Message', 1, 2000);
  db.messages.push({ id: nextId(), userId: ctx.user.id, sender: ctx.user.fullName, text, ts: Date.now() });
  saveDb();
  return { ok: true };
});

route('POST', '/api/notifications/read', ctx => {
  requireAuth(ctx);
  db.notifications.forEach(n => { if (n.userId === ctx.user.id) n.read = true; });
  saveDb();
  return { ok: true };
});

route('POST', '/api/reset-request', ctx => {
  rateLimit('reset:' + ctx.ip, 10, 60 * 60 * 1000);
  const email = cleanStr(ctx.body.email, 'Email', 3, 120);
  const newPassword = cleanPassword(ctx.body.newPassword);
  const user = findUserByEmail(email);
  if (!user) throw new HttpError(404, 'User email not found.');
  if (user.role === 'admin') throw new HttpError(403, 'Admin passwords cannot be reset this way.');
  db.resets = db.resets.filter(r => r.email.toLowerCase() !== user.email.toLowerCase());
  db.resets.push({ id: nextId(), email: user.email, newPassHash: hashPassword(newPassword), status: 'pending', ts: Date.now() });
  saveDb();
  return { ok: true };
});

/* ------------------------------------------------------------- admin routes */

route('POST', '/api/admin/user-approval', ctx => {
  requireAdmin(ctx);
  const user = findUserById(ctx.body.userId);
  const status = ctx.body.status === 1 ? 1 : 0;
  if (!user || user.role === 'admin') throw new HttpError(404, 'User not found.');
  user.is_approved = status;
  if (status === 1) {
    if (!db.transactions.some(t => t.userId === user.id && t.isBonus && t.type === 'deposit')) {
      db.transactions.push({ id: nextId(), userId: user.id, ts: Date.now(), amount: WELCOME_BONUS, type: 'deposit', method: 'System Bonus', screenshot: null, status: 'approved', isBonus: true });
    }
    notify(user.id, 'Your account has been approved by admin! Welcome bonus credited.');
  }
  saveDb();
  return { ok: true };
});

route('POST', '/api/admin/delete-user', ctx => {
  requireAdmin(ctx);
  const user = findUserById(ctx.body.userId);
  if (!user || user.role === 'admin') throw new HttpError(404, 'User not found.');
  db.users = db.users.filter(u => u.id !== user.id);
  db.transactions = db.transactions.filter(t => t.userId !== user.id);
  db.messages = db.messages.filter(m => m.userId !== user.id);
  db.notifications = db.notifications.filter(n => n.userId !== user.id);
  db.resets = db.resets.filter(r => r.email.toLowerCase() !== user.email.toLowerCase());
  dropSessionsOf(user.id);
  saveDb();
  return { ok: true };
});

route('POST', '/api/admin/deposit-status', ctx => {
  requireAdmin(ctx);
  const tx = db.transactions.find(t => t.id === Number(ctx.body.txId) && t.type === 'deposit' && !t.isBonus);
  if (!tx) throw new HttpError(404, 'Deposit not found.');
  if (!['approved', 'rejected'].includes(ctx.body.status)) throw new HttpError(400, 'Invalid status.');
  tx.status = ctx.body.status;
  notify(tx.userId, tx.status === 'approved'
    ? `Your deposit of ${fmt(tx.amount)} RWF has been approved and credited!`
    : `Your deposit of ${fmt(tx.amount)} RWF was rejected by admin.`);
  saveDb();
  return { ok: true };
});

route('POST', '/api/admin/withdraw-status', ctx => {
  requireAdmin(ctx);
  const tx = db.transactions.find(t => t.id === Number(ctx.body.txId) && t.type === 'withdraw');
  if (!tx) throw new HttpError(404, 'Withdrawal not found.');
  if (!['approved', 'rejected'].includes(ctx.body.status)) throw new HttpError(400, 'Invalid status.');
  tx.status = ctx.body.status;
  notify(tx.userId, `Your withdrawal request of ${fmt(tx.amount)} RWF was ${tx.status}.`);
  saveDb();
  return { ok: true };
});

route('POST', '/api/admin/reset-status', ctx => {
  requireAdmin(ctx);
  const req = db.resets.find(r => r.id === Number(ctx.body.requestId));
  if (!req) throw new HttpError(404, 'Request not found.');
  if (!['approved', 'rejected'].includes(ctx.body.status)) throw new HttpError(400, 'Invalid status.');
  req.status = ctx.body.status;
  if (req.status === 'approved') {
    const user = findUserByEmail(req.email);
    if (user && user.role !== 'admin') {
      user.passHash = req.newPassHash;
      dropSessionsOf(user.id);
      notify(user.id, 'Your password reset request has been approved.');
    }
  }
  saveDb();
  return { ok: true };
});

route('POST', '/api/admin/message', ctx => {
  requireAdmin(ctx);
  const user = findUserById(ctx.body.userId);
  if (!user || user.role === 'admin') throw new HttpError(404, 'User not found.');
  const text = cleanStr(ctx.body.text, 'Message', 1, 2000);
  db.messages.push({ id: nextId(), userId: user.id, sender: 'System Admin', text, ts: Date.now() });
  notify(user.id, 'You have a new support reply from Admin.');
  saveDb();
  return { ok: true };
});

/* ------------------------------------------------------------- HTTP plumbing */

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) { reject(new HttpError(400, 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function serveHtml(req, res) {
  fs.readFile(HTML_FILE, (err, data) => {
    if (err) { res.writeHead(500); res.end('trav2.html not found next to server.js'); return; }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      zlib.gzip(data, (e, gz) => {
        if (e) { res.writeHead(200, headers); res.end(data); return; }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
        res.end(gz);
      });
    } else {
      res.writeHead(200, headers); res.end(data);
    }
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trav2.html')) return serveHtml(req, res);
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });

    const handler = routes[req.method + ' ' + url.pathname];
    if (!handler) return sendJson(res, 404, { error: 'Not found.' });

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const tokenHash = token ? sha256(token) : null;
    let user = null;
    if (tokenHash) {
      const session = db.sessions[tokenHash];
      if (session && session.expires > Date.now()) user = findUserById(session.userId) || null;
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = handler({ req, res, body, user, tokenHash, ip: clientIp(req) });
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server. Please try again.' });
  }
});

loadDb();
server.listen(PORT, () => console.log(`Travolium is running at http://localhost:${PORT}`));

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
