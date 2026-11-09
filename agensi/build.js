// Builds the session-replay skill for Agensi: agensi/dist/session-replay/ and agensi/dist/session-replay.zip.
// The skill reuses the agent monitor's transcript reader and page, so they're copied in here, trimmed to what a replay needs:
// no live-logging hook, no bulk import of every project, and no self-tests (their fake secrets would trip a secret scan).
// Usage: node agensi/build.js        (the zip needs Python 3 on the PATH, for its zipfile module)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'session-replay');
const DIST = path.join(__dirname, 'dist');
const OUT = path.join(DIST, 'session-replay');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// keeps a file up to (not including) the line that starts with `stop`, minus lines starting with any of `drop`, then adds `tail`
function trim(src, stop, drop, tail) {
  const lines = src.split('\n'), end = lines.findIndex((l) => l.startsWith(stop));
  if (end < 0) throw new Error(`build: "${stop}" not found; update agensi/build.js`);
  return lines.slice(0, end).filter((l) => !drop.some((d) => l.startsWith(d))).join('\n').trimEnd() + '\n\n' + tail + '\n';
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'SKILL.md'), path.join(OUT, 'SKILL.md'));
fs.copyFileSync(path.join(SRC, 'scripts', 'replay.js'), path.join(OUT, 'scripts', 'replay.js'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
fs.writeFileSync(path.join(OUT, 'assets', 'replay.html'), read('agent-monitor/index.html'));
fs.writeFileSync(path.join(OUT, 'scripts', 'hook.js'), trim(read('agent-monitor/hook.js'), 'function selfTest()', ['const FILE =', 'const MAX_BYTES ='],
  '// Trimmed copy of the agent monitor\'s hook.js: only the functions that turn transcript lines into events.\nmodule.exports = { toEvent, cut, redact, textOf, promptText, usageOf };'));
fs.writeFileSync(path.join(OUT, 'scripts', 'import.js'), trim(read('agent-monitor/import.js'), 'function main()', ['const DIR =', 'const LIVE =', 'const OUT ='],
  '// Trimmed copy of the agent monitor\'s import.js: only the reader for one session\'s transcript.\nmodule.exports = { convertSession };'));

// the built skill must still pass its own self-test
execFileSync(process.execPath, [path.join(OUT, 'scripts', 'replay.js'), '--self-test'], { stdio: 'inherit' });

// zip: one top-level folder with SKILL.md at its root, as Agensi expects
const py = process.platform === 'win32' ? 'python' : 'python3';
execFileSync(py, ['-I', '-m', 'zipfile', '-c', 'session-replay.zip', 'session-replay'], { cwd: DIST, stdio: 'inherit' });
const kb = (f) => Math.round(fs.statSync(f).size / 1024);
console.log(`Built ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, path.join(DIST, 'session-replay.zip'))} (${kb(path.join(DIST, 'session-replay.zip'))} KB)`);
