// Local-only live viewer for events.jsonl (written by hook.js).
// Serves index.html, the recent events, and a Server-Sent Events stream of new lines. No network calls, no packages.
// Usage: node server.js [port] [events file]   (default 7788 and ~/.claude/agent-monitor/events.jsonl)
//        node server.js --stop [port]          (stops a running monitor)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// The data endpoints need a key that only the printed link carries, so other programs and users on this computer
// can't read your events by calling the port. Kept in an owner-only file so the link survives restarts.
const KEY_FILE = path.join(os.homedir(), '.claude', 'agent-monitor', 'server-key');
function getKey() {
  try { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (/^[a-f0-9]{32,}$/.test(k)) return k; } catch {}
  const k = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, k + '\n', { mode: 0o600 });
  return k;
}
const KEY = getKey();
const KEY_ID = crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 16);   // /health shows this, never the key
const keyOk = (k) => typeof k === 'string' && k.length === KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(KEY));

if (process.argv[2] === '--stop') {
  const port = +(process.argv[3] || process.env.AGENT_MONITOR_PORT || 7788);
  const req = http.request({ host: '127.0.0.1', port, path: '/api/stop', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'x-agent-monitor': 'stop' } }, (r) => {
    const ok = r.statusCode === 200;
    console.log(ok ? `Agent monitor on port ${port} stopped.` : `Port ${port} answered, but not as a monitor that can be stopped (HTTP ${r.statusCode}). An older monitor stops with Ctrl+C in its terminal, or when the session that started it closes.`);
    process.exit(ok ? 0 : 1);
  });
  req.on('error', () => { console.log(`No agent monitor running on port ${port}.`); process.exit(0); });
  req.end();
  return;   // CommonJS allows a top-level return: don't start a server
}

const PORT = +(process.argv[2] || process.env.AGENT_MONITOR_PORT || 7788);
const FILE = process.argv[3] || process.env.AGENT_MONITOR_FILE || path.join(os.homedir(), '.claude', 'agent-monitor', 'events.jsonl');
const IMPORTED = path.join(path.dirname(FILE), 'imported.jsonl');   // written once by import.js from old transcripts
const DAYS = +(process.env.AGENT_MONITOR_DAYS || 30);   // Claude Code keeps transcripts 30 days by default
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// ---- git folder and branch for a cwd, cached 30 s
const gitCache = new Map();
function gitInfo(cwd) {
  if (!cwd) return {};
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < 30000) return hit.info;
  let info = {};
  try {
    let dir = cwd;
    while (dir && !fs.existsSync(path.join(dir, '.git'))) { const up = path.dirname(dir); dir = up === dir ? null : up; }
    if (dir) {
      let gitdir = path.join(dir, '.git');
      if (fs.statSync(gitdir).isFile()) gitdir = path.resolve(dir, fs.readFileSync(gitdir, 'utf8').replace(/^gitdir:\s*/, '').trim());
      let common = gitdir;
      try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch {}
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
      const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
      let repo = path.basename(dir);
      try {
        const m = fs.readFileSync(path.join(common, 'config'), 'utf8').match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
        if (m) repo = m[1].replace(/\.git$/, '').split(/[/:]/).pop();
      } catch {}
      info = { repo, branch, root: dir, home: path.dirname(common) };   // home: the main checkout, also for worktrees
    }
  } catch {}
  gitCache.set(cwd, { at: Date.now(), info });
  return info;
}
// The folder a session belongs to in the sessions list: the repo's main checkout, else the folder itself.
function groupOf(cwd, git) {
  if (git.home) return path.basename(git.home);
  const wt = cwd.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/);
  return path.basename(wt ? wt[1] : cwd);
}
const enrich = (e) => {
  const { home, ...git } = gitInfo(e.cwd);
  for (const k in git) if (e[k] == null) e[k] = git[k];   // imported events keep the branch they ran on
  if (e.cwd) e.group = groupOf(e.cwd, { home });
  return e;
};

// ---- the desktop app's own session list: titles, your custom groups, archived flags (read-only, never written)
const DESKTOP_DIRS = [
  process.env.AGENT_MONITOR_DESKTOP_DIR,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Claude-3p'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Claude'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'Claude'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Claude'),
].filter(Boolean);
function desktopInfo() {
  const dir = DESKTOP_DIRS.find((d) => fs.existsSync(path.join(d, 'claude-code-sessions')));
  if (!dir) return { sessions: [] };
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(path.join(dir, 'claude_desktop_config.json'), 'utf8')).preferences.epitaxyPrefs || {}; } catch {}
  const groups = {}, assigned = {};
  for (const sc of Object.values(prefs['dframe-group-scopes'] || {})) {
    for (const g of sc.groups || []) groups[g.id] = { id: g.id, name: g.name, order: 0, sortBy: 'recency', ascending: false };
    Object.assign(assigned, sc.assignments || {});
  }
  for (const sc of Object.values(prefs['dframe-code-sections'] || {})) for (const s of sc.sections || []) {
    if (groups[s.id]) Object.assign(groups[s.id], { order: s.order, sortBy: s.sortBy, ascending: !!s.ascending });
  }
  const sessions = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/^local_.*\.json$/.test(f)) continue;
      try {
        const o = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!o.sessionId || !o.cliSessionId) continue;
        // only the fields the page needs; the record also holds settings we have no business copying
        const anchor = (o.gitAnchors || [])[0], home = anchor && anchor.commonDir ? path.dirname(anchor.commonDir) : (o.originCwd || o.cwd);
        sessions.push({
          id: o.sessionId, cliIds: [...new Set([o.cliSessionId, o.lastAssistantCliSessionId].filter(Boolean))],
          title: o.title || null, cwd: o.originCwd || o.cwd || null, project: home ? path.basename(home) : null,
          archived: !!o.isArchived, createdAt: o.createdAt || null, lastActivityAt: o.lastActivityAt || null, model: typeof o.model === 'string' ? o.model : null,
          group: groups[assigned['code:' + o.sessionId]] || null,
        });
      } catch {}
    }
  })(path.join(dir, 'claude-code-sessions'));
  return { sessions };
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}

