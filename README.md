# Daycare

A daycare for your AI agents. See what each one is doing and who's waiting on you, in your
terminal or in a cozy little room in your browser.

- Every Claude Code session on your Mac shows up by itself: working, or "your turn" with
  what it needs from you. A long reply gets a short summary under the helper in the room
  (a few words, up to three points, and what's next). The full reply stays in its terminal.
- `daycare run "fix the flaky cart test"` hands a job to a helper. It works in its own git
  worktree, then the task lands on your desk to review. Send it follow-ups in the same
  conversation with `daycare tell`, or by clicking it in the room.
- Two sessions can't edit the same file at once. A helper stuck in a loop gets stopped.
  A helper that crashes gets flagged.
- Screenshot a message (⌃⌥T, or paste it into the UI). Daycare reads it on your Mac, runs
  read-only checks, and drafts a reply. It never sends anything itself.
- It works with your company's AI tool too (see below).

## Install (macOS)

```bash
./install.sh          # builds ~/.local/bin/daycare, then runs `daycare setup`
```

`daycare setup` asks before each step: Claude Code hooks (merged into
`~/.claude/settings.json` and tagged, with a backup), a background daemon for the UI, the
screenshot reader, and a test notification. `daycare uninstall` removes the hooks and the
daemon.

## Use

```bash
daycare                      # the board
daycare ui                   # the room
daycare run "<what to do>"   # give a helper a job
daycare tell <task> "<text>" # follow-up for a helper (queued if it's mid-run)
daycare approve <task>       # done reviewing / done with your step
daycare focus 45             # hold notifications except urgent ones
daycare snap                 # screenshot a message (bind to ⌃⌥T in the Shortcuts app)
daycare help                 # everything else
```

In the room, type a job in the box at the top and pick a repo, or type a `daycare` command.
Click a helper or task card and the box talks to that helper instead. Click one of your own
terminal sessions and **Go to it** switches to its Terminal or iTerm tab.

## Use your company's AI tool

```bash
daycare provider new acme           # writes ~/.daycare/providers/acme.yaml from a template
daycare provider test acme --work   # checks it, and says what Daycare may use it for
```

Or let your coding agent do it: link `skills/daycare-connect` into `~/.claude/skills/`
(or wherever your tool loads skills from) and ask it to "connect <tool> to Daycare".
Then set the roles in `~/.daycare/config.yaml`.

## Develop

```bash
bun install
bun test              # unit tests
bunx tsc --noEmit     # types
bun src/cli.ts        # run from source
DAYCARE_HOME=/tmp/t DAYCARE_PORT=7799 bun src/cli.ts …   # a sandbox that leaves your real setup alone
```

The design and its reasoning are in `docs/design.md`. Measured facts about Claude Code's
hooks are in `spikes/RESULTS.md`.
