// Builds a made-up example data set for the agent monitor, so it can be shown (screenshots, the live demo page)
// without anyone's real sessions. Nothing here reads your own data.
// Usage: node demo/make-demo.js
// Writes:
//   demo/data/events.jsonl                       events, timed relative to now (one swarm still running)
//   demo/data/desktop/claude-code-sessions/*.json   desktop-app style session records: titles and a sidebar group
//   docs/index.html                              the page with the events built in: a demo that runs offline (GitHub Pages)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'data');
const NOW = Date.now(), S = 1000, MIN = 60 * S;
let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;   // repeatable "random"
const between = (a, b) => a + rnd() * (b - a);
let uid = 0;
const id = (p) => `${p}${(++uid).toString(16).padStart(6, '0')}`;

const out = [];
const SESSIONS = [];
function session(o) { const s = { model: 'claude-opus-5-5', ...o }; SESSIONS.push(s); return s; }
function ev(s, t, o) {
  out.push({ v: 1, ts: new Date(t).toISOString(), session: s.cli, project: path.basename(s.cwd), cwd: s.cwd, repo: path.basename(s.cwd), branch: s.branch,
    agent: 'main', parent: null, agent_type: null, tool: null, tool_use_id: null, summary: null, status: null, entry: 'claude-desktop', ...o });
  s.last = Math.max(s.last || 0, t);
}
const tok = (k) => ({ i: Math.round(between(800, 3000) * k), o: Math.round(between(2000, 6000) * k), cr: Math.round(between(60000, 160000) * k), cw: Math.round(between(4000, 15000) * k) });

const prompt = (s, t, text) => ev(s, t, { event: 'UserPromptSubmit', summary: text, status: 'prompt', model: s.model });
const stop = (s, t, k) => ev(s, t, { event: 'Stop', status: 'idle', tok: tok(k) });
// a run of tool calls by one agent: [seconds after the previous one, tool, summary, error if it failed]
function tools(s, agent, t, list) {
  for (const [dt, tool, summary, err] of list) {
    t += dt * S;
    const use = id('toolu_');
    ev(s, t, { event: 'PreToolUse', agent, parent: agent === 'main' ? null : 'main', tool, tool_use_id: use, summary, status: 'running' });
    if (err) ev(s, t + 4 * S, { event: 'PostToolUseFailure', agent, parent: agent === 'main' ? null : 'main', tool, tool_use_id: use, summary: err, status: 'failed' });
  }
  return t;
}
// a question Claude asks you, and your answer (answer null: still waiting for you)
function ask(s, t, question, answer, after = 40) {
  const use = id('toolu_');
  ev(s, t, { event: 'PreToolUse', tool: 'AskUserQuestion', tool_use_id: use, summary: question, status: 'needs_input' });
  if (answer) ev(s, t + after * S, { event: 'PostToolUse', tool: 'AskUserQuestion', tool_use_id: use, summary: answer, status: 'ok', qa: [[question, answer]] });
  return t + after * S;
}
// a subagent: the Agent call that starts it, its tool calls, its report. end null: still running
function sub(s, o) {
  const agent = id('a');
  if (!o.wf) ev(s, o.start - 2 * S, { event: 'PreToolUse', tool: 'Agent', tool_use_id: id('toolu_'), summary: o.desc, status: 'running' });
  ev(s, o.start, { event: 'SubagentStart', agent, parent: o.parent || 'main', agent_type: o.type, summary: o.wf ? o.label : o.desc, status: 'running', tool_use_id: o.use || null,
    ...(o.wf ? { wf: o.wf, phase: o.phase, task: o.task, handoff: !!o.handoff } : {}) });
  let t = o.start;
  const n = o.calls.length;
  o.calls.forEach((c, i) => {
    const at = o.end ? o.start + (o.end - o.start) * (i + 1) / (n + 1) : t + c[0] * S;
    if (at > NOW - 5 * S) return;   // a running agent's calls stop at now
    t = tools(s, agent, at - c[0] * S, [c]);
  });
  if (o.end) ev(s, o.end, { event: 'SubagentStop', agent, parent: o.parent || 'main', agent_type: o.type, summary: o.result, status: 'done', tok: tok(o.k || 1) });
  return agent;
}

