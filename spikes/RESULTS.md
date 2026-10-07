# Spike results — 2026-10-05

Claude Code 2.1.289, bun 1.3.14, macOS (Darwin 25.5.0). Raw logs weren't kept (they held personal paths and session ids). Hooks were passed per run with
`--settings`, so `~/.claude/settings.json` was never modified.

| # | Question | Result |
|---|---|---|
| 1 | One `Stop` per `claude -p` run? | **Yes.** A 4-turn run with 3 tool calls fired `SessionStart` once, `PostToolUse` ×3, `Stop` once, then `SessionEnd(other)` |
| 2 | Does a `PreToolUse` deny block the write, and does the agent adapt? | **Yes, and it adapts.** `locked.txt` wasn't created and there was no retry. The agent wrote the other file and explained the lock in its result. The denial also shows up in the run file under `permission_denials[]` |
| 3 | Does `--session-id` match the hook `session_id`? | **Yes**, on every event. `CS_DISPATCH` reaches every hook through the environment |
| 4 | What happens when `--max-budget-usd` is hit? | Exit code **1**. **No `Stop` and no `StopFailure`.** Only `SessionEnd(other)`. The run file has `is_error: true`, `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"` (written to stderr, not stdout) |
| 5 | Is the hook round trip under 15ms? | **No: p50 20.5ms, p95 21.1ms.** A compiled bun binary that does nothing already takes 14.4ms to start |
| 6 | ⌃⌥T Shortcut + screen permission, transcription quality | **Not run yet.** This needs you at the keyboard (see below) |

## What changes in the design

1. **Q4: `SessionEnd(other)` is ambiguous.** It fires both after a normal run (following
   `Stop`) and after a budget kill (with no `Stop`). The `SessionEnd` handler has to read
   the run file before it decides anything: `is_error` → `failed: <subtype>`. The run
   file is the authoritative result.
   - The run file goes to **stdout on success and stderr on error.** Dispatch has to
     capture both streams.
2. **Q4: the budget cap is soft.** The run spent **$0.117 against a $0.01 cap**, because
   the cap is only checked between turns. The first turn alone (loading about 15k tokens
   of context on Opus) cost more than the cap.
   - The `budget_usd` values in the templates (0.10 for transcribe, 0.50 for triage) were
     unrealistic.
   - Templates need a `model` field. Transcription and triage should run on a cheaper
     model.
   - Treat `budget_usd` as "stop after the turn that crosses this", not as a hard ceiling.
3. **Q2: Bash writes get around locks.** Only `Edit/Write/MultiEdit/NotebookEdit` are
   checked, so `echo > file` or `sed -i` from Bash would go straight through. Fix: after
   `Stop`, diff the worktree against the lock table and flag any write to a locked path in
   `NEEDS YOU TO SORT OUT`. That catches it after the fact, not before.
4. **Q5: raise the hook budget to 25ms.** About 20ms is bun's startup time plus one
   socket write. That's negligible next to tool calls that take seconds. If it ever
   matters, the fix is a lighter client, not a different design.
   - The spool fallback worked without being planned for: a bug in the first client made
     every connection fail, and all 150 events landed in the spool with none lost.
5. **Dispatched runs pick up all your global config.** Your claude.ai connectors (Gmail,
   Calendar…) and plugin hooks load into every `claude -p`. One run even commented on
   connector auth. Dispatch should pass `--strict-mcp-config`. **Never use `--bare`**: it
   skips hooks, so Daycare would see nothing.
6. **Write hooks in compiled TypeScript, not shell.** macOS ships bash 3.2, which
   silently ran a nested `$(... <<<...)` twice. At first every hook event looked like
   it fired twice. That was the test script, not Claude Code.

## Q6: run this yourself (about 5 minutes)

1. Open **Shortcuts** → New Shortcut → add **Run Shell Script** with:
   `<repo>/spikes/q6/tell-daycare.sh`
2. Shortcut details (ⓘ) → **Add Keyboard Shortcut** → press `⌃⌥T`.
3. Press `⌃⌥T` anywhere and drag over a Slack message.
   - You should get a "Daycare got it" notification, and a PNG in `~/.daycare/inbox/`.
   - If the PNG shows only the wallpaper and not the window, Shortcuts didn't get Screen
     Recording permission. Grant it in System Settings → Privacy & Security → Screen
     Recording, or bind the same script with Raycast or Hammerspoon.
4. Drop 5 real screenshots (Slack, Teams, email) into `~/.daycare/inbox/` and tell me.
   I'll run the transcribe step on them and count the mistakes.
