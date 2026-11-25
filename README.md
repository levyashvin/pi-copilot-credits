# pi-copilot-credits

Track GitHub Copilot AI credits in [pi](https://pi.dev).

> **Note:** Tested only with org-managed GitHub Copilot (Business/Enterprise) accounts and intended for those only. Individual plans (Free/Pro/Pro+) may not work.

```
copilot · ~3.09cr · 2 req · in 48.2k (cache 45.1k) · out 620 · claude-opus-5.5    ← under each response
copilot · session ~41.2cr · pi month ~512.7cr · acct 4958/18000 (72% left)         ← footer
```

`/copilot-credits` shows the full breakdown.

## Install

```bash
pi install npm:pi-copilot-credits
```

Requires a GitHub Copilot login in pi (`/login`).

## How it works

- **Credits are estimates:** token usage × model prices from your Copilot account. GitHub bills in delayed batches, so per-request numbers can't come from GitHub directly.
- **Pi month** is scanned from your local session files.
- **Account** is GitHub's own figure. It can lag by a few minutes and includes usage outside pi.
- **Fails soft:** inactive without a Copilot login, respects `--offline`, never blocks pi.
- **Local only:** nothing is uploaded.

Uses undocumented GitHub endpoints that may change.

## License

MIT
