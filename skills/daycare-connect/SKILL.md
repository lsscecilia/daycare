---
name: daycare-connect
description: Connect a company's internal AI tool to Daycare, so Daycare can use it to read messages, write notes, or work as a helper instead of (or alongside) Claude Code. Use when someone says "connect our internal AI to Daycare", "use <tool> with Daycare", "daycare provider", or sets up Daycare at a company that has its own AI tool.
---

# Connect an AI tool to Daycare

Daycare talks to AI tools through a **provider file**, `~/.daycare/providers/<name>.yaml`. It
says how to run the tool and how to read its answer. Your job is to write that file for
the person's tool, prove it works with the probe, and tell them what Daycare can now use it
for. The template with every field explained is `providers/_template.yaml` in the Daycare
repo, and `providers/claude.yaml` is a complete working example.

Daycare uses a provider in up to two ways:

- **ask** (required): text in, text out, **no tools**. Daycare uses this to read screenshots
  (already turned into text on the Mac, so images never leave the machine), check
  messages, and write notes. The tool must not be able to run commands or edit files in
  this mode. The messages come from other people and may contain instructions aimed at
  the AI.
- **work** (optional): the tool does a coding task in a folder, then exits by itself.
  This lets Daycare dispatch it as a helper.

## Step 1: Find out what the tool is

Ask the person, in one message:

1. What's the tool called, and how do they normally use it: a terminal command, a web
   page, an IDE plugin, or a chat bot?
2. If it's a terminal command, what's the command name?
3. Should Daycare use it for **reading messages**, as a **helper that writes code**, or both?
4. Is there a company rule about which AI tool may see work chat? If the rule is
   "internal tool only", the internal tool has to handle `ask`.

Then follow the path that matches.

### Path A: it has a command-line tool

Read its help before guessing anything:

```bash
<tool> --help
<tool> help <subcommand>     # for each subcommand that looks like "chat", "ask", "run", "agent"
```

You're looking for:

| Need | Look for words like | Goes into |
|---|---|---|
| Run one prompt and exit (no chat window) | `-p`, `--print`, `--prompt`, `run`, `exec`, `--non-interactive`, `--headless` | `ask.argv`, `work.argv` |
| Where the prompt goes | reads stdin, `--prompt-file`, or a positional argument | `prompt_via` |
| Machine-readable output | `--json`, `--output-format json`, `-o json` | `output.format`, `output.result` |
| Turn tools off | `--no-tools`, `--tools ""`, `--read-only`, `--chat-only`, `--sandbox read-only` | `ask.argv` |
| Edit files without asking | `--yes`, `--auto-approve`, `--accept-edits`, `--full-auto`, `--dangerously-*` | `work.argv` |
| Resume a conversation | `--resume <id>`, `--continue`, `--session` | `work.resume`, `output.session` |
| Pick a cheaper model | `--model` | `ask.argv` |

If you can't find a way to turn tools off, say so plainly. Daycare won't use the tool for
messages without one. It can still be a helper.

To see the output shape, run one harmless prompt yourself, for example
`echo "Reply with OK" | <tool> <flags>`. Ask first if the tool bills per use. If the
output is JSON, find the field that holds the reply text and use its dotted path for
`output.result`.

### Path B: there's an HTTP API (or a web tool with an API behind it)

Daycare needs a command, so write a small wrapper script at `~/.daycare/bin/<name>`. It reads
the prompt on stdin, calls the API, and prints the reply. Rules:

- **Never put a token in the script or the YAML.** Read it from Keychain:
  `security find-generic-password -s <name>-daycare -w`. Tell the person the exact
  `security add-generic-password -s <name>-daycare -a "$USER" -w` command to store it
  themselves. Don't ask them to paste the token to you.
- Send only the prompt. Don't send any tool definitions, so the API can't call tools.
- Exit non-zero on an HTTP error, and print the error to stderr.
- Ask the person for the endpoint, the request shape, and the auth header. If they don't
  know, ask for an internal docs link or a sample `curl` command. Don't invent an API.

An API wrapper can only be an `ask` provider. Leave out `work`.

### Path C: it's only a web page, IDE plugin or chat bot

Daycare can't drive it. Say so plainly, and suggest the realistic options:

- ask the tool's team whether a CLI or API exists (many internal tools have one that isn't
  well known)
- use Claude Code for `ask` if company policy allows it
- treat that tool's work as manual steps on the board

Don't try to automate a browser or a GUI. It's fragile, and it may break company policy.

## Step 2: Write the provider file

Run `daycare provider new <name>`. It writes `~/.daycare/providers/<name>.yaml` from the template; fill it in.
Rules that matter:

- `argv` is a list. Every flag and value is its own item. Never write a shell string, a
  pipe, or `$(...)`. Daycare doesn't use a shell, so those won't work, and that's
  deliberate.
- `ask.argv` must include the turn-tools-off flag.
- `work.argv` must include the no-confirmation flag, or the tool will sit waiting for
  someone to type "y". (The probe catches this.)
- Set `governance: none`. Only Claude Code supports `claude-hooks`.

## Step 3: Prove it

```bash
daycare provider test <name>          # ask checks only
daycare provider test <name> --work   # also the helper check
```

Ask before running `--work`, because it lets the tool create a file in a throwaway git
repo. The probe prints ✓ or ✗ per check, with a hint (→) for each failure. Fix the file
and run it again until it passes, or until you've found something the tool genuinely
can't do.

What the results mean:

| Tier | Daycare can use it for |
|---|---|
| **Full** | everything, with file locks, loop detection and budget caps (Claude Code only) |
| **Watched** | messages, notes, and as a helper in its own worktree. Daycare restarts or stops it on timeouts, but can't lock files or spot loops |
| **Text only** | messages and notes |
| **Not usable yet** | nothing until the ✗ checks pass |

Never edit the probe to make a check pass. If a check fails because the tool really can't
do something, say what it can't do.

## Step 4: Assign roles

Add the provider to `~/.daycare/config.yaml`. Keep any providers that are already there:

```yaml
providers:
  messages: <name>          # reads screenshots and drafts replies
  notes: <name>             # recovery notes and briefings
  workers: [claude, <name>] # who `daycare dispatch` may use; a template step can pick one
```

## Step 5: Tell the person

Keep it short:

- the tier, and what Daycare will now use the tool for
- anything it can't do, and what that means for them. For example: "It can't run without
  asking for permission, so it can't be a helper. Messages work."
- the one command to re-check it later: `daycare provider test <name>`
