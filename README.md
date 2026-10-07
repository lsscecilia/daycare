# Daycare

A daycare for your AI agents. See what each one is doing and who's waiting on you, in your
terminal or in a cozy little room in your browser.

- Every Claude Code session on your Mac shows up by itself: working, waiting for you, or done.
- `daycare run "fix the flaky cart test"` hands a job to a helper. It works in its own git
  worktree, then the task lands on your desk to review.
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
daycare approve <task>       # done reviewing / done with your step
daycare focus 45             # hold notifications except urgent ones
daycare snap                 # screenshot a message (bind to ⌃⌥T in the Shortcuts app)
daycare help                 # everything else
```

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
