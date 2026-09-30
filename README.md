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

## Requirements

- Pi `>= 0.87.0`
- Node.js `>= 22`

## License

MIT
