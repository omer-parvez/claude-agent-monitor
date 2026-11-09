---
name: open
description: Start the local agent monitor and give the user its link, a live browser page of every Claude Code session, turn, subagent and tool call on this computer. Use when the user asks to open, start or show the agent monitor, or to watch their agents live.
---

# Open the agent monitor

The monitor is a small local web server in this plugin's folder: `server.js`, two folders above this skill's base directory. It listens on 127.0.0.1 only and makes no network calls.

0. First refresh the import from Claude Code's own transcripts (foreground, takes a few seconds), and tell the user its output line:

   ```bash
   node "<base directory>/../../import.js"
   ```

   It covers sessions from before the hooks, and workflow agents, which the live hooks don't report. It replaces imported.jsonl and never touches the live log. If the monitor was already running, tell the user to reload the page to see the new import.

1. Start it in the background (Bash tool with `run_in_background: true`), using the base directory shown above this text:

   ```bash
   node "<base directory>/../../server.js"
   ```

   If the user named a port, add it as the last argument. Default port: 7788.

2. Read its first output line:
   - `Agent monitor: http://127.0.0.1:7788/?k=... ...`: started.
   - `Agent monitor already running: http://127.0.0.1:7788/?k=...`: it was already up. That is fine.
   - `Port 7788 is used by another program`: run it again with port 7789.

3. Give the user the full link from that line, including its `?k=` key, in one sentence. The page shows no data without the key. Mention that `[` and `]` cycle sessions and `L` jumps back to live.

Events come from this plugin's own hooks (`hooks/hooks.json`), which write to `~/.claude/agent-monitor/events.jsonl`. They need `node` on the PATH and start with the next Claude Code session after the plugin is installed or updated. If the page stays empty after a prompt in a new session, check `node --version` works in a plain terminal.
