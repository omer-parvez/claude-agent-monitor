// Session replay: turns one Claude Code session into a single HTML file that replays offline.
// The file shows every prompt, the main agent and the subagents and workflow agents it started, on a map and a timeline,
// with start and finish times and token counts.
//
// Reads only this project's own Claude Code transcripts (~/.claude/projects/<this project>/). Writes one HTML file.
// No network calls, no packages, nothing installed or changed.
//
// Usage (Node.js 18+):
//   node replay.js --list                    sessions of this project, newest first
//   node replay.js                           the newest session -> ./session-replay-<date>-<id>.html
//   node replay.js --session <id or prefix>  a given session
//   node replay.js --out <file.html>         where to write it
//   node replay.js --project <folder>        another project folder than the current one
//   node replay.js --self-test
const fs = require('fs');
const path = require('path');
const os = require('os');
const { convertSession } = require('./import.js');   // the agent monitor's own transcript reader
const { cut } = require('./hook.js');

const PAGE = path.join(__dirname, '..', 'assets', 'replay.html');

// Claude Code keeps a project's transcripts in ~/.claude/projects/<the folder path with every non-letter/digit as "-">
function transcriptDir(project) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const key = path.resolve(project).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const hit = fs.existsSync(root) && fs.readdirSync(root).find((d) => d.toLowerCase() === key);
  return hit ? path.join(root, hit) : null;
}

// a session's first prompt you typed, for listing and naming
function firstPrompt(file) {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 1048576));
  fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
  for (const line of buf.toString('utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' || o.isMeta || o.isSidechain) continue;
    const c = o.message && o.message.content, t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
    if (t.trim() && !/^\s*</.test(t) && !/^\[Request interrupted/.test(t)) return cut(t, 70);
  }
  return null;
}

