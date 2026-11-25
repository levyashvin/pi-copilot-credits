# Changelog

## [0.1.0] - 2026-11-24

- Initial release.
- Per-prompt credit estimate and token counts under each response.
- Footer with session, Pi-this-period (scanned from session files), and GitHub account credit totals.
- `/copilot-credits` command with a full breakdown.
- Token prices fetched automatically from Copilot `/models` (`billing.token_prices`), including long-context tiers and 1h cache-write prices. The last known prices are cached for offline use.
- Fails soft: dormant without a Copilot login, silent in print mode, 10 s timeouts, cancels in-flight requests on shutdown, falls back to cached prices offline, supports GitHub Enterprise, respects `pi --offline`.
