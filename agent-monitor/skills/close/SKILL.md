---
name: close
description: Stop the local agent monitor server, the live browser page of Claude Code sessions. Use when the user asks to close, stop or shut down the agent monitor.
---

# Close the agent monitor

1. Run this in the foreground (not in the background), using the base directory shown above this text:

   ```bash
   node "<base directory>/../../server.js" --stop
   ```

   If the user named a port, add it as the last argument. Default port: 7788.

2. Tell the user what its output line says, in one sentence:
   - `Agent monitor on port 7788 stopped.`: done.
   - `No agent monitor running on port 7788.`: it was already off.
   - `Port 7788 answered, but not as a monitor that can be stopped`: an older version is running. Pass on the line's advice.

This only stops the page. The logging hooks keep writing to `~/.claude/agent-monitor/events.jsonl`, so `/agent-monitor:open` later still shows everything that happened in between.