function sessions(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
    const file = path.join(dir, f);
    return { id: f.replace(/\.jsonl$/, ''), file, mtime: fs.statSync(file).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

// the page with the events built in, the same way the agent monitor's Export button does it
function buildHtml(events, title, cwd) {
  const page = fs.readFileSync(PAGE, 'utf8');
  const sid = events[0].session, times = events.map((e) => Date.parse(e.ts));
  const model = (events.find((e) => e.model) || {}).model || null;
  const desk = { id: 'local_' + sid, cliIds: [sid], title, cwd, project: path.basename(cwd), archived: false,
    createdAt: Math.min(...times), lastActivityAt: Math.max(...times), model, group: null };
  const data = { ev: events, desk: { sessions: [desk] }, sel: desk.id, focus: null, at: Math.max(...times) + 60000, made: Date.now(),
    note: `Replay of "${title}". Press Play, click a prompt to see only the agents it set off, or switch to Timeline.` };
  // "<" escaped so no text in the data can close the script tag
  return page.replace('<script>', () => `<script>window.EXPORT = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>\n<script>`);
}

// A markdown summary of who did what: one row per main-agent turn and per subagent, with times, tool calls and tokens.
// Prompts that are slash commands or messages Claude Code adds itself (<task-notification> …) continue the turn before them.
const clock = (t) => new Date(t).toTimeString().slice(0, 8);
const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`; };
const kTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
function summarize(events, maxRows = 15) {
  const runs = [], open = {}, add = (r, k) => { if (r && k) { r.tin += (k.i || 0) + (k.cr || 0) + (k.cw || 0); r.tout += k.o || 0; } };
  let turn = null, n = 0, failed = 0;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (e.event === 'UserPromptSubmit') {
      if (/^\s*(<|\/)/.test(e.summary || '') && turn) { turn.end = null; continue; }
      if (turn && turn.end == null) turn.end = t;
      runs.push(turn = { name: `Main agent, prompt ${++n}`, start: t, end: null, calls: 0, tin: 0, tout: 0 });
    } else if (e.event === 'Stop' && turn) { turn.end = t; add(turn, e.tok); }   // live logs put a turn's tokens on its stop
    else if (e.event === 'SubagentStart') runs.push(open[e.agent] = { name: e.summary || e.agent_type || 'subagent', start: t, end: null, calls: 0, tin: 0, tout: 0 });
    else if (e.event === 'SubagentStop' && open[e.agent]) { open[e.agent].end = t; add(open[e.agent], e.tok); }
    else if (e.event === 'Tokens') add(e.agent === 'main' ? turn : open[e.agent], e.tok);
    else if (e.event === 'PreToolUse') { const r = e.agent === 'main' ? turn : open[e.agent]; if (r) r.calls++; }
    else if (e.event === 'PostToolUseFailure') failed++;
  }
  const last = Math.max(...events.map((e) => Date.parse(e.ts)));
  const sum = (k) => runs.reduce((a, r) => a + r[k], 0), subs = runs.filter((r) => !r.name.startsWith('Main agent'));
  const lines = [`**${n} prompts, ${subs.length} subagents, ${sum('calls')} tool calls (${failed} failed), ${kTok(sum('tin'))} tokens in, ${kTok(sum('tout'))} out.**`, '',
    '| Agent | Started | Finished | Took | Tool calls | Tokens in / out |', '|---|---|---|---|---|---|'];
  for (const r of runs.slice(0, maxRows)) {
    const end = r.end ?? last;
    lines.push(`| ${r.name.replace(/\|/g, '/')} | ${clock(r.start)} | ${r.end == null ? 'still running' : clock(end)} | ${took(end - r.start)} | ${r.calls} | ${r.end == null && !r.tin ? '– (counted when it stops)' : `${kTok(r.tin)} / ${kTok(r.tout)}`} |`);
  }
  if (runs.length > maxRows) lines.push('', `…and ${runs.length - maxRows} more in the replay.`);
  return lines.join('\n');
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const project = arg('--project') || process.cwd();
  const dir = transcriptDir(project);
  if (!dir) { console.error(`No Claude Code transcripts found for ${path.resolve(project)}.`); process.exit(1); }
  const list = sessions(dir);
  if (!list.length) { console.error(`No sessions in ${dir}.`); process.exit(1); }
  if (argv.includes('--list')) {
    for (const s of list.slice(0, 30)) console.log(`${s.id.slice(0, 8)}  ${new Date(s.mtime).toLocaleString()}  ${firstPrompt(s.file) || '(no prompt)'}`);
    return;
  }
  const want = arg('--session');
  const pick = want ? list.find((s) => s.id.startsWith(want)) : list[0];
  if (!pick) { console.error(`No session starting with "${want}". Run with --list to see them.`); process.exit(1); }
  const events = convertSession(pick.file, null);
  if (!events.length) { console.error('That session has no prompts or tool calls to replay.'); process.exit(1); }
  const title = firstPrompt(pick.file) || `Session ${pick.id.slice(0, 8)}`;
  const cwd = (events.find((e) => e.cwd) || {}).cwd || path.resolve(project);
  const out = path.resolve(arg('--out') || `session-replay-${new Date(pick.mtime).toISOString().slice(0, 10)}-${pick.id.slice(0, 8)}.html`);
  fs.writeFileSync(out, buildHtml(events, title, cwd));
  const prompts = events.filter((e) => e.event === 'UserPromptSubmit').length, subs = events.filter((e) => e.event === 'SubagentStart').length;
  console.log(`Wrote ${out}`);
  console.log(`Session ${pick.id.slice(0, 8)} "${title}": ${prompts} prompts, ${subs} subagent runs, ${events.length} events.`);
  console.log('\n' + summarize(events));
}

function selfTest() {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  try {
    const at = (s) => new Date(Date.UTC(2026, 10, 9, 10, 0, s)).toISOString();
    const lines = [
      { type: 'user', timestamp: at(0), sessionId: 'abc12345', cwd: '/home/sam/app', message: { content: 'Fix the login bug </script><b>' } },
      { type: 'assistant', timestamp: at(5), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/sam/app/login.ts' } }], usage: { input_tokens: 10, output_tokens: 20 } } },
      { type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file text' }] } },
    ];
    const file = path.join(tmp, 'abc12345.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const events = convertSession(file, null);
    assert.deepStrictEqual(events.map((e) => e.event), ['UserPromptSubmit', 'PreToolUse', 'Stop', 'Tokens', 'SessionEnd']);
    assert.strictEqual(firstPrompt(file), 'Fix the login bug </script><b>');
    const html = buildHtml(events, firstPrompt(file), '/home/sam/app');
    const data = html.match(/window\.EXPORT = (.*);<\/script>/)[1];
    assert.ok(!/<\/script/i.test(data), 'data cannot close the script tag');
    assert.strictEqual(JSON.parse(data).ev.length, events.length);
    assert.strictEqual(transcriptDir(tmp), null);   // a folder that never had a session
    const table = summarize(events);
    assert.ok(table.startsWith('**1 prompts, 0 subagents, 1 tool calls (0 failed), 10 tokens in, 20 out.**'), table);
    assert.ok(table.includes('| Main agent, prompt 1 | ') && table.includes(' | 5s | 1 | 10 / 20 |'), table);
    console.log('self-test ok');
  } finally { for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f)); fs.rmdirSync(tmp); }   // only its own temp file and folder
}

module.exports = { summarize, buildHtml };

if (require.main !== module) { /* required as a library */ }
else if (process.argv[2] === '--self-test') selfTest(); else main(process.argv.slice(2));
