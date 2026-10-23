// Everything the kit keeps on disk, and the rules for reading it.
//
// Code lives in the repo; the user's data lives in <kit>/data/ (git-ignored),
// so `git pull` updates the code and never touches keys, budgets or history.
//
//   data/keys.env     the API keys. Read at call time, never printed or logged.
//   data/budget.json  per provider and account: allowance, used, refill date.
//   data/memory.json  per website: which tool worked, which one got blocked.
//   data/log.jsonl    one line per call: tool, job, ok, cost. The ledger.
//   data/config.json  optional overrides of DEFAULTS below.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
export const dataDir = () => process.env.SCRAPER_KIT_DATA || join(KIT, 'data');
export const dataFile = (name) => join(dataDir(), name);

// Where to get each key. Free plans, checked 2026-10-24.
export const SERVICES = {
  firecrawl: {
    label: 'Firecrawl', unit: 'credits', free: 1000, keys: ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_2', 'FIRECRAWL_API_KEY_3'],
    signup: 'https://www.firecrawl.dev/app/api-keys', prefix: 'fc-',
    plan: '1,000 credits every month, no card',
  },
  apify: {
    label: 'Apify', unit: 'usd', free: 5, keys: ['APIFY_TOKEN', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3'],
    signup: 'https://console.apify.com/settings/integrations', prefix: 'apify_api_',
    plan: '$5 of usage every month, no card',
  },
  scrapegraph: {
    label: 'ScrapeGraph', unit: 'credits', free: 500, keys: ['SGAI_API_KEY'],
    signup: 'https://scrapegraphai.com/dashboard', prefix: 'sgai-',
    plan: '500 credits, one time',
  },
};

export const DEFAULTS = {
  // Cheapest first. A paid rung runs only after the free ones failed AND the
  // caller passed --paid (which the agent does only after the user said yes).
  routes: {
    static: ['fetch', 'chrome', 'firecrawl', 'scrapegraph'],
    rendered: ['chrome', 'firecrawl', 'scrapegraph'],
    hard: ['chrome', 'firecrawl', 'scrapegraph'],
    extract: ['firecrawl', 'scrapegraph'],
    search: ['firecrawl', 'apify', 'scrapegraph'],
    crawl: ['firecrawl'],
    actor: ['apify'],
  },
  // Domain -> tool to try first, whatever the job. Facebook blocks the plain
  // fetch but serves a real Chrome logged out (Ad Library, page Intro boxes).
  prefer: { 'facebook.com': 'chrome' },
  apify: {
    actors: {
      search: 'apify~google-search-scraper',
      google_maps: 'compass~crawler-google-places',
      facebook_ads: 'curious_coder~facebook-ads-library-scraper',
      instagram: 'apify~instagram-scraper',
    },
    max_usd_per_run: 0.5,    // hard cap Apify enforces on every run unless --max-usd says otherwise
    max_usd_per_month: 5,    // never plan to spend past the free $5, even on a paid Apify plan
  },
  memory_days: 7,
};

const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; }
};
const write = (name, value) => {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2) + '\n');
};

export function config() {
  const own = read('config.json', {});
  return {
    ...DEFAULTS, ...own,
    routes: { ...DEFAULTS.routes, ...own.routes },
    prefer: { ...DEFAULTS.prefer, ...own.prefer },
    apify: { ...DEFAULTS.apify, ...own.apify, actors: { ...DEFAULTS.apify.actors, ...own.apify?.actors } },
  };
}

// ---------------------------------------------------------------- keys

