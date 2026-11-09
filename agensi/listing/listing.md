# Agensi listing: session-replay

Copy each field into Agensi's "Submit a Skill" form. Upload `../dist/session-replay.zip` (build it with `node agensi/build.js`) and `logo.png`.

## Logo

`logo.png` (512 × 512). `logo-256.png` if a smaller one is asked for.

## Skill name

Session Replay for Claude Code

## Summary

Turn any Claude Code session into an offline HTML replay: every prompt, subagent and swarm on a map and a timeline, with start and finish times and token counts.

## Full description

Ever wondered what actually happened while Claude Code was working? One prompt can start five subagents, a code reviewer and a whole workflow swarm, and the chat only shows you the summary.

**Session Replay** turns a Claude Code session into a single HTML file you can open in any browser, replay like a video, and send to a colleague. Just ask: *"replay my last session"* or *"show me a timeline of what the agents did"*.

**What you see**

- **Every prompt you typed**, plus the questions Claude asked back and what you answered.
- **The map:** the main agent in blue, and every subagent and workflow agent it started in orange, each linked to whoever started it. Swarm agents show their own names and phases.
- **The timeline:** one bar per agent, from when it started to when it finished, with a tick for every tool call and red marks where something failed. Like a Gantt chart for your agents.
- **Times and tokens:** start and finish times, durations, tool calls and token counts (input, cache and output) per agent and per prompt.
- **Replay controls:** play, pause and scrub through the session as it happened. Click a prompt to see only the agents it set off.

**How it works**

The skill runs a small Node.js script (no packages) that reads the chosen session's transcript, which Claude Code already keeps on your computer, and writes one HTML file. Use `--list` to pick an older session by its first prompt.

**Private by design**

- Reads only the selected project's own Claude Code transcripts. Nothing else.
- No network calls, nothing installed, no settings changed.
- Keeps only tool names and one-line summaries, never file contents or command output.
- Anything that looks like a secret (tokens, passwords, API keys, URL query strings) is masked as `***`.

**Requirements:** Claude Code and Node.js 18 or newer.

**Want it live?** This skill replays a session on request. For a page that follows all your sessions in real time, with alerts when one needs your input, get the free Agent Monitor plugin: https://github.com/omer-parvez/claude-agent-monitor

## Tags

claude-code, subagents, agent-orchestration, timeline, visualization, workflow, debugging, observability, developer-tools

## Category

Develop → Agents & Orchestration

## Price

Free
