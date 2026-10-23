// ScrapeGraph (scrapegraphai.com), API v2 only — the v1 host and its names
// (smartscraper, markdownify, searchscraper) are retired. Free plan: 500 credits,
// one time. Prices (their docs, 2026-10-24): page 1, +5 with stealth, extract 5,
// search 2 per result (this kit asks for at most 5).

import { accounts, lost, SERVICES, setUsage, won } from '../state.mjs';
import { http, message, withAccounts } from './paid.mjs';

const BASE = 'https://v2-api.scrapegraphai.com/api';
const auth = (key) => ({ 'SGAI-APIKEY': key });
const results = (opts) => Math.max(1, Math.min(Number(opts.n) || 5, 5));

function kind(status) {
  if (status === 402) return 'out_of_credit';
  if (status === 401 || status === 403) return 'bad_key';     // here 403 is about the key, not the website
  if (status === 429) return 'blocked_429';
  return status > 0 ? `http_${status}` : 'network';
}

// Name the fetch mode: left on "auto" their worst case is +9 credits, and the
// price must be known before the call.
const fetchConfig = (job, opts) => ({
  mode: job === 'static' ? 'fast' : 'js',
  ...(job === 'hard' ? { stealth: true } : {}),
  ...(opts.wait ? { wait: Math.min(Number(opts.wait), 30000) } : {}),
});

export default {
  name: 'scrapegraph',
  jobs: ['static', 'rendered', 'hard', 'extract', 'search'],
  paid: true,
  available: () => (accounts('scrapegraph').length ? [true, 'key set'] : [false, 'no key yet']),

  cost(job, opts = {}) {
    if (job === 'search') return 2 * results(opts);
    return (job === 'extract' ? 5 : 1) + (job === 'hard' ? 5 : 0);
  },

  async sync() {
    for (const { slot, key } of accounts('scrapegraph')) {
      const { status, json } = await http(`${BASE}/credits`, { headers: auth(key), timeout: 20000 });
      if (status !== 200 || json?.remaining == null) continue;
      // Their "used" is this cycle only; the free grant is one-time, so measure from the grant.
      const quota = Math.max(Number(json.remaining) + (Number(json.used) || 0), SERVICES.scrapegraph.free);
      setUsage('scrapegraph', slot, { quota, used: quota - Number(json.remaining) });
    }
  },

  async fetch(job, target, opts = {}) {
    const need = this.cost(job, opts);
    return withAccounts('scrapegraph', job, target, need, async ({ key }) => {
      const t0 = Date.now();
      const ms = () => Date.now() - t0;
      let call;
      if (job === 'search') call = http(`${BASE}/search`, { method: 'POST', headers: auth(key), body: { query: target, numResults: results(opts) } });
      else if (job === 'extract') call = http(`${BASE}/extract`, { method: 'POST', headers: auth(key), body: { url: target, prompt: opts.prompt || 'Extract the main facts on this page.', ...(opts.schema ? { schema: opts.schema } : {}), fetchConfig: fetchConfig(job, opts) } });
      else call = http(`${BASE}/scrape`, { method: 'POST', headers: auth(key), body: { url: target, formats: [{ type: 'markdown' }], fetchConfig: fetchConfig(job, opts) } });
      const { status, json } = await call;
      if (status !== 200) return lost('scrapegraph', job, target, message(json, status), kind(status), { ms: ms() });

      if (job === 'search') {
        const rows = (json.results || []).map((r) => ({ url: r.url, title: r.title, description: (r.content || '').slice(0, 300) }));
        if (!rows.length) return lost('scrapegraph', job, target, 'no results', 'empty', { ms: ms() });
        return won('scrapegraph', job, target, { content: JSON.stringify(rows, null, 2), data: rows, cost: 2 * rows.length, ms: ms() });
      }
      if (job === 'extract') return won('scrapegraph', job, target, { content: JSON.stringify(json.json, null, 2), data: { extracted: json.json }, cost: need, ms: ms() });
      const markdown = (json.results?.markdown?.data || []).filter((x) => typeof x === 'string').join('\n\n');
      if (!markdown.trim()) return lost('scrapegraph', job, target, 'no content came back', 'empty', { ms: ms() });
      return won('scrapegraph', job, target, { content: markdown, data: {}, cost: need, ms: ms() });
    });
  },
};
