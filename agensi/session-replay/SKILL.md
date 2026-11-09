---
name: session-replay
description: Turn a Claude Code session into one offline HTML replay that shows every prompt, the main agent and each subagent or workflow agent it started, on a map and a timeline with start and finish times and token counts. Use when the user asks to replay a session, visualise what the agents did, see a timeline or Gantt chart of the agents, review how a swarm or workflow ran, or share a session with someone. Claude Code sessions only.
---

# Session replay

Builds a single HTML file from one of this project's Claude Code sessions. The file opens in any browser, works offline and needs nothing installed. It shows:

- every prompt the user typed, and the questions Claude asked back with the answers;
- the main agent (blue) and every subagent and workflow agent it started (orange), each linked to whoever started it;
- a **Map** view and a **Timeline** view (one bar per agent, from start to finish, with a tick per tool call);
- start and finish times, durations, tool calls, failures and token counts per agent and per prompt;
- Play, pause and scrub controls to replay the session as it happened.

## What it reads and writes

- **Reads** only this project's own transcripts in `~/.claude/projects/<this project's folder>/`, which Claude Code writes itself. Nothing else on the computer.
- **Writes** one HTML file, in the current folder by default.
- **Keeps** only tool names and one-line summaries: file paths, search patterns, Claude's description of each shell command, the user's prompts (first 300 characters) and agent reports (first 300 characters). Never file contents or command output. Text that looks like a secret (bearer tokens, `password=`/`token=`/`api_key=` values, common API key formats, URL query strings) becomes `***`.
- **Never** makes network calls, installs packages or changes settings.
- The page (`assets/replay.html`) is the Agent Monitor's own page. It still contains the code that talks to the monitor's local server in live mode; a replay file never runs it, and opening the file makes no requests at all.

## Steps

The script is `scripts/replay.js` in this skill's folder. It needs Node.js 18 or newer (`node --version`). Run it from the user's project folder.

1. **Pick the session.** If the user means the current or the latest session, skip to step 2. If they describe another one ("the session where we fixed the login bug"), list them first and pick the matching one by its first prompt:

   ```bash
   node "<skill folder>/scripts/replay.js" --list
   ```

   Each line is: session id prefix, last activity, first prompt.

2. **Build the replay:**

   ```bash
   node "<skill folder>/scripts/replay.js"
   ```

   For a specific session add `--session <id prefix>`. For another output path add `--out <file.html>`. For a different project folder add `--project <folder>`.

3. **Report** in this order:
   - one or two sentences: which session (its first prompt), and the bold totals line the script printed;
   - the agent table the script printed, as it is (it lists the first 15 agents; the replay has all of them);
   - one or two observations a reader would want, taken only from the table: for example the longest-running agent, agents running in parallel, failed tool calls, or the agent that used the most tokens. Don't guess beyond the numbers;
   - the file path, and what the file shows: a map of who started whom, a timeline bar per agent, and Play to replay it;
   - next steps: offer to open it in the browser, or to replay another session (`--list`). If the user mentions sharing it, warn them in one sentence that it contains their prompt text and the agents' reports, so they should read it first.

## If something goes wrong

- `No Claude Code transcripts found for <folder>`: the folder has never had a Claude Code session, or the user ran Claude Code from a different folder. Ask which folder, then pass `--project <folder>`.
- `No session starting with ...`: run `--list` and use one of the printed prefixes.
- `node` not found: Node.js 18+ is needed; tell the user to install it from nodejs.org.

## Live monitoring

This skill replays a finished (or running) session on request. For a page that follows every session live, with alerts when a session needs input, point the user to the free Agent Monitor plugin for Claude Code: https://github.com/omer-parvez/claude-agent-monitor
