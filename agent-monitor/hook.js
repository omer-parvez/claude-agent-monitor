// Claude Code hook: turns each hook event into one line of our own schema in events.jsonl.
// Registered for SessionStart/End, UserPromptSubmit, Pre/PostToolUse(+Failure), Stop, SubagentStart/Stop, Notification, PermissionRequest.
// Never blocks or fails Claude: any error is swallowed and the script exits 0.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = process.env.AGENT_MONITOR_FILE || path.join(os.homedir(), '.claude', 'agent-monitor', 'events.jsonl');
const MAX_BYTES = +(process.env.AGENT_MONITOR_MAX_MB || 20) * 1048576;   // then events.jsonl becomes events.1.jsonl and starts over
// AGENT_MONITOR_TEXT=off: keep no prompt text, subagent reports or your answers, only tool names, paths and timings
const NO_TEXT = /^(off|0|false|no)$/i.test(process.env.AGENT_MONITOR_TEXT || '');

// Masks what looks like a secret: bearer tokens, key=value credentials, credential flags, well-known key formats,
// and URL query strings (signed links, ?token=). Best effort: a secret in free text without a telltale shape gets through.
const SECRET_KEY = '(?:api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|token|password|passwd|pwd|authorization|auth)';
const REDACT = [
  [/\bBearer\s+[^\s"']+/gi, 'Bearer ***'],
  [new RegExp(`(\\b${SECRET_KEY}["']?\\s*[:=]\\s*["']?)[^\\s"'&,;]+`, 'gi'), '$1***'],
  [new RegExp(`(--?${SECRET_KEY}[= ])[^\\s"']+`, 'gi'), '$1***'],
  [/\b(?:sk-[\w-]{16,}|sk-ant-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{20,}\.[\w-]{10,}\.[\w-]{10,})/g, '***'],
  [/(\bhttps?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1?…'],
];
const redact = (s) => REDACT.reduce((t, [re, to]) => t.replace(re, to), s);

const cut = (s, n = 80) => {
  if (s == null) return null;
  s = redact(String(s).replace(/\s+/g, ' ').trim());
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Short, human summary of a tool call. Never the full content or output: events may hold secrets.
function toolSummary(name, input = {}) {
  if (name === 'Bash' || name === 'PowerShell') {
    if (input.description) return cut(input.description);
    // no description: only the program it runs, never its arguments (they may carry tokens)
    const prog = String(input.command || '').trim().split(/\s+/)[0] || '';
    return prog ? cut(`${path.basename(prog.replace(/["']/g, ''))} (command not shown)`) : null;
  }
  if (input.file_path) return cut(input.file_path, 120);
  if (input.notebook_path) return cut(input.notebook_path, 120);
  if (input.pattern) return cut(input.pattern);
  if (input.url) return cut(String(input.url).split(/[?#]/)[0], 120);   // never a query string: signed links, tokens
  if (input.query) return cut(input.query);
  if (input.questions && input.questions[0]) return cut(input.questions[0].question);
  if (name === 'ExitPlanMode') return 'Plan ready for your approval';
  if (name === 'SubagentHandback') return cut(input.message, 300);   // a subagent's report: the monitor shows it as its output
  return cut(input.description || input.prompt || input.title);
}

const STATUS = {
  SessionStart: 'started', SessionEnd: 'ended', UserPromptSubmit: 'prompt', Stop: 'idle',
  PreToolUse: 'running', PostToolUse: 'ok', PostToolUseFailure: 'failed',
  SubagentStart: 'running', SubagentStop: 'done', PermissionRequest: 'needs_input',
};
// Things that stop an agent until you answer. Any later non-Notification event from the same agent means you did.
const INPUT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const INPUT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function statusOf(h) {
  const ev = h.hook_event_name;
  if (ev === 'Notification') return INPUT_NOTIFICATIONS.has(h.notification_type) ? 'needs_input' : (h.notification_type || 'notice');
  if (ev === 'PreToolUse' && INPUT_TOOLS.has(h.tool_name)) return 'needs_input';
  if (ev === 'PostToolUseFailure' && h.is_interrupt) return 'interrupted';
  return STATUS[ev] || null;
}

// Your answers to Claude's questions, as [question, answer] pairs. Only for the tools that wait for you.
function answersOf(h) {
  if (h.hook_event_name !== 'PostToolUse') return null;
  if (h.tool_name === 'ExitPlanMode') return [['Approve this plan?', 'Approved']];
  const a = h.tool_name === 'AskUserQuestion' && h.tool_response && h.tool_response.answers;
  return a && typeof a === 'object' ? Object.entries(a).map(([q, v]) => [cut(q, 300), NO_TEXT ? '(answered)' : cut(Array.isArray(v) ? v.join(', ') : v, 300)]) : null;
}
// With text off a prompt keeps only its leading tag or slash command, so the page still tells reports from your own prompts
const promptSummary = (p) => NO_TEXT ? ((String(p || '').trim().match(/^(<[\w-]+>?|\/[\w:.-]+)/) || [])[1] || '(prompt text not recorded)') : cut(p, 300);

// ---- tokens: read from Claude Code's transcripts, which record each reply's usage
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
// What you typed (or Claude Code injected as a prompt), or null for lines that only look like prompts (tool results, command output, interruptions).
function promptText(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary || o.isSidechain) return null;
  const c = o.message && o.message.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return null;
  const t = textOf(c).trim();
  if (!t || /^(<local-command|Caveat:|\[Request interrupted)/.test(t)) return null;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) { const args = (t.match(/<command-args>([^<]*)<\/command-args>/) || [])[1]; return (cmd[1] + (args ? ' ' + args : '')).trim(); }
  return t;
}
// Token totals of the replies in these transcript lines: i fresh input, o output, cr cache read, cw cache write.
// A reply split over several lines repeats its message id; its last line has the final count.
function usageOf(lines) {
  const by = new Map();
  for (const o of lines) { const u = o.type === 'assistant' && o.message && o.message.usage; if (u) by.set(o.message.id || o.uuid, u); }
  const t = { i: 0, o: 0, cr: 0, cw: 0 };
  for (const u of by.values()) { t.i += u.input_tokens || 0; t.o += u.output_tokens || 0; t.cr += u.cache_read_input_tokens || 0; t.cw += u.cache_creation_input_tokens || 0; }
  return t.i + t.o + t.cr + t.cw ? t : null;
}
// The last lines of a transcript, parsed. shortcut: only the last 8 MB, so a turn longer than that is undercounted.
function tailLines(file, max = 8 * 1048576) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, max), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    if (n < size) lines.shift();   // started mid-line
    return lines.map((l) => { try { return l && JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally { fs.closeSync(fd); }
}
// Live: a turn's tokens when it stops (replies since the last prompt), a subagent's when it stops (its whole transcript).
function liveUsage(h) {
  try {
    if (h.hook_event_name === 'Stop' && h.transcript_path) {
      const lines = tailLines(h.transcript_path);
      let i = lines.length; while (i > 0 && promptText(lines[i - 1]) == null) i--;
      return usageOf(lines.slice(i));
    }
    if (h.hook_event_name === 'SubagentStop' && h.agent_id) {
      const f = h.agent_transcript_path || (h.transcript_path && path.join(path.dirname(h.transcript_path), String(h.session_id), 'subagents', `agent-${h.agent_id}.jsonl`));
      return f ? usageOf(tailLines(f)) : null;
    }
  } catch {}
  return null;
}

function toEvent(h, now = new Date()) {
  const ev = h.hook_event_name;
  let summary = null;
  const qa = answersOf(h);
  if (qa) summary = cut(qa.map(([, a]) => a).join(' · '), 120);
  else if (ev === 'PreToolUse' || ev === 'PostToolUse') summary = toolSummary(h.tool_name, h.tool_input);
  else if (ev === 'PermissionRequest') summary = cut(`${h.tool_name}: ${toolSummary(h.tool_name, h.tool_input) || ''}`, 100);
  else if (ev === 'Notification') summary = cut(h.message, 120);
  else if (ev === 'PostToolUseFailure') summary = cut(String(h.error || '').split('\n')[0], 120);
  else if (ev === 'UserPromptSubmit') summary = promptSummary(h.prompt);   // 300 chars: enough to read on hover; never a whole pasted document
  else if (ev === 'SubagentStop') summary = NO_TEXT ? null : cut(h.last_assistant_message, 300);
  else if (ev === 'SubagentStart') summary = cut(h.description, 100);   // only the import knows it (from the transcript's meta)
  else if (ev === 'SessionStart') summary = h.source || null;
  else if (ev === 'SessionEnd') summary = h.reason || null;
  return {
    v: 1,
    ts: now.toISOString(),
    event: ev,
    session: h.session_id || null,
    project: h.cwd ? path.basename(h.cwd) : null,
    cwd: h.cwd || null,
    // live hooks don't say who launched a subagent (the page pairs it with the Agent call before it); the import knows (parent_agent)
    agent: h.agent_id || 'main',
    parent: h.agent_id ? (h.parent_agent || 'main') : null,
    agent_type: h.agent_type || null,
    tool: h.tool_name || null,
    tool_use_id: h.tool_use_id || null,
    summary,
    status: statusOf(h),
    ...(qa ? { qa } : {}),
    // the model the main agent runs on (SessionStart says it; the import takes it from the transcript), for the agent's name on the page
    ...(h.model ? { model: cut(typeof h.model === 'string' ? h.model : h.model.id || h.model.display_name, 60) } : {}),
    // tokens: a turn's or subagent's on Stop/SubagentStop (live), or an imported Tokens line
    ...(h.usage ? { tok: h.usage } : {}),
  };
}

function selfTest() {
  const assert = require('assert');
  const t = new Date('2026-11-04T10:00:00Z');
  const pre = toEvent({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: 'C:\\x\\proj', tool_name: 'Bash',
    tool_use_id: 'tu1', tool_input: { command: 'echo secret-token', description: 'Print hello' } }, t);
  assert.strictEqual(pre.summary, 'Print hello');
  assert.strictEqual(pre.agent, 'main');
  assert.strictEqual(pre.status, 'running');
  assert.strictEqual(pre.tool_use_id, 'tu1');
  const sub = toEvent({ hook_event_name: 'PostToolUseFailure', session_id: 's1', agent_id: 'a9', agent_type: 'Explore',
    tool_name: 'Read', error: 'File not found\nstack…', is_interrupt: true }, t);
  assert.deepStrictEqual([sub.agent, sub.parent, sub.status, sub.summary], ['a9', 'main', 'interrupted', 'File not found']);
  const long = toEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(500) }, t);
  assert.strictEqual(long.summary.length, 300);
  assert.strictEqual(toEvent({ hook_event_name: 'Weird' }, t).status, null);
  const perm = toEvent({ hook_event_name: 'PermissionRequest', agent_id: 'a2', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clean build' } }, t);
  assert.deepStrictEqual([perm.status, perm.summary, perm.agent], ['needs_input', 'Bash: Clean build', 'a2']);
  const note = toEvent({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, t);
  assert.deepStrictEqual([note.status, note.summary], ['needs_input', 'Claude needs your permission']);
  assert.strictEqual(toEvent({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, t).status, 'idle_prompt');
  const ask = toEvent({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which port?' }] } }, t);
  assert.deepStrictEqual([ask.status, ask.summary], ['needs_input', 'Which port?']);
  const ans = toEvent({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { questions: [], answers: { 'Which port?': '7788' } } }, t);
  assert.deepStrictEqual([ans.summary, ans.qa], ['7788', [['Which port?', '7788']]]);
  assert.strictEqual(toEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } }, t).qa, undefined);
  assert.strictEqual(toEvent({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }, t).model, 'claude-opus-5-5');
  assert.strictEqual(toEvent({ hook_event_name: 'SessionStart', model: { id: 'claude-haiku-5-5' } }, t).model, 'claude-haiku-5-5');
  // secrets stay out of the log
  const bare = toEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abc123" https://x.io' } }, t);
  assert.strictEqual(bare.summary, 'curl (command not shown)');
  assert.strictEqual(toEvent({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://x.io/a?sig=SECRET' } }, t).summary, 'https://x.io/a');
  assert.strictEqual(cut('use token=abc123 and Bearer xyz and --password hunter2 and sk-ant-0123456789abcdefghij', 200), 'use token=*** and Bearer *** and --password *** and ***');
  assert.strictEqual(cut('see https://x.io/p?key=1 now', 200), 'see https://x.io/p?… now');
  assert.strictEqual(cut('C:\\Users\\me\\token_utils.py', 120), 'C:\\Users\\me\\token_utils.py');   // file names that merely contain a word are kept
  console.log('self-test ok');
}

function selfTestNoText() {   // run with AGENT_MONITOR_TEXT=off
  const assert = require('assert');
  assert.strictEqual(toEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'my secret plan' }).summary, '(prompt text not recorded)');
  assert.strictEqual(toEvent({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification> <task-id>x' }).summary, '<task-notification>');
  assert.strictEqual(toEvent({ hook_event_name: 'UserPromptSubmit', prompt: '/agent-monitor:open now' }).summary, '/agent-monitor:open');
  assert.strictEqual(toEvent({ hook_event_name: 'SubagentStop', last_assistant_message: 'report' }).summary, null);
  console.log('self-test ok');
}

function selfTestUsage() {
  const assert = require('assert');
  const a = (id, i, o, cr = 0, cw = 0) => ({ type: 'assistant', message: { id, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw } } });
  // the same reply over two lines counts once, with its last count
  assert.deepStrictEqual(usageOf([a('m1', 10, 1), a('m1', 10, 5, 100), a('m2', 3, 2, 0, 7), { type: 'user' }]), { i: 13, o: 7, cr: 100, cw: 7 });
  assert.strictEqual(usageOf([{ type: 'user' }]), null);
  // a turn's tokens: replies after the last prompt line only
  const tmp = path.join(os.tmpdir(), `am-usage-${process.pid}.jsonl`);
  const lines = [{ type: 'user', message: { content: 'first' } }, a('x', 50, 50), { type: 'user', message: { content: 'second' } }, a('y', 1, 2),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }, a('z', 3, 4)];
  fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try { assert.deepStrictEqual(liveUsage({ hook_event_name: 'Stop', transcript_path: tmp }), { i: 4, o: 6, cr: 0, cw: 0 }); } finally { fs.unlinkSync(tmp); }
  assert.strictEqual(toEvent({ hook_event_name: 'Stop', usage: { i: 1, o: 2, cr: 0, cw: 0 } }).tok.o, 2);
}

module.exports = { toEvent, cut, redact, textOf, promptText, usageOf };   // import.js turns old transcripts into the same events

if (require.main !== module) { /* required as a library: do nothing else */ }
else if (process.argv[2] === '--self-test') { selfTestUsage(); NO_TEXT ? selfTestNoText() : selfTest(); }
else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      // owner-only folder and file: other users on a shared Mac or Linux machine can't read your prompts (Windows uses the profile's ACL)
      fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
      // full: start a fresh file, keeping one older one.
      // shortcut: two hooks rolling over at the same instant can drop the older file; fine for a viewer log.
      try { if (fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, FILE.replace(/\.jsonl$/, '') + '.1.jsonl'); } catch {}
      // host: the desktop app's own session id (local_…), entry: desktop, cli, vscode, sdk… Both come from Claude Code's env.
      const h = JSON.parse(raw);
      h.usage = liveUsage(h);
      const ev = Object.assign(toEvent(h), { host: process.env.CLAUDE_CODE_HOST_SESSION_ID || null, entry: process.env.CLAUDE_CODE_ENTRYPOINT || null });
      fs.appendFileSync(FILE, JSON.stringify(ev) + '\n', { mode: 0o600 });
    } catch { /* never break Claude over a log line */ }
    process.exit(0);
  });
}
