// One-time import: turns Claude Code's own session transcripts (~/.claude/projects) into monitor events,
// so sessions from before the hooks were installed show up too. Writes ~/.claude/agent-monitor/imported.jsonl
// (replaced on every run, so running it again is safe). The live log, events.jsonl, is never touched.
// Usage: node import.js            Self-check: node import.js --self-test
// Keeps only what the hook keeps: tool names and short summaries, never file contents or command output.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { toEvent, cut, redact, textOf, promptText, usageOf } = require('./hook.js');
const NO_TEXT = /^(off|0|false|no)$/i.test(process.env.AGENT_MONITOR_TEXT || '');   // same switch as the hook

const CLAUDE = path.join(os.homedir(), '.claude');
const DIR = path.join(CLAUDE, 'agent-monitor');
const LIVE = path.join(DIR, 'events.jsonl');
const OUT = path.join(DIR, 'imported.jsonl');

const readLines = (file) => {
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
};
// One transcript (main agent or one subagent) to hook-shaped inputs, each with its own time.
function convert(lines, base, agent) {
  const out = [], tools = {}, results = {}, launches = {};
  let turnOpen = false, lastTs = null, lastText = null, branch = null, handback = null, pending = null, seg = [];
  const replies = [];   // every reply, for a subagent's token total
  const push = (ts, h) => { out.push({ ts, branch, h: { session_id: base.session, cwd: base.cwd, ...agent, ...h } }); lastTs = ts; };
  // a main-agent turn's tokens: the replies since the prompt before, as one Tokens line where the turn stops
  const flush = () => { const u = !agent.agent_id && usageOf(seg); seg = []; if (u) push(lastTs, { hook_event_name: 'Tokens', usage: u }); };
  for (const o of lines) {
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (!ts) continue;
    if (o.gitBranch) branch = o.gitBranch;   // the branch at that moment, not today's
    const c = o.message && o.message.content;
    // a background subagent's report arrives as a task notification naming its tool_use id: in a user line,
    // a queued command or a queue operation, depending on when it landed
    for (const t of [o.type === 'user' ? textOf(c) : '', typeof o.content === 'string' ? o.content : '', (o.attachment && o.attachment.prompt) || '']) {
      const id = t.includes('<task-notification>') && (t.match(/<tool-use-id>([^<]+)<\/tool-use-id>/) || [])[1];
      const rep = id && (t.match(/<result>([\s\S]*?)<\/result>/) || t.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1];
      if (rep && (!results[id] || rep.length > results[id].length)) results[id] = rep.trim();   // the full result beats the one-line summary
    }
    if (!agent.agent_id) {
      const p = promptText(o);
      if (p != null) {
        if (turnOpen) push(lastTs, { hook_event_name: 'Stop' });
        flush();
        push(ts, { hook_event_name: 'UserPromptSubmit', prompt: p });
        pending = out[out.length - 1];   // gets the model of the reply that follows
        turnOpen = true; continue;
      }
    }
    if (o.type === 'assistant' && Array.isArray(c)) {
      lastTs = ts;   // a reply counts as activity even without a tool call
      seg.push(o); replies.push(o);
      const model = o.message && o.message.model;
      if (pending && model && !model.startsWith('<')) { pending.h.model = model; pending = null; }   // skip "<synthetic>" replies
      for (const b of c) {
        if (b.type === 'tool_use') { tools[b.id] = b.name; push(ts, { hook_event_name: 'PreToolUse', tool_name: b.name, tool_input: b.input, tool_use_id: b.id }); }
        if (b.type === 'tool_use' && b.name === 'SubagentHandback' && b.input) handback = b.input.message || handback;   // its report to whoever launched it
        if (b.type === 'text' && b.text) lastText = b.text;
      }
    } else if (o.type === 'user' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type !== 'tool_result' || !tools[b.tool_use_id]) continue;
        const tool = tools[b.tool_use_id];
        // what the subagent handed back; a background one only returns a launch notice here and reports later (below)
        const res = textOf(b.content);
        if ((tool === 'Agent' || tool === 'Task') && res && !/^Async agent launched/.test(res)) results[b.tool_use_id] = res;
        // a workflow run: its agents' transcripts sit under subagents/workflows/<runId>; remember which call started it
        const run = tool === 'Workflow' && o.toolUseResult && o.toolUseResult.runId;
        if (run) (launches[run] ||= []).push({ use: b.tool_use_id, ts, name: o.toolUseResult.workflowName });
        if (b.is_error) push(ts, { hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_use_id: b.tool_use_id, error: textOf(b.content) || String(b.content || '') });
        // the page only needs results that end a wait for you (a question or a plan you answered); toolUseResult holds your answers
        else if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') push(ts, { hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: b.tool_use_id, tool_input: {}, tool_response: o.toolUseResult });
      }
    }
  }
  return { out, turnOpen, lastTs, lastText, results, handback, launches, rest: usageOf(seg), tok: usageOf(replies) };
}

