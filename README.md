# pi-copilot-credits

Track GitHub Copilot **AI credits** in [pi](https://pi.dev), using the pi-tps layout:

- **Under each response:** estimated credits and tokens for that prompt
  ```
  copilot · ~3.09cr · 2 req · in 48.2k (cache 45.1k) · out 620 · claude-opus-5.5
  ```
- **Footer:** session, Pi usage this billing period, and the account balance from GitHub
  ```
  copilot · session ~41.2cr · pi month ~512.7cr · acct 4958/18000 (72% left)
  ```
- **`/copilot-credits`:** full breakdown, including the reset date

## Install

```bash
pi install npm:pi-copilot-credits
# or from GitHub
pi install git:github.com/levyashvin/pi-copilot-credits
# or try once
pi -e npm:pi-copilot-credits
```

You need to be logged in to GitHub Copilot in pi (`/login`). Only `github-copilot` provider requests are counted.

## How it works

GitHub bills credits in **delayed, whole-credit batches**, sometimes minutes after a request. Measuring the balance before and after a request therefore does not work. Instead:

| Value | Source |
|---|---|
| Per prompt / session | Pi token usage × prices from Copilot `/models` (estimate, `~`) |
| Pi month | Every Copilot response in your Pi session files since the billing period started. Rescanned at startup and on `/copilot-credits`; no extra state |
| Account | GitHub `copilot_internal/user` → `premium_interactions.credits_used / entitlement` (authoritative, lags) |

Cache tokens matter. A cache miss on a large context can cost 10× a cache hit, so cached input and cache writes are priced separately.

All data stays local. The extension uploads nothing. It makes two read-only calls with Pi's existing Copilot login:

- `GET api.github.com/copilot_internal/user` reads your credit balance. It runs at session start and at most every 30 s after a response.
- `GET <copilot-api>/models` reads token prices once per session start.

Both calls run in the background with a 10 s timeout, so they never delay startup. Failures show as `⚠` in the footer.

## Prices

Prices are **fetched automatically** from your Copilot account's `/models` endpoint (`billing.token_prices`, API version `2026-06-01`), using Pi's existing Copilot login. That gives every model your plan can use, including:

- long-context tiers, where prompts above a model's threshold are billed at higher rates
- separate 1-hour cache-write prices
- free (0-credit) models

The last fetched prices are cached in `~/.pi/agent/copilot-credits-prices.json`, so estimates keep working offline. Models without a price show as `(+N unpriced)`.

## Failure behaviour

It degrades quietly and never blocks Pi:

| Situation | Behaviour |
|---|---|
| No Copilot login (Codex, API keys, other providers) | Dormant: no footer, no network calls |
| Copilot via `COPILOT_GITHUB_TOKEN` and no stored login | Activates on the first Copilot response |
| Print / JSON mode (`pi -p`) | Does nothing, so the process exits immediately |
| `pi --offline` / `PI_OFFLINE=1` | No automatic network calls; uses cached prices and local sessions. `/copilot-credits` still fetches on request |
| Offline, or the price fetch fails | Uses the last cached prices; the footer shows `acct n/a` if the balance can't be read |
| Network hangs | Every request gives up after 10 s; startup and turns never wait |
| Exit or `/reload` mid-request | In-flight requests are cancelled |
| Token revoked or expired (401), proxy errors | Shown in `/copilot-credits`, never as a Pi error |
| GitHub Enterprise (`*.ghe.com`) | Reads the balance from your enterprise API host |

## Caveats

- `copilot_internal/user` and `/models` billing fields are undocumented and may change.
- Credit figures are estimates. Check them against the account number, which is authoritative.
- The account figure includes Copilot usage outside pi, such as VS Code and github.com.

## License

MIT