// ---------------------------------------------------------------------------------------------------------
// 1. Recipe finder: a feature from start to merge, with a question, a failed test run and two reviewers
const A = session({ cli: 'demo-recipe-search', title: 'Recipe finder: search by ingredient', cwd: '/home/sam/code/recipe-finder', branch: 'feature/ingredient-search' });
let t = NOW - 5 * 60 * MIN;
prompt(A, t, 'Add a search box that finds recipes by ingredient. Keep it fast, we have 40k recipes.');
t = tools(A, 'main', t, [[6, 'Glob', 'src/**/*.ts'], [4, 'Read', 'src/api/recipes.ts'], [7, 'Read', 'src/db/schema.sql'], [9, 'Grep', 'ingredients'], [20, 'Edit', 'src/db/schema.sql'],
  [25, 'Write', 'src/api/search.ts'], [18, 'Edit', 'src/components/SearchBox.tsx'], [30, 'Bash', 'Run the unit tests'], [12, 'Bash', 'Benchmark search on 40k recipes']]);
stop(A, t + 8 * S, 2.2);
t += 4 * MIN;
prompt(A, t, 'Before we go further, how does the API do pagination today?');
const ex = t + 6 * S;
sub(A, { type: 'Explore', desc: 'Map how pagination works across the API', start: ex, end: ex + 2.5 * MIN, k: 0.8,
  calls: [[3, 'Grep', 'limit|offset|cursor'], [4, 'Read', 'src/api/recipes.ts'], [4, 'Read', 'src/api/users.ts'], [5, 'Read', 'src/lib/paginate.ts'], [3, 'Grep', 'paginate(']],
  result: 'Two styles: recipes and users use offset/limit via src/lib/paginate.ts; comments use cursors. Search should reuse paginate() for consistency.' });
t = tools(A, 'main', ex + 2.6 * MIN, [[5, 'Edit', 'src/api/search.ts']]);
stop(A, t + 6 * S, 0.9);
t += 3 * MIN;
prompt(A, t, "Make it fuzzy, so 'tomatos' still finds tomatoes.");
t = ask(A, t + 20 * S, 'Which fuzzy matching approach should we use?', 'Trigram index in Postgres (Recommended)', 35);
t = tools(A, 'main', t, [[10, 'Edit', 'src/db/schema.sql'], [15, 'Edit', 'src/api/search.ts'], [20, 'Bash', 'Run the unit tests', 'Exit code 1: 2 tests failed (search.spec.ts)'],
  [14, 'Read', 'src/api/search.spec.ts'], [16, 'Edit', 'src/api/search.ts'], [18, 'Bash', 'Run the unit tests'], [10, 'Bash', 'Benchmark fuzzy search']]);
stop(A, t + 8 * S, 1.6);
t += 5 * MIN;
prompt(A, t, 'Review the whole change before I merge it.');
const rv = t + 8 * S;
sub(A, { type: 'code-reviewer', desc: 'Review the ingredient search diff', start: rv, end: rv + 4.2 * MIN, k: 1.3,
  calls: [[2, 'Bash', 'Show the branch diff'], [3, 'Read', 'src/api/search.ts'], [3, 'Read', 'src/components/SearchBox.tsx'], [3, 'Read', 'src/api/search.spec.ts']],
  result: '1 issue: the search box fires a request per keystroke; debounce it (250 ms). Otherwise clean, tests cover the fuzzy cases.' });
sub(A, { type: 'security-reviewer', desc: 'Check the search endpoint for injection', start: rv + 3 * S, end: rv + 3.1 * MIN, k: 0.9,
  calls: [[2, 'Read', 'src/api/search.ts'], [3, 'Grep', 'query\\('], [3, 'Read', 'src/db/client.ts']],
  result: 'No injection: the query is parameterised. Suggest a 100-character cap on the search term.' });
t = tools(A, 'main', rv + 4.4 * MIN, [[8, 'Edit', 'src/components/SearchBox.tsx'], [10, 'Edit', 'src/api/search.ts'], [20, 'Bash', 'Run the unit tests']]);
stop(A, t + 6 * S, 1.1);
t += 2 * MIN;
prompt(A, t, 'Write a short release note for this.');
t = tools(A, 'main', t, [[12, 'Edit', 'CHANGELOG.md']]);
stop(A, t + 5 * S, 0.4);