function recentEvents() {
  const since = Date.now() - DAYS * 864e5, out = [];
  for (const f of [IMPORTED, FILE]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // shortcut: reads both files whole on each page load; fine for weeks of events, add rotation if they pass ~50 MB.
    for (const e of parseLines(text)) if (Date.parse(e.ts) >= since) out.push(enrich(e));
  }
  return out;
}

// ---- tail the file and fan new lines out to every open stream
const clients = new Set();
let importing = false;
let offset = 0, rest = '';
try { offset = fs.statSync(FILE).size; } catch {}
fs.watchFile(FILE, { interval: 400 }, (cur) => {
  try {   // the file can vanish or be locked between the stat and the read (log rollover, antivirus): skip this tick
    if (cur.size < offset) { offset = 0; rest = ''; }   // file was truncated or replaced (rolled over)
    if (cur.size === offset) return;
    const fd = fs.openSync(FILE, 'r');
    const buf = Buffer.alloc(cur.size - offset);
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = cur.size;
    const text = rest + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    rest = text.slice(cut + 1);
    for (const e of parseLines(text.slice(0, cut + 1))) {
      const msg = `data: ${JSON.stringify(enrich(e))}\n\n`;
      for (const res of clients) res.write(msg);
    }
  } catch {}
});

const LINK = `http://127.0.0.1:${PORT}/?k=${KEY}`;
// every answer: no sniffing, no referrer (the key is in the page's address); the page itself: no framing, scripts and requests only from here
const BASE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
const PAGE = { ...BASE, 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const JSON_H = { ...BASE, 'content-type': 'application/json' };

const server = http.createServer((req, res) => {
  // Only answer to localhost names: blocks DNS-rebinding pages from reading your events.
  if (!HOSTS.has(req.headers.host)) { res.writeHead(403, BASE).end('forbidden'); return; }
  const u = new URL(req.url, 'http://127.0.0.1'), url = u.pathname;
  // the data needs the key from the printed link; the page itself holds no data
  if (url.startsWith('/api/') && url !== '/api/stop' && !keyOk(u.searchParams.get('k'))) { res.writeHead(401, JSON_H).end('{"error":"key"}'); return; }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, PAGE);
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else if (url === '/api/events') {
    let body;
    try { body = JSON.stringify(recentEvents()); }   // a log too big for one string would throw: answer 500 instead of crashing
    catch (err) { res.writeHead(500, JSON_H).end(JSON.stringify({ error: `cannot read the logs: ${err.message}` })); return; }
    res.writeHead(200, JSON_H).end(body);
  } else if (url === '/api/desktop') {
    let info = { sessions: [] };
    try { info = desktopInfo(); } catch {}
    res.writeHead(200, JSON_H).end(JSON.stringify(info));
  } else if (url === '/api/stream') {
    res.writeHead(200, { ...BASE, 'content-type': 'text/event-stream', connection: 'keep-alive' });
    res.write(': hello\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (url === '/api/reimport') {
    // runs this plugin's own import.js, nothing from the request; POST plus a custom header so no other page can start it
    if (req.method !== 'POST' || req.headers['x-agent-monitor'] !== 'reimport') { res.writeHead(405, BASE).end('POST with the x-agent-monitor header'); return; }
    if (importing) { res.writeHead(409, BASE).end('An import is already running.'); return; }
    importing = true;
    execFile(process.execPath, [path.join(__dirname, 'import.js')], { timeout: 180000, windowsHide: true }, (err, out, errOut) => {
      importing = false;
      const last = (t) => String(t).trim().split('\n').pop();   // its summary line
      const why = String(errOut || '').split('\n').find((l) => /Error/.test(l)) || (err && err.message);   // node prints its version last
      if (err) res.writeHead(500, BASE).end(String(why).trim());
      else res.writeHead(200, BASE).end(last(out));
    });
  } else if (url === '/api/stop' && req.method === 'POST' && req.headers['x-agent-monitor'] === 'stop') {
    // The custom header forces a CORS preflight this server never answers, so no web page can stop it.
    res.writeHead(200, BASE).end('stopping');
    console.log('Agent monitor stopped.');
    setTimeout(() => process.exit(0), 100);
  } else if (url === '/health') {
    // a fingerprint of the key, so a second start can tell this monitor from another program on the port
    res.writeHead(200, JSON_H).end(JSON.stringify({ app: 'agent-monitor', id: KEY_ID }));
  } else res.writeHead(404, BASE).end('not found');
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Port taken: if it is our own monitor (same key), print its link; anything else is another program
  http.get({ host: '127.0.0.1', port: PORT, path: '/health', headers: { host: `127.0.0.1:${PORT}` } }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => {
      let id = null; try { id = JSON.parse(b).id; } catch {}
      if (id === KEY_ID) { console.log(`Agent monitor already running: ${LINK}`); process.exit(0); }
      console.error(`Port ${PORT} is used by another program${b.includes('agent-monitor') ? " (an older monitor, or another user's)" : ''}. Try: node server.js 7789`); process.exit(1);
    });
  }).on('error', () => { console.error(`Port ${PORT} is busy.`); process.exit(1); });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Agent monitor: ${LINK}  (reading ${FILE})`));