export function readKeys() {
  const out = {};
  try {
    for (const line of fs.readFileSync(dataFile('keys.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no file yet */ }
  for (const name of Object.values(SERVICES).flatMap((s) => s.keys)) {
    if (process.env[name]) out[name] = process.env[name];
  }
  return out;
}

/** [{slot: '1', key}] for every key of this service that is filled in. */
export function accounts(service) {
  const keys = readKeys();
  return SERVICES[service].keys.map((name, i) => ({ slot: String(i + 1), key: keys[name] })).filter((a) => a.key);
}

// ---------------------------------------------------------------- budget

export const loadBudget = () => read('budget.json', {});

/** One account's row, with the free-plan default until the service has been asked. */
export function slotRow(budget, service, slot) {
  return budget[service]?.[slot] ?? { quota: SERVICES[service].free, used: 0, resets_on: null };
}

/** What is left across the accounts that have keys. Refills whose date has passed count as full. */
export function left(service, budget = loadBudget()) {
  const today = new Date().toISOString().slice(0, 10);
  return accounts(service).reduce((sum, { slot }) => {
    const row = slotRow(budget, service, slot);
    return sum + (row.resets_on && row.resets_on <= today ? row.quota : row.quota - row.used);
  }, 0);
}

export function slotLeft(service, slot, budget = loadBudget()) {
  const row = slotRow(budget, service, slot);
  const today = new Date().toISOString().slice(0, 10);
  return row.resets_on && row.resets_on <= today ? row.quota : row.quota - row.used;
}

export function quota(service, budget = loadBudget()) {
  return accounts(service).reduce((sum, { slot }) => sum + slotRow(budget, service, slot).quota, 0);
}

/** Overwrite one account with the service's own numbers. Re-reads first: two runs may be going at once. */
export function setUsage(service, slot, { quota: q, used, resets_on }) {
  const budget = loadBudget();
  budget[service] ??= {};
  budget[service][slot] = { quota: round(q), used: round(used), resets_on: resets_on || null, synced_at: new Date().toISOString() };
  write('budget.json', budget);
}

export function charge(service, slot, cost) {
  if (!(cost > 0)) return;
  const budget = loadBudget();
  const row = slotRow(budget, service, slot);
  budget[service] ??= {};
  budget[service][slot] = { ...row, used: round(row.used + cost) };
  write('budget.json', budget);
}

/** Mark an account as spent: the service said so, and its word beats our count. */
export function exhaust(service, slot) {
  const budget = loadBudget();
  const row = slotRow(budget, service, slot);
  budget[service] ??= {};
  budget[service][slot] = { ...row, used: row.quota };
  write('budget.json', budget);
}

const round = (n) => Math.round(Number(n || 0) * 10000) / 10000;

// ---------------------------------------------------------------- website memory

export const HARD_FAILS = new Set(['blocked_401', 'blocked_403', 'blocked_406', 'captcha', 'login_wall']);

export function domainOf(target) {
  try { return new URL(/^[a-z]+:\/\//i.test(target) ? target : `https://${target}`).hostname.replace(/^(www|m)\./, ''); }
  catch { return ''; }
}

export function remembered(target) {
  const entry = read('memory.json', {})[domainOf(target)] || {};
  const days = config().memory_days;
  const benched = Object.entries(entry.failures || {})
    .filter(([, f]) => Date.now() - Date.parse(f.at) < days * 864e5)
    .map(([tool, f]) => [tool, f.kind]);
  return { lastOk: entry.last_ok, benched: Object.fromEntries(benched) };
}

export function remember(target, tool, kind) {
  const domain = domainOf(target);
  if (!domain) return;
  const memory = read('memory.json', {});
  const entry = (memory[domain] ??= { failures: {} });
  entry.failures ??= {};
  if (kind === 'ok') { entry.last_ok = tool; delete entry.failures[tool]; }
  else if (HARD_FAILS.has(kind)) entry.failures[tool] = { kind, at: new Date().toISOString() };
  else return;
  write('memory.json', memory);
}

// ---------------------------------------------------------------- ledger

export function log(result) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const { provider, job, target, ok, cost, ms, kind } = result;
  const unit = SERVICES[provider]?.unit || 'free';
  fs.appendFileSync(dataFile('log.jsonl'), JSON.stringify({ at: new Date().toISOString(), provider, job, target, ok, cost, unit, ms, kind }) + '\n');
}

export function readLog(limit = 0) {
  try {
    const rows = fs.readFileSync(dataFile('log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return limit ? rows.slice(-limit) : rows;
  } catch { return []; }
}

// ---------------------------------------------------------------- result shape

export const won = (provider, job, target, { content = '', data = null, cost = 0, ms = 0 } = {}) =>
  ({ ok: true, provider, job, target, content, data, cost, ms, error: '', kind: 'ok' });

export const lost = (provider, job, target, error, kind = 'error', { cost = 0, ms = 0, data = null } = {}) =>
  ({ ok: false, provider, job, target, content: '', data, cost, ms, error: String(error), kind });

export function kindForStatus(status) {
  if ([401, 403, 406, 429].includes(status)) return `blocked_${status}`;
  return `http_${status}`;
}