// ---------------------------------------------------------------------------------------------------------
// 2. Weather dashboard: waiting for your answer right now (the red dot)
const B = session({ cli: 'demo-weather-dark', title: 'Weather dashboard: dark mode', cwd: '/home/sam/code/weather-dash', branch: 'feature/dark-mode', model: 'claude-sonnet-5-5' });
t = NOW - 34 * MIN;
prompt(B, t, 'Add a dark mode toggle that remembers my choice.');
t = tools(B, 'main', t, [[5, 'Grep', 'color|background'], [6, 'Read', 'src/styles/theme.css'], [14, 'Edit', 'src/styles/theme.css'], [16, 'Write', 'src/components/ThemeToggle.svelte'], [12, 'Edit', 'src/App.svelte'], [20, 'Bash', 'Build and run the tests']]);
stop(B, t + 6 * S, 1.2);
t = NOW - 9 * MIN;
prompt(B, t, 'Follow the system setting by default, and make the charts readable in dark mode too.');
t = tools(B, 'main', t, [[6, 'Read', 'src/components/Chart.svelte'], [10, 'Edit', 'src/styles/theme.css'], [12, 'Edit', 'src/components/Chart.svelte']]);
ask(B, t + 15 * S, 'Should the toggle sit in the header or in the settings page?', null);

// ---------------------------------------------------------------------------------------------------------
// 3. Algorithm lab: a workflow swarm, running right now. Four explorers, each handing over to a measurer and a fact-checker
const C = session({ cli: 'demo-sort-swarm', title: 'Benchmark four sorting algorithms', cwd: '/home/sam/code/algo-lab', branch: 'main', group: 'Weekend hacks' });
t = NOW - 70 * MIN;
prompt(C, t, 'Set up a benchmark harness: random, sorted, reversed and nearly sorted inputs, 1k to 1M items.');
t = tools(C, 'main', t, [[6, 'Bash', 'List the project'], [8, 'Write', 'bench/harness.py'], [12, 'Write', 'bench/inputs.py'], [15, 'Bash', 'Run a smoke test of the harness'], [10, 'Edit', 'bench/harness.py'], [14, 'Bash', 'Run a smoke test of the harness']]);
stop(C, t + 8 * S, 1.4);
t = NOW - 52 * MIN;
prompt(C, t, 'Run a swarm: one agent per algorithm (quicksort, merge sort, timsort, radix), then measure and fact-check each result.');
const wfUse = id('toolu_');
ev(C, t + 20 * S, { event: 'PreToolUse', tool: 'Workflow', tool_use_id: wfUse, summary: 'sort-bench', status: 'running' });
const lanes = [['E1', 'Quicksort', 'quicksort', 30], ['E2', 'Merge sort', 'merge', 38], ['E3', 'Timsort', 'timsort', 24], ['E4', 'Radix sort', 'radix', 44]];
const wf = { wf: 'sort-bench', type: 'workflow', use: wfUse };
for (const [code, name, slug, mins] of lanes) {
  const n = code.slice(1), s0 = t + (40 + +n * 7) * S, e0 = s0 + mins * MIN;
  const exp = sub(C, { ...wf, phase: 'Explore', label: `${code} ${name}`, task: `Implement ${name.toLowerCase()} in bench/algos/${slug}.py, tune it, and report its best variant.`, start: s0, end: e0, k: 2.5,
    calls: [[0, 'Read', 'bench/harness.py'], [0, 'Write', `bench/algos/${slug}.py`], [0, 'Bash', 'Run the harness on 10k items'], [0, 'Edit', `bench/algos/${slug}.py`], [0, 'Bash', 'Run the harness on 100k items'],
      ...(code === 'E4' ? [[0, 'Bash', 'Run the harness on 1M items', 'MemoryError: radix buckets for 1M items exceed 2 GB']] : []), [0, 'Edit', `bench/algos/${slug}.py`], [0, 'Bash', 'Run the harness on 1M items'], [0, 'Write', `results/${slug}.json`]],
    result: `${name}: best variant ${['median-of-three pivot', 'bottom-up, insertion sort below 32', 'standard library sorted()', 'LSD, 8-bit digits'][+n - 1]}; ${['0.41', '0.58', '0.12', '0.36'][+n - 1]} s on 1M random items.` });
  // the measurer picks up where its explorer stopped; the fact-checker where the measurer stopped
  const m0 = e0 + 25 * S, mEnd = m0 + between(4, 7) * MIN;
  const meas = sub(C, { ...wf, phase: 'Measure', label: `C3 Measurer E0${n}_${slug}`, parent: exp, handoff: true, task: `Re-run results/${slug}.json five times on every input shape; report mean and spread.`, start: m0, end: mEnd < NOW ? mEnd : null, k: 1,
    calls: [[30, 'Read', `results/${slug}.json`], [40, 'Bash', 'Run the harness 5 times, all input shapes'], [60, 'Bash', 'Compute mean and spread']], result: `Confirmed within 4%: mean ${['0.42', '0.57', '0.12', '0.37'][+n - 1]} s.` });
  if (mEnd < NOW) {
    const f0 = mEnd + 20 * S, fEnd = f0 + between(4, 9) * MIN;
    sub(C, { ...wf, phase: 'Fact-check', label: `C4 Fact-check E0${n}_${slug}`, parent: meas, handoff: true, task: `Check the ${name.toLowerCase()} claims against the raw numbers and the code.`, start: f0, end: fEnd < NOW - 30 * S ? fEnd : null, k: 1.2,
      calls: [[40, 'Read', `bench/algos/${slug}.py`], [50, 'Read', `results/${slug}.json`], [60, 'Bash', 'Re-run the worst case'], [80, 'Bash', 'Compare against the claim']], result: 'Claims hold. Worst case is reversed input, as reported.' });
  }
}
// the main agent keeps an eye on the swarm while it runs
tools(C, 'main', t + 3 * MIN, Array.from({ length: Math.floor(46 / 4) }, () => [240, 'Bash', 'Check the swarm progress']));