function convertSession(file, liveFrom, liveTokFrom = Infinity) {
  const lines = readLines(file);
  const first = lines.find((o) => o.sessionId && o.cwd);
  if (!first) return [];
  const base = { session: first.sessionId, cwd: first.cwd };
  const main = convert(lines, base, {});
  const all = main.out;
  if (main.turnOpen) all.push({ ts: main.lastTs, h: { session_id: base.session, cwd: base.cwd, hook_event_name: 'Stop' } });
  if (main.rest) all.push({ ts: main.lastTs, h: { session_id: base.session, cwd: base.cwd, hook_event_name: 'Tokens', usage: main.rest } });
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents'), subs = [];
  if (fs.existsSync(subDir)) for (const f of fs.readdirSync(subDir)) {
    if (!f.endsWith('.jsonl')) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch {}
    const agent = { agent_id: f.replace(/^agent-|\.jsonl$/g, ''), agent_type: meta.agentType || 'agent' };
    const sub = convert(readLines(path.join(subDir, f)), base, agent);
    if (sub.out.length) subs.push({ agent, meta, sub });
  }
  // who launched each subagent: the agent whose Agent call has the tool_use id its meta names (main, or another subagent)
  const caller = {}, results = Object.assign({}, main.results, ...subs.map((s) => s.sub.results));
  for (const e of all.concat(...subs.map((s) => s.sub.out))) if (e.h.hook_event_name === 'PreToolUse') caller[e.h.tool_use_id] = e.h.agent_id || 'main';
  for (const { agent, meta, sub } of subs) {
    all.push({ ts: sub.out[0].ts - 1, h: { session_id: base.session, cwd: base.cwd, ...agent, hook_event_name: 'SubagentStart', description: meta.description, parent_agent: caller[meta.toolUseId] } });
    all.push(...sub.out);
    if (sub.tok) all.push({ ts: sub.lastTs + 1, h: { session_id: base.session, cwd: base.cwd, ...agent, hook_event_name: 'Tokens', usage: sub.tok } });
    all.push({ ts: sub.lastTs + 1, h: { session_id: base.session, cwd: base.cwd, ...agent, hook_event_name: 'SubagentStop', last_assistant_message: sub.handback || (/^This agent's report was delivered/.test(results[meta.toolUseId] || '') ? null : results[meta.toolUseId]) || sub.lastText } });
  }
  all.push(...workflowAgents(subDir, path.join(path.dirname(file), path.basename(file, '.jsonl'), 'workflows'), base, main.launches, caller));
  if (!all.some((e) => e.h.hook_event_name === 'UserPromptSubmit' || e.h.hook_event_name === 'PreToolUse')) return [];   // nothing happened in it
  all.sort((a, b) => a.ts - b.ts);
  const end = all[all.length - 1].ts;
  // the live log knows this session from liveFrom on, and knows it better: stop there
  // …except your answers to questions: the live log only has them since the hook started recording them
  // …nor workflow agents: the live hooks don't report them (yet)
  // …nor token counts, until the live log records them itself (hooks from 0.2.0 on)
  const kept = all.filter((e) => liveFrom == null || e.ts < liveFrom || (e.h.tool_response && e.h.tool_response.answers) || e.x || (e.h.hook_event_name === 'Tokens' && e.ts < liveTokFrom));
  if (liveFrom == null) kept.push({ ts: end + 1, h: { session_id: base.session, cwd: base.cwd, hook_event_name: 'SessionEnd', reason: 'imported' } });
  let branch = null;   // lines the import adds itself (Stop, SessionEnd, subagent start/stop) take the branch before them
  const entry = (lines.find((o) => o.entrypoint) || {}).entrypoint || null;   // claude-desktop…, cli, sdk-py…
  return kept.map((e) => { branch = e.branch || branch; return Object.assign(toEvent({ ...e.h }, new Date(e.ts)), branch ? { branch } : {}, { entry }, e.x || {}); });
}

// workflow tasks open with a preamble shared by every agent; the agent's own job is at the end
const tail = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? '…' + s.slice(1 - n) : s; };
const laneOf = (label) => { const m = String(label || '').match(/\bE0*(\d+)/); return m ? 'E' + m[1] : null; };   // "E1 Annealing" and "Measurer E01_annealing" share lane E1
// Agents of the workflow runs a session started (subagents/workflows/<runId>/agent-*.jsonl, journal.jsonl).
// Each gets its label, phase, task and result, and the agent whose results it picked up: same lane, earlier phase,
// finished last before it started (or, without a lane, finished within 90 s before it). Otherwise the call that started the run.
function workflowAgents(subDir, wfDir, base, launches, caller) {
  const root = path.join(subDir, 'workflows'), out = [];
  if (!fs.existsSync(root)) return out;
  for (const run of fs.readdirSync(root)) {
    const dir = path.join(root, run), journal = {};
    let order = [];
    try { for (const o of readLines(path.join(dir, 'journal.jsonl'))) { if (o.agentId) Object.assign(journal[o.agentId] ||= {}, o); if (o.phase && !order.includes(o.phase)) order.push(o.phase); } } catch {}
    let name = (launches[run] || [])[0] && launches[run][0].name;
    try {   // the script's own phase list gives the real order
      const sc = JSON.parse(fs.readFileSync(path.join(wfDir, run + '.json'), 'utf8')).script || '';
      name = name || (sc.match(/name:\s*['"`]([^'"`]+)/) || [])[1];
      const ph = [...((sc.match(/phases:\s*\[([\s\S]*?)\]/) || [])[1] || '').matchAll(/title:\s*['"`]([^'"`]+)/g)].map((m) => m[1]);
      if (ph.length) order = ph.concat(order.filter((p) => !ph.includes(p)));
    } catch {}
    const agents = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/^agent-.*\.jsonl$/.test(f)) continue;
      const id = f.replace(/^agent-|\.jsonl$/g, ''), j = journal[id] || {};
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch {}
      const lines = readLines(path.join(dir, f)), agent = { agent_id: id, agent_type: 'workflow' };
      const sub = convert(lines, base, agent);
      if (!sub.out.length) continue;
      const first = lines.find((o) => o.type === 'user' && !o.isMeta);
      const task = first ? textOf(first.message && first.message.content).replace(/^\[Workflow harness[\s\S]*?follows:\s*/, '') : null;
      const label = meta.description || j.label || id, phase = meta.workflowPhase || j.phase || null;
      const result = j.result == null ? sub.handback || sub.lastText : typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
      agents.push({ id, agent, sub, label, phase, task, result, lane: laneOf(label), rank: order.indexOf(phase), start: sub.out[0].ts - 1, end: sub.lastTs + 1 });
    }
    for (const a of agents) {
      const earlier = agents.filter((b) => b.rank < a.rank && b.end <= a.start + 1000 && (a.lane ? b.lane === a.lane : a.start - b.end < 90000));
      const from = earlier.sort((x, y) => y.end - x.end)[0];
      const launch = (launches[run] || []).filter((l) => l.ts <= a.start + 1000).pop() || (launches[run] || [])[0];
      out.push({ ts: a.start, x: { wf: name || run, phase: a.phase, task: NO_TEXT ? null : redact(tail(a.task, 400)), handoff: !!from }, h: { session_id: base.session, cwd: base.cwd, ...a.agent, hook_event_name: 'SubagentStart',
        description: a.label, parent_agent: from ? from.id : launch && caller[launch.use], tool_use_id: launch ? launch.use : null } });
      out.push(...a.sub.out.map((e) => ({ ...e, x: {} })));
      if (a.sub.tok) out.push({ ts: a.end, x: {}, h: { session_id: base.session, cwd: base.cwd, ...a.agent, hook_event_name: 'Tokens', usage: a.sub.tok } });
      out.push({ ts: a.end, x: {}, h: { session_id: base.session, cwd: base.cwd, ...a.agent, hook_event_name: 'SubagentStop', last_assistant_message: a.result } });
    }
  }
  return out;
}

function main() {
  const liveFrom = {}, liveTok = {};
  if (fs.existsSync(LIVE)) for (const e of readLines(LIVE)) {
    const t = Date.parse(e.ts);
    if (e.session && !(liveFrom[e.session] <= t)) liveFrom[e.session] = t;
    if (e.session && e.tok && !(liveTok[e.session] <= t)) liveTok[e.session] = t;
  }
  const root = path.join(CLAUDE, 'projects'), events = [];
  let files = 0, sessions = 0;
  for (const p of fs.existsSync(root) ? fs.readdirSync(root) : []) {   // no transcripts yet: an empty import
    const d = path.join(root, p);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      files++;
      try {
        const evs = convertSession(path.join(d, f), liveFrom[path.basename(f, '.jsonl')], liveTok[path.basename(f, '.jsonl')]);
        if (evs.length) { sessions++; events.push(...evs); }
      } catch (err) { console.error(`skipped ${p}/${f}: ${err.message}`); }
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });   // owner-only, like the hook's log
  fs.writeFileSync(OUT, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 });
  console.log(`Read ${files} transcripts: ${sessions} sessions with activity, ${events.length} events -> ${OUT}`);
}

function selfTest() {
  const assert = require('assert');
  const at = (m) => `2026-11-03T10:${String(m).padStart(2, '0')}:00Z`;
  const lines = [
    { type: 'user', timestamp: at(0), sessionId: 's', cwd: 'C:\\w\\recipe-finder', message: { content: '<command-name>/review</command-name><command-args>fast</command-args>' } },
    { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env', description: 'Show env' } }] } },
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1\nsecret stuff' }] } },
    { type: 'user', timestamp: at(3), isMeta: true, message: { content: 'meta' } },
    { type: 'user', timestamp: at(4), message: { content: '[Request interrupted by user]' } },
    { type: 'user', timestamp: at(5), message: { content: [{ type: 'text', text: 'Now fix it' }] } },
  ];
  const r = convert(lines, { session: 's', cwd: 'C:\\w\\recipe-finder' }, {});
  const evs = r.out.map((e) => toEvent(e.h, new Date(e.ts)));
  assert.deepStrictEqual(evs.map((e) => e.event), ['UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit']);
  assert.strictEqual(evs[0].summary, '/review fast');
  assert.strictEqual(evs[1].summary, 'Show env');
  assert.strictEqual(evs[2].summary, 'Exit code 1');   // first line only, never the output
  assert.strictEqual(evs[3].ts, new Date(at(2)).toISOString());   // turn 1 ends at its last activity
  assert.strictEqual(evs[4].project, 'recipe-finder');
  assert.strictEqual(r.turnOpen, true);
  const u = (id, n) => ({ type: 'assistant', timestamp: at(0), message: { id, content: [], usage: { input_tokens: n, output_tokens: 1 } } });
  const r2 = convert([{ ...lines[5], timestamp: at(0) }, u('a', 5), u('a', 5), u('b', 2), { ...lines[5], timestamp: at(1) }, u('c', 9)], { session: 's', cwd: 'C:\w' }, {});
  const toks = r2.out.filter((e) => e.h.hook_event_name === 'Tokens');
  assert.deepStrictEqual(toks.map((e) => e.h.usage.i), [7]);
  assert.deepStrictEqual([r2.rest.i, r2.tok.i], [9, 16]);
  assert.strictEqual(tail('a  b\n c ' + 'x'.repeat(20), 10), '…' + 'x'.repeat(9));
  assert.strictEqual(tail('a  b\n c', 10), 'a b c');
  assert.deepStrictEqual([laneOf('E1 Annealing family'), laneOf('C3 Measurer E01_annealing'), laneOf('C8 Finisher r2')], ['E1', 'E1', null]);
  console.log('self-test ok');
}

if (process.argv[2] === '--self-test') selfTest(); else main();
