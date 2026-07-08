# cctokens

**Realtime token-usage & cost monitor for [Claude Code](https://claude.com/claude-code), right in your terminal.**

The Claude Code CLI doesn't show you how many tokens you've burned or what a session has cost. `cctokens` reads the transcripts Claude Code already writes to disk and turns them into a clear per-model, per-session, per-project breakdown — plus a live dashboard with a context-window gauge.

Zero dependencies. One file. Node 18+.

```
$ cctokens

  Claude Code — token usage & cost   2026-01-05 → 2026-01-12

  model               msgs    input   output  cache-w  cache-r    total       cost
  claude-opus-4-8     1204    2.10M    1.85M    18.4M   402.1M   424.5M    $342.11
  claude-haiku-4-5     318   540.2K   210.4K     3.1M    58.9M    62.8M      $8.40
  ────────────────────────────────────────────────────────────────────────────────
  TOTAL                       2.64M    2.06M    21.5M   461.0M   487.3M    $350.51
```

---

## Install

**Option A — global command (recommended)**

```sh
git clone https://github.com/rhysx19/cctokens.git
cd cctokens
npm install -g .        # makes `cctokens` available everywhere
```

**Option B — no install, run on demand**

```sh
npx github:rhysx19/cctokens
```

**Option C — a shell alias**

```sh
git clone https://github.com/rhysx19/cctokens.git ~/cctokens
echo 'alias cctokens="node ~/cctokens/bin/cctokens.js"' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
```

Nothing to configure — it finds your data at `~/.claude/projects`.

---

## Usage

```
cctokens [command]
```

| Command | What it shows |
| --- | --- |
| *(none)* | Global per-model totals — input, output, cache-write, cache-read, tokens, **cost** |
| `today` | Same table, today only |
| `this` | Just the session in the terminal you run it in (via `$CLAUDE_CODE_SESSION_ID`) |
| `session [N]` | The N most recent sessions (default 12), newest first |
| `session <name>` | One session by its name or id — e.g. `cctokens session "my refactor"` |
| `project` | Per-project totals and cost |
| `live` | Live global dashboard (context gauge, today, all-time), refreshes every 10s |
| `live this` | Live view of just this terminal's session |
| `live <name>` | Live view of one named session, with a "since watching" delta |
| `--json` | Machine-readable summary |
| `--help` | Full help |

### Live view

`cctokens live this` gives you a heads-up display for the session you're working in:

```
  ⬢ Claude Code — live · this session   14:22:07

  my-app · a1b2c3d4 · 3s ago
    context █████████████░░░░░░░░░░░░░░░░░ 431.2K / 1.00M 43%

    opus-4-8            21.6M  $23.94
    total               21.6M  $23.94  · 122 msgs

  since watching  +48.1K tokens  ·  +$0.31  ·  +4 msgs

  refreshing every 10s · Ctrl-C to quit
```

The context gauge shows how full the model's context window is — handy for knowing when you're approaching the point where Claude Code compacts the conversation.

> **Tip:** name your sessions in Claude Code (they're stored per-transcript), then `cctokens session <name>` and `cctokens live <name>` work from any terminal. `this` / `live this` need to be run inside a Claude Code session's shell, where `$CLAUDE_CODE_SESSION_ID` is set.

---

## How it works

Claude Code writes a JSONL transcript per session under `~/.claude/projects/`. Each assistant turn records a `usage` block. `cctokens` reads those and aggregates them, with a few things it gets right that a naive `jq` one-liner wouldn't:

- **Deduplication.** A turn is written to the transcript multiple times as it streams, and whole turns are re-logged into a new file when a session is resumed, forked, or compacted. `cctokens` dedupes globally by `message.id` + `requestId`, so nothing is double-counted.
- **Subagents included.** Token usage from subagents and workflows (under `subagents/`) is real, billed usage — it's counted and attributed to the parent session.
- **Cache tiers priced correctly.** Prompt-cache writes are billed at 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL; cache reads at 0.1×. `cctokens` reads the per-tier split from the logs rather than lumping it together.

### Pricing

Rates are USD per million tokens, from Anthropic's published model pricing:

| Model | Input | Output |
| --- | --- | --- |
| Opus 4.8 | $5 | $25 |
| Fable 5 | $10 | $50 |
| Sonnet 5 / 4.6 | $3 | $15 |
| Haiku 4.5 | $1 | $5 |

Cache write = 1.25× (5m) or 2× (1h) input · cache read = 0.1× input.

> **Costs are estimates** computed from public per-token rates, for your own bookkeeping — not a bill. If you use Claude Code on a subscription plan rather than API billing, the figures show the equivalent API value of what you used, not an amount you were charged.

Editing the `PRICING` / `CONTEXT` tables at the top of `bin/cctokens.js` is all it takes to add a model or adjust a rate.

---

## Requirements

- **Node.js 18+**
- Claude Code installed, with transcripts on disk at `~/.claude/projects` (macOS / Linux)

Set `NO_COLOR=1` to disable ANSI colors.

---

## License

[MIT](./LICENSE)