// ---------------------------------------------------------------------------------------------------------
// 4. Yesterday: a short bug fix, finished
const D = session({ cli: 'demo-flaky-login', title: 'Fix the flaky login test', cwd: '/home/sam/code/recipe-finder', branch: 'fix/flaky-login', model: 'claude-sonnet-5-5' });
t = NOW - 26 * 60 * MIN;
prompt(D, t, 'The login test fails about one run in ten. Find out why and fix it.');
t = tools(D, 'main', t, [[5, 'Read', 'tests/login.spec.ts'], [8, 'Bash', 'Run the login test 50 times', 'Exit code 1: 6 of 50 runs failed'], [12, 'Grep', 'setTimeout|waitFor'], [9, 'Read', 'src/auth/session.ts'],
  [14, 'Edit', 'tests/login.spec.ts'], [20, 'Bash', 'Run the login test 50 times']]);
stop(D, t + 6 * S, 1);
t += 3 * MIN;
prompt(D, t, 'Nice. Add a comment saying why the wait is needed.');
t = tools(D, 'main', t, [[8, 'Edit', 'tests/login.spec.ts']]);
stop(D, t + 4 * S, 0.3);
ev(D, t + 2 * MIN, { event: 'SessionEnd', summary: 'prompt_input_exit', status: 'ended' });

// ---------------------------------------------------------------------------------------------------------
out.sort((a, b) => a.ts.localeCompare(b.ts));
const desk = SESSIONS.map((s) => ({ id: 'local_' + s.cli, cliIds: [s.cli], title: s.title, cwd: s.cwd, project: path.basename(s.cwd), archived: false,
  createdAt: Date.parse(out.find((e) => e.session === s.cli).ts), lastActivityAt: s.last, model: s.model, group: s.group ? { id: 'g-weekend', name: s.group, order: 0, sortBy: 'recency', ascending: false } : null }));

// the monitor's own inputs: the event log, and desktop-app style session records it reads titles and groups from
fs.rmSync(DATA, { recursive: true, force: true });
const dskDir = path.join(DATA, 'desktop', 'claude-code-sessions');
fs.mkdirSync(dskDir, { recursive: true });
fs.writeFileSync(path.join(DATA, 'events.jsonl'), out.map((e) => JSON.stringify(e)).join('\n') + '\n');
for (const d of desk) fs.writeFileSync(path.join(dskDir, d.id + '.json'), JSON.stringify({ sessionId: d.id, cliSessionId: d.cliIds[0], title: d.title, originCwd: d.cwd, createdAt: d.createdAt, lastActivityAt: d.lastActivityAt, model: d.model, isArchived: false }));
fs.writeFileSync(path.join(DATA, 'desktop', 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { demo: {
  groups: [{ id: 'g-weekend', name: 'Weekend hacks' }], assignments: Object.fromEntries(desk.filter((d) => d.group).map((d) => ['code:' + d.id, 'g-weekend'])) } } } } }));

// the offline demo: the page with these events built in, the same way the page's own Export does it
const page = fs.readFileSync(path.join(ROOT, 'agent-monitor', 'index.html'), 'utf8');
const data = { ev: out, desk: { sessions: desk }, sel: 'local_demo-sort-swarm', focus: ['turn2'],   // opens on the swarm prompt, replaying
  at: NOW + MIN, made: NOW,
  note: 'A live demo with made-up sessions. Click a session on the left, a prompt above the map, or switch to Timeline. Press Play to replay.' };
const html = page.replace('<script>', () => `<script>window.EXPORT = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>\n<script>`);
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'index.html'), html);
console.log(`${out.length} events in ${SESSIONS.length} made-up sessions -> demo/data/events.jsonl, docs/index.html (${Math.round(html.length / 1024)} KB)`);
