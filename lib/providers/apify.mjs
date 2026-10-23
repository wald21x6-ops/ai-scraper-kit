// Apify (apify.com): thousands of ready-made scrapers ("actors") for Google Maps,
// Google search, Instagram, TikTok, Facebook ads, LinkedIn, Amazon and more.
// Free plan: $5 of usage a month, no card. Money here is real US dollars, so every
// run carries a hard cap that Apify itself enforces (maxTotalChargeUsd).

import { accounts, config, lost, setUsage, won } from '../state.mjs';
import { http, message, withAccounts } from './paid.mjs';

const BASE = 'https://api.apify.com/v2';
const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const timing = { settleMs: 2500, settleTries: 8 };   // tests set settleMs to 0
const OUT_OF_CREDIT = /usage limit|monthly usage|exceeded|insufficient|not enough|credit|quota/i;

/** A short name from the config, or any full id; Apify's API spells ids user~name. */
export const actorId = (name, cfg = config()) => (name ? String(cfg.apify.actors[name] || name).replace('/', '~') : '');

/** What a finished run cost. Pay-per-event actors settle usageTotalUsd a few
 * seconds late, so the charged events are priced from the run's own price list too. */
export function runUsd(run = {}) {
  const events = run.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let priced = 0;
  for (const [name, count] of Object.entries(run.chargedEventCounts || {})) {
    const e = events[name] || {};
    priced += Number(count || 0) * Number(e.eventPriceUsd ?? e.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd ?? 0);
  }
  return Math.max(priced, Number(run.usageTotalUsd) || 0);
}

function kind(status, error) {
  if ((status === 402 || status === 403) && OUT_OF_CREDIT.test(error)) return 'out_of_credit';
  if (status === 401) return 'bad_key';
  return status > 0 ? `http_${status}` : 'actor_error';
}

