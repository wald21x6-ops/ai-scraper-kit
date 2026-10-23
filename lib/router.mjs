// The router: picks the tool, keeps the books. Free tools always go first; a
// paid tool is reached only when every free one has failed AND the caller passed
// --paid — which the agent does only after the user has agreed to the cost.

import * as state from './state.mjs';
import fetchTool from './providers/fetch.mjs';
import chrome from './providers/chrome.mjs';
import firecrawl from './providers/firecrawl.mjs';
import scrapegraph from './providers/scrapegraph.mjs';
import apify from './providers/apify.mjs';

export const PROVIDERS = { fetch: fetchTool, chrome, firecrawl, scrapegraph, apify };
const NOT_A_WEBSITE = new Set(['search', 'actor']);   // targets that are queries or actor names: nothing to remember

export function formatCost(service, amount) {
  if (!state.SERVICES[service]) return 'free';
  return state.SERVICES[service].unit === 'usd' ? `$${Number(amount).toFixed(amount < 0.1 ? 4 : 2)}` : `${Math.round(amount * 100) / 100} credit${Math.round(amount * 100) === 100 ? '' : 's'}`;
}

/** The order the tools will be tried for this job on this website. */
export function ladder(job, target, { cfg = state.config(), providers = PROVIDERS } = {}) {
  let order = [...(cfg.routes[job] || [])];
  if (NOT_A_WEBSITE.has(job) || !target) return order;
  const { lastOk, benched } = state.remembered(target);
  order = order.filter((name) => !benched[name]);
  // What worked here before, then any standing preference, go first — but only
  // among the free tools: memory must never move a paid tool ahead of a free one.
  for (const first of [lastOk, cfg.prefer[state.domainOf(target)]]) {
    if (first && !benched[first] && providers[first] && !providers[first].paid) order = [first, ...order.filter((n) => n !== first)];
  }
  const isPaid = (n) => providers[n]?.paid;
  return [...order.filter((n) => !isPaid(n)), ...order.filter(isPaid)];
}

/** Every rung with a verdict. Makes no calls and spends nothing. */
export function plan(job, target, opts = {}, { providers = PROVIDERS, cfg } = {}) {
  return ladder(job, target, { cfg, providers }).map((name) => {
    const p = providers[name];
    const step = { provider: name, paid: !!p?.paid, usable: false, reason: '', cost: 0 };
    if (!p) return { ...step, reason: 'unknown tool' };
    if (!p.jobs.includes(job)) return { ...step, reason: `does not do ${job}` };
    if (opts.js && !p.runsJs) return { ...step, reason: 'cannot run --js' };
    const [ok, why] = p.available();
    step.cost = p.cost(job, opts);
    if (!ok) return { ...step, reason: why };
    if (p.paid) {
      const left = state.left(name);
      if (left < step.cost) return { ...step, reason: `only ${formatCost(name, Math.max(left, 0))} left` };
      return { ...step, usable: true, reason: `${formatCost(name, Math.max(left, 0))} left` };
    }
    return { ...step, usable: true, reason: why };
  });
}

const warned = new Set();
function warnIfLow(name, warn) {
  const q = state.quota(name);
  const left = state.left(name);
  if (warned.has(name) || !q || left >= 0.1 * q) return;
  warned.add(name);
  warn(`warning: ${state.SERVICES[name].label} is nearly out — ${formatCost(name, Math.max(left, 0))} of ${formatCost(name, q)} left.`);
}

/** Try the tools in order until one works. Returns { result, attempts }. */
export async function run(job, target, opts = {}, { providers = PROVIDERS, warn = (m) => console.error(m) } = {}) {
  const steps = plan(job, target, opts, { providers });
  const attempts = [];
  const skipped = steps.filter((s) => !s.usable).map((s) => `${s.provider}: ${s.reason}`);

  for (const step of steps.filter((s) => s.usable)) {
    const p = providers[step.provider];
    if (step.paid) {
      if (!opts.paid) {
        const label = state.SERVICES[step.provider].label;
        const why = attempts.length ? 'The free tools could not do this.' : 'Only paid tools can do this.';
        return {
          attempts,
          result: state.lost('router', job, target,
            `${why} Next option: ${label}, about ${formatCost(step.provider, step.cost)}. Ask the user; if they agree, run the same command again with --paid.`,
            'needs_paid', { data: { next: step.provider, cost: step.cost, unit: state.SERVICES[step.provider].unit } }),
        };
      }
      await p.sync?.().catch(() => {});        // their numbers, not ours, decide who can pay
      if (state.left(step.provider) < step.cost) { skipped.push(`${step.provider}: not enough left`); continue; }
      warnIfLow(step.provider, warn);
    }
    let result;
    try { result = await p.fetch(job, target, opts); }
    catch (err) { result = state.lost(step.provider, job, target, err.message, 'tool_error'); }
    state.log(result);
    attempts.push(result);
    if (!NOT_A_WEBSITE.has(job)) state.remember(target, step.provider, result.ok ? 'ok' : result.kind);
    if (result.ok) return { result, attempts };
  }
  if (attempts.length) return { result: { ...attempts.at(-1), error: [attempts.at(-1).error, ...skipped].join('; ') }, attempts };
  return { result: state.lost('router', job, target, `nothing can do this right now — ${skipped.join('; ') || `no route for ${job}`}`, 'no_tool'), attempts };
}

/** Before a batch: will `count` calls of this job finish, and what will it cost? Spends nothing. */
export function preflight(job, count, target, opts = {}, deps = {}) {
  const steps = plan(job, target, opts, deps);
  const free = steps.filter((s) => s.usable && !s.paid);
  const lines = [];
  let capacity = 0;
  let quote = '';
  for (const s of steps.filter((x) => x.paid)) {
    const left = Math.max(state.left(s.provider), 0);
    const covers = s.usable && s.cost > 0 ? Math.floor(left / s.cost) : 0;
    capacity += covers;
    if (!quote && s.usable) quote = `${state.SERVICES[s.provider].label}: about ${formatCost(s.provider, s.cost * count)} for ${count} (${formatCost(s.provider, s.cost)} each, ${formatCost(s.provider, left)} left)`;
    lines.push(`${s.provider}: ${formatCost(s.provider, s.cost)} each, covers ${covers} of ${count}${s.usable ? '' : ` (${s.reason})`}`);
  }
  if (free.length) return { covered: true, summary: `Free first (${free.map((s) => s.provider).join(', ')}). Paid is only needed for pages the free tools can't read.`, quote, lines };
  const covered = capacity >= count;
  return {
    covered, quote, lines,
    summary: covered ? `Paid only. ${quote}.` : `NOT COVERED: the paid tools together cover ${capacity} of ${count} — the batch would stop at number ${capacity + 1}.`,
  };
}

/** Ask every paid service for its real balance. */
export async function syncAll(providers = PROVIDERS) {
  await Promise.all(Object.values(providers).filter((p) => p.paid && p.sync).map((p) => p.sync().catch(() => {})));
}
