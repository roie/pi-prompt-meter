# pi-prompt-meter

A tiny Pi extension that shows how much time and model usage each prompt consumes.

```text
Working · 00:22 · ↑12k ↓640 R210k · $0.004 (sub)
```

The status changes to `Done`, `Canceled`, or `Error` when the prompt ends.

## Install

```bash
pi install npm:pi-prompt-meter
```

If Pi is already running:

```text
/reload
```

## Metrics

| | |
| --- | --- |
| `00:22` | Time spent on the prompt |
| `↑` | Input tokens |
| `↓` | Output tokens |
| `R` | Cache-read tokens |
| `W` | Cache-write tokens, when present |
| `$` | Estimated cost |

Each new prompt starts a fresh meter. The finished result stays visible until the next prompt starts. `/new` clears it.

## History

Run `/meter` in Pi's interactive TUI to browse prompt usage for the current project. History shows one month at a time:

```text
History   Trends
‹ September 2026 ›
```

Use left/right to page months. History groups each session as a summary row with its prompts permanently nested underneath, in a `/resume`-style scrollable list. Up/down selects prompts only; Enter jumps to the selected prompt's Pi session-tree location. New prompts use exact meter records. Older Pi sessions are reconstructed from saved history; approximate durations are marked with `≈`.

`Trends` keeps date as the primary unit and shows `Time`, `Input`, `Output`, `Cache`, `Cost`, and a Time-based activity bar together. The only control is range: `7d`/`30d` group by day, `3mo`/`6mo` by week, and `1y`/`All` by month.

## Requirements

- Pi `>= 0.99.2`
- Node.js `>= 22`
- `/meter` requires Pi's interactive TUI

## License

MIT