/** Start a run, wait for it, read its results. Never leaves a run going: one past the time limit is aborted. */
export async function runActor(key, actor, input, { maxUsd, maxItems } = {}) {
  const query = new URLSearchParams({ waitForFinish: '60', ...(maxUsd ? { maxTotalChargeUsd: String(maxUsd) } : {}), ...(maxItems ? { maxItems: String(maxItems) } : {}) });
  const start = await http(`${BASE}/acts/${encodeURIComponent(actor)}/runs?${query}`, { method: 'POST', headers: auth(key), body: input });
  if (start.status >= 400 || start.status < 0) return { status: start.status, error: message(start.json, start.status), usd: 0 };
  let run = start.json?.data || {};
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (['READY', 'RUNNING'].includes(run.status)) {
    if (Date.now() > deadline) {
      await http(`${BASE}/actor-runs/${run.id}/abort`, { method: 'POST', headers: auth(key) });
      return { status: -2, error: `run still going after ${RUN_TIMEOUT_MS / 60000} minutes, so it was stopped`, usd: runUsd(run) };
    }
    const poll = await http(`${BASE}/actor-runs/${run.id}?waitForFinish=60`, { headers: auth(key), timeout: 90000 });
    if (poll.status !== 200) { await sleep(5000); continue; }
    run = poll.json.data;
  }
  // A pay-per-event bill settles up to ~20 s after the run ends (2026-10-24: a Google search
  // read $0.0001 at the finish and $0.0046 twenty seconds later). Re-read until a real charge
  // shows up, so the cost we record and report is the one Apify bills.
  let usd = runUsd(run);
  const billed = (r) => Object.entries(r.chargedEventCounts || {}).some(([e, n]) => n > 0 && e !== 'apify-actor-start');
  for (let i = 0; i < timing.settleTries && run.pricingInfo?.pricingModel === 'PAY_PER_EVENT' && !billed(run); i++) {
    await sleep(timing.settleMs);
    const again = await http(`${BASE}/actor-runs/${run.id}`, { headers: auth(key), timeout: 20000 });
    if (again.status === 200) { run = again.json.data; usd = Math.max(usd, runUsd(run)); }
  }
  if (run.status !== 'SUCCEEDED') return { status: -2, error: `run ${run.status}: ${run.statusMessage || 'no reason given'}`, usd };
  const items = await http(`${BASE}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, { headers: auth(key) });
  if (items.status !== 200 || !Array.isArray(items.json)) return { status: -2, error: 'the run finished but its results would not load', usd };
  return { status: 0, items: items.json, usd, runId: run.id };
}

/** An actor's price list, free to look up. */
export async function price(name) {
  const id = actorId(name);
  let res = await http(`${BASE}/acts/${encodeURIComponent(id)}`, { timeout: 20000 });
  if (res.status !== 200 && accounts('apify')[0]) res = await http(`${BASE}/acts/${encodeURIComponent(id)}`, { headers: auth(accounts('apify')[0].key), timeout: 20000 });
  if (res.status !== 200) return { id, error: message(res.json, res.status) };
  const d = res.json.data;
  const info = (d.pricingInfos || []).at(-1) || {};
  const events = Object.entries(info.pricingPerEvent?.actorChargeEvents || {}).map(([event, e]) => ({
    event, title: e.eventTitle, usd: Number(e.eventPriceUsd ?? e.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd ?? 0), primary: !!e.isPrimaryEvent,
  })).filter((e) => e.usd > 0);
  return { id, title: d.title, model: info.pricingModel || 'platform usage', perUnitUsd: info.pricePerUnitUsd, minCapUsd: info.minimalMaxTotalChargeUsd, events };
}

/** Search the Apify store, free. */
export async function find(query) {
  const res = await http(`${BASE}/store?${new URLSearchParams({ search: query, limit: '8', sortBy: 'popularity' })}`, { timeout: 20000 });
  if (res.status !== 200) return { error: message(res.json, res.status), items: [] };
  return {
    items: (res.json.data?.items || []).map((a) => {
      const info = a.currentPricingInfo || {};
      const primary = Object.values(info.pricingPerEvent?.actorChargeEvents || {}).find((e) => e.isPrimaryEvent) || Object.values(info.pricingPerEvent?.actorChargeEvents || {})[0];
      const usd = primary ? Number(primary.eventPriceUsd ?? primary.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd ?? 0) : null;
      return { id: `${a.username}/${a.name}`, title: a.title, users: a.stats?.totalUsers, price: usd != null ? `$${usd} per ${primary.eventTitle || 'result'}` : (info.pricingModel || 'platform usage') };
    }),
  };
}

export default {
  name: 'apify',
  jobs: ['search', 'actor'],
  paid: true,
  available: () => (accounts('apify').length ? [true, `${accounts('apify').length} key(s)`] : [false, 'no key yet']),

  // Expected cost, for plans and warnings. A Google search page is $0.0045 plus a start fee.
  cost: (job, opts = {}) => (job === 'search' ? 0.005 : Number(opts.maxUsd) || config().apify.max_usd_per_run),

  async sync() {
    const cap = config().apify.max_usd_per_month;
    for (const { slot, key } of accounts('apify')) {
      const { status, json } = await http(`${BASE}/users/me/limits`, { headers: auth(key), timeout: 20000 });
      const d = json?.data;
      if (status !== 200 || !d) continue;
      const end = Date.parse(d.monthlyUsageCycle?.endAt);
      setUsage('apify', slot, {
        quota: Math.min(Number(d.limits?.maxMonthlyUsageUsd) || cap, cap),
        used: Number(d.current?.monthlyUsageUsd) || 0,
        resets_on: Number.isFinite(end) ? new Date(end + 864e5).toISOString().slice(0, 10) : null,
      });
    }
  },

  async fetch(job, target, opts = {}) {
    const cfg = config();
    const actor = job === 'search' ? actorId('search', cfg) : actorId(opts.actor, cfg);
    if (!actor) return lost('apify', job, target, 'name an actor: a short name from the config or a full id like apify/instagram-scraper', 'bad_input');
    let input = opts.input;
    if (job === 'search') input = { queries: target, maxPagesPerQuery: 1, ...(opts.country ? { countryCode: opts.country } : {}) };
    else if (!input && /^https?:\/\//.test(target)) input = { startUrls: [{ url: target }] };
    if (!input) return lost('apify', job, target, 'this actor needs its input: --input file.json or --input-json', 'bad_input');
    const cap = Number(opts.maxUsd) || cfg.apify.max_usd_per_run;

    return withAccounts('apify', job, target, cap, async ({ key }) => {
      const t0 = Date.now();
      const r = await runActor(key, actor, input, { maxUsd: cap, maxItems: opts.maxItems });
      const ms = Date.now() - t0;
      const usd = Math.round(r.usd * 10000) / 10000;
      if (r.status !== 0) return lost('apify', job, target, r.error, kind(r.status, r.error), { ms, cost: usd });
      // Many actors "succeed" with nothing but an error row (bad input, a minimum not met). That is a failure.
      const errorsOnly = r.items.length > 0 && r.items.every((i) => i && typeof i === 'object' && 'error' in i && Object.keys(i).length <= 2);
      if (errorsOnly) return lost('apify', job, target, `the actor refused: ${String(r.items[0].error).slice(0, 300)}`, 'actor_error', { ms, cost: usd });
      if (job === 'search') {
        const rows = r.items.flatMap((page) => page.organicResults || []).slice(0, Number(opts.n) || 10)
          .map(({ url, title, description }) => ({ url, title, description }));
        if (!rows.length) return lost('apify', job, target, 'no results', 'empty', { ms, cost: usd });
        return won('apify', job, target, { content: JSON.stringify(rows, null, 2), data: rows, cost: usd, ms });
      }
      return won('apify', job, target, { content: JSON.stringify(r.items, null, 2), data: { actor, count: r.items.length, usd, items: r.items }, cost: usd, ms });
    });
  },
};
