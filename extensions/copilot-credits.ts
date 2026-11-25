/**
 * pi-copilot-credits: GitHub Copilot AI-credit tracker.
 *
 * GitHub bills credits in delayed whole-credit batches, so credits are ESTIMATED from
 * Pi's token usage × per-model prices from Copilot's /models (`billing.token_prices`).
 * - Under each response: estimated credits + tokens for that prompt.
 * - Footer: session · Pi this billing period (scanned from session files) · account from GitHub.
 *
 * Fails soft by design: dormant without a Copilot login (Codex, API keys, other providers),
 * silent in print/JSON mode, never blocks startup or a turn, and every network call is
 * time-limited and cancelled on shutdown. Problems appear in /copilot-credits, not as errors.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER = "github-copilot";
const KEY = "copilot-credits";
const QUOTA_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 10_000;
const PRICES_CACHE = join(getAgentDir(), "copilot-credits-prices.json");

// Credits per `batch` tokens; `max` = largest prompt the tier applies to.
type Tier = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; max?: number };
type Price = { batch: number; tiers: Tier[] };
type Quota = { used: number; entitlement: number; resetDate?: string };
type Tally = { credits: number; requests: number; unpriced: number; input: number; output: number; cacheRead: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const readJson = (file: string) => readFile(file, "utf8").then(JSON.parse, () => undefined);

const tier = (p: any): Tier => ({
  input: num(p.input_price),
  output: num(p.output_price),
  cacheRead: num(p.cache_price),
  cacheWrite: num(p.cache_write_price),
  cacheWrite1h: typeof p.cache_write_1h_price === "number" ? p.cache_write_1h_price : undefined,
  max: typeof p.context_max === "number" ? p.context_max : undefined,
});

const estimate = (p: Price | undefined, u: Usage) => {
  if (!Array.isArray(p?.tiers) || !p.tiers.length || !(p.batch > 0)) return undefined;
  const [input, output, cacheRead, cacheWrite, w1h] = [u.input, u.output, u.cacheRead, u.cacheWrite, u.cacheWrite1h].map(num);
  const prompt = input + cacheRead + cacheWrite;
  const t = p.tiers.find((t) => t.max === undefined || prompt <= t.max) ?? p.tiers[p.tiers.length - 1];
  return (input * t.input + output * t.output + cacheRead * t.cacheRead + (cacheWrite - w1h) * t.cacheWrite + w1h * (t.cacheWrite1h ?? t.cacheWrite)) / p.batch;
};

const empty = (): Tally => ({ credits: 0, requests: 0, unpriced: 0, input: 0, output: 0, cacheRead: 0 });
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const cr = (n: number) => (n < 10 ? n.toFixed(2) : n.toFixed(1));
const fmt = (t: Tally) =>
  `~${cr(t.credits)}cr${t.unpriced ? ` (+${t.unpriced} unpriced)` : ""} · ${t.requests} req · in ${k(t.input)} (cache ${k(t.cacheRead)}) · out ${k(t.output)}`;
const isCopilot = (m: any) => m?.role === "assistant" && m.provider === PROVIDER && m.usage && typeof m.model === "string";
// `pi --offline` / PI_OFFLINE: no automatic network activity (explicit /copilot-credits still fetches).
const offline = () => /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let active = false; // only with a Copilot login or after a Copilot response
  let gen = 0; // bumps on session start/shutdown; stale background work is discarded
  let abort = new AbortController();
  let refreshing: Promise<void> | undefined;
  let prices: Record<string, Price> = {};
  let quota: Quota | undefined;
  let quotaAt = 0;
  const errors: Record<string, string> = {};
  let session = empty();
  let month: Tally | undefined;
  let run: (Tally & { model: string }) | undefined;

  const getJson = async (url: string, headers: Record<string, string>) => {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };

  const add = (t: Tally, model: string, u: Usage) => {
    const c = estimate(prices[model], u);
    if (c === undefined || !Number.isFinite(c)) t.unpriced++;
    else t.credits += c;
    t.requests++;
    t.input += num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
    t.output += num(u.output);
    t.cacheRead += num(u.cacheRead);
  };

  const footer = () => {
    if (!ctx?.hasUI || !active) return;
    const parts = [`session ~${cr(session.credits)}cr`];
    if (month) parts.push(`pi month ~${cr(month.credits)}cr`);
    if (quota) parts.push(quota.entitlement > 0 ? `acct ${quota.used}/${quota.entitlement} (${Math.round((1 - quota.used / quota.entitlement) * 100)}% left)` : `acct ${quota.used} used`);
    else if (errors.quota) parts.push("acct n/a");
    if (errors.prices && !Object.keys(prices).length) parts.push("prices n/a");
    const text = `copilot · ${parts.join(" · ")}`;
    let styled = text;
    try {
      if (ctx.mode === "tui") styled = ctx.ui.theme.fg("dim", text); // themed in the terminal; plain for RPC clients
    } catch {}
    try {
      ctx.ui.setStatus(KEY, styled);
    } catch {}
  };

  // Run fn; on failure remember why (for /copilot-credits) and return undefined. Never throws.
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const v = await fn();
      delete errors[what];
      return v;
    } catch (e) {
      errors[what] = (e as Error)?.name === "TimeoutError" ? "timed out" : ((e as Error)?.message ?? String(e));
    }
  };

  const fetchPrices = async (c: ExtensionContext) => {
    const auth = (await c.modelRegistry.getProviderAuth(PROVIDER))?.auth;
    if (!auth?.apiKey || !auth.baseUrl) throw new Error("no Copilot token");
    const d = await getJson(`${auth.baseUrl}/models`, {
      Authorization: `Bearer ${auth.apiKey}`,
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Copilot-Integration-Id": "vscode-chat",
      "X-GitHub-Api-Version": "2026-06-01", // older versions omit token_prices
    });
    const out: Record<string, Price> = {};
    for (const m of Array.isArray(d?.data) ? d.data : []) {
      const tp = m?.billing?.token_prices;
      if (typeof m?.id === "string" && tp?.default) {
        out[m.id] = { batch: num(tp.batch_size) || 1e6, tiers: [tier(tp.default), ...(tp.long_context ? [tier(tp.long_context)] : [])] };
      }
    }
    if (!Object.keys(out).length) throw new Error("no token_prices in /models");
    return out;
  };

  const fetchQuota = async (): Promise<Quota> => {
    // Needs the GitHub OAuth token (Pi keeps it as the Copilot credential's `refresh`), or COPILOT_GITHUB_TOKEN.
    const cred = (await readJson(join(getAgentDir(), "auth.json")))?.[PROVIDER];
    const token = cred?.refresh ?? process.env.COPILOT_GITHUB_TOKEN;
    if (!token) throw new Error("no GitHub OAuth token");
    const host = cred?.enterpriseUrl ? `api.${String(cred.enterpriseUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "")}` : "api.github.com";
    const d = await getJson(`https://${host}/copilot_internal/user`, { Authorization: `token ${token}`, "User-Agent": "pi-copilot-credits" });
    const p = d?.quota_snapshots?.premium_interactions;
    if (!p) throw new Error("no credit quota on this plan");
    return { used: num(p.credits_used), entitlement: num(p.entitlement), resetDate: d.quota_reset_date_utc ?? d.quota_reset_date };
  };

  const loadPrices = async (c: ExtensionContext, network: boolean) => {
    const fresh = network ? await attempt("prices", () => fetchPrices(c)) : undefined;
    if (fresh) {
      prices = fresh;
      await writeFile(PRICES_CACHE, JSON.stringify(fresh)).catch(() => {});
    } else if (!Object.keys(prices).length) {
      const cached = await readJson(PRICES_CACHE); // offline / auth hiccup: last known prices
      if (cached && typeof cached === "object") prices = cached;
    }
  };

  const refreshQuota = async (force = false) => {
    if (!active || (!force && Date.now() - quotaAt < QUOTA_INTERVAL_MS)) return;
    quotaAt = Date.now();
    const g = gen;
    const q = await attempt("quota", fetchQuota);
    if (g === gen && q) quota = q;
    footer();
  };

  // Pi usage this billing period = every Copilot response in every session file since the period start.
  const scanMonth = async (c: ExtensionContext) => {
    const start = quota?.resetDate && !Number.isNaN(Date.parse(quota.resetDate)) ? new Date(quota.resetDate) : undefined;
    const since = start ? start.setUTCMonth(start.getUTCMonth() - 1) : new Date().setUTCDate(1);
    const periodStart = new Date(since).setUTCHours(0, 0, 0, 0);
    // Default layout is <sessions>/--<cwd>--/*.jsonl; a custom sessionDir holds files directly.
    const dir = c.sessionManager.getSessionDir();
    const root = /^--.*--$/.test(basename(dir)) ? dirname(dir) : dir;
    const t = empty();
    for (const rel of await readdir(root, { recursive: true }).catch(() => [] as string[])) {
      if (!rel.endsWith(".jsonl")) continue;
      const file = join(root, rel);
      if (((await stat(file).catch(() => undefined))?.mtimeMs ?? 0) < periodStart) continue;
      for (const line of (await readFile(file, "utf8").catch(() => "")).split("\n")) {
        if (!line.includes(PROVIDER)) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "message" && isCopilot(e.message) && Date.parse(e.timestamp) >= periodStart) add(t, e.message.model, e.message.usage);
        } catch {}
      }
    }
    return t;
  };

  const refreshAll = (c: ExtensionContext, network = true) =>
    (refreshing ??= (async () => {
      const g = gen;
      await Promise.all([loadPrices(c, network), network && refreshQuota(true)]);
      if (g !== gen) return;
      const s = empty();
      for (const e of c.sessionManager.getEntries() as any[]) if (e?.type === "message" && isCopilot(e.message)) add(s, e.message.model, e.message.usage);
      session = s;
      footer();
      // Rescan only while idle so responses arriving mid-scan are neither lost nor double counted.
      if (c.isIdle()) {
        const m = await attempt("scan", () => scanMonth(c));
        if (g === gen && m && c.isIdle()) month = m;
      }
      footer();
    })().finally(() => (refreshing = undefined)));

  pi.on("session_start", (_e, c) => {
    gen++;
    ctx = c;
    run = undefined;
    session = empty();
    month = undefined;
    if (!c.hasUI) return; // print/JSON mode: nothing to show, don't hold the process open
    let configured = false;
    try {
      configured = c.modelRegistry.getProviderAuthStatus(PROVIDER).configured;
    } catch {}
    active = configured;
    if (!active) {
      c.ui.setStatus(KEY, undefined); // Codex / API-key / other-provider users: stay dormant
      return;
    }
    void refreshAll(c, !offline()); // background: never delays startup
  });

  pi.on("before_agent_start", () => {
    run = undefined;
  });

  pi.on("message_end", (e, c) => {
    try {
      if (!c.hasUI || !isCopilot(e.message)) return;
      const m = e.message as any;
      ctx = c;
      if (!active) {
        active = true; // Copilot used without a stored login (e.g. env token)
        void refreshAll(c, !offline());
      }
      run ??= { ...empty(), model: m.model };
      run.model = m.model;
      for (const t of [run, session, month]) if (t) add(t, m.model, m.usage);
      footer();
    } catch {}
  });

  // Per-prompt line under the response, once tools/retries are done.
  pi.on("agent_settled", (e, c) => {
    try {
      ctx = c;
      if (run && !e.aborted && c.hasUI) c.ui.notify(`copilot · ${fmt(run)} · ${run.model}`, "info");
      if (!offline()) void refreshQuota();
    } catch {}
  });

  pi.on("session_shutdown", () => {
    gen++;
    abort.abort(); // cancel in-flight requests so shutdown/reload never waits on the network
    abort = new AbortController();
    ctx = undefined;
  });

  pi.registerCommand(KEY, {
    description: "Show GitHub Copilot credit + token usage",
    handler: async (_args, c) => {
      ctx = c;
      active = true;
      await refreshAll(c);
      const lines = [
        run ? `Last prompt: ${fmt(run)} · ${run.model}` : "Last prompt: none yet",
        `Session: ${fmt(session)}`,
        `Pi this period: ${month ? fmt(month) : "n/a"}`,
        quota
          ? `Account (GitHub, lags minutes): ${quota.used} / ${quota.entitlement || "∞"} used${quota.resetDate ? ` · resets ${quota.resetDate.slice(0, 10)}` : ""}`
          : "Account: unavailable",
        `Prices: ${Object.keys(prices).length} models (estimates)${errors.prices && Object.keys(prices).length ? " · using cached prices" : ""}`,
        ...Object.entries(errors).map(([w, m]) => `⚠ ${w}: ${m}`),
      ];
      c.ui.notify(lines.join("\n"), Object.keys(errors).length ? "warning" : "info");
    },
  });
}
