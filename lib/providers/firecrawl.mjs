// Firecrawl (firecrawl.dev), API v2. Free plan: 1,000 credits a month, no card.
// Prices (their pricing page, 2026-10-24): 1 credit a page, +4 for stealth or for
// JSON extraction, 2 credits per 10 search results, crawls 1 credit a page.

import { lost, setUsage, won, accounts } from '../state.mjs';
import { http, message, withAccounts } from './paid.mjs';

const BASE = 'https://api.firecrawl.dev';
const auth = (key) => ({ authorization: `Bearer ${key}` });

function kind(status) {
  if (status === 402) return 'out_of_credit';
  if (status === 401) return 'bad_key';
  if (status === 429) return 'blocked_429';
  if (status === 403) return 'blocked_403';
  return status > 0 ? `http_${status}` : 'network';
}

export default {
  name: 'firecrawl',
  jobs: ['static', 'rendered', 'hard', 'extract', 'search', 'crawl'],
  paid: true,
  available: () => (accounts('firecrawl').length ? [true, `${accounts('firecrawl').length} key(s)`] : [false, 'no key yet']),

  cost(job, opts = {}) {
    if (job === 'search') return 2 * Math.ceil((Number(opts.n) || 10) / 10);
    if (job === 'crawl') return Number(opts.max) || 20;
    return 1 + (job === 'hard' ? 4 : 0) + (job === 'extract' ? 4 : 0);
  },

  async sync() {
    for (const { slot, key } of accounts('firecrawl')) {
      const { status, json } = await http(`${BASE}/v2/team/credit-usage`, { headers: auth(key), timeout: 20000 });
      const d = json?.data;
      if (status !== 200 || d?.remainingCredits == null) continue;
      const plan = Number(d.planCredits) || 1000;
      setUsage('firecrawl', slot, { quota: plan, used: plan - Number(d.remainingCredits), resets_on: String(d.billingPeriodEnd || '').slice(0, 10) });
    }
  },

  async fetch(job, target, opts = {}) {
    const need = this.cost(job, opts);
    return withAccounts('firecrawl', job, target, need, async ({ key }) => {
      const t0 = Date.now();
      const ms = () => Date.now() - t0;

      if (job === 'search') {
        const { status, json } = await http(`${BASE}/v2/search`, { method: 'POST', headers: auth(key), body: { query: target, limit: Number(opts.n) || 10 } });
        if (status !== 200) return lost('firecrawl', job, target, message(json, status), kind(status), { ms: ms() });
        const rows = (json.data?.web || []).map(({ url, title, description }) => ({ url, title, description }));
        return won('firecrawl', job, target, { content: JSON.stringify(rows, null, 2), data: rows, cost: need, ms: ms() });
      }

      if (job === 'crawl') {
        const limit = Number(opts.max) || 20;
        const start = await http(`${BASE}/v2/crawl`, { method: 'POST', headers: auth(key), body: { url: target, limit, scrapeOptions: { formats: ['markdown'] } } });
        if (start.status !== 200 || !start.json?.id) return lost('firecrawl', job, target, message(start.json, start.status), kind(start.status), { ms: ms() });
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const { status, json } = await http(`${BASE}/v2/crawl/${start.json.id}`, { headers: auth(key) });
          if (status !== 200) return lost('firecrawl', job, target, message(json, status), kind(status), { ms: ms() });
          if (json.status === 'completed') {
            const pages = json.data || [];
            const spent = Number(json.creditsUsed) || pages.length;
            const content = pages.map((p) => `# ${p.metadata?.sourceURL || ''}\n\n${p.markdown || ''}`).join('\n\n---\n\n');
            return won('firecrawl', job, target, { content, data: { pages: pages.length, urls: pages.map((p) => p.metadata?.sourceURL) }, cost: spent, ms: ms() });
          }
          if (['failed', 'cancelled'].includes(json.status)) return lost('firecrawl', job, target, `crawl ${json.status}`, 'error', { ms: ms() });
        }
        return lost('firecrawl', job, target, 'crawl still running after 5 minutes', 'timeout', { ms: ms() });
      }

      const formats = ['markdown'];
      if (job === 'extract') formats.unshift({ type: 'json', prompt: opts.prompt || 'Extract the main facts on this page.', ...(opts.schema ? { schema: opts.schema } : {}) });
      const body = { url: target, formats, onlyMainContent: false, ...(job === 'hard' ? { proxy: 'stealth' } : {}), ...(opts.wait ? { waitFor: Number(opts.wait) } : {}) };
      const { status, json } = await http(`${BASE}/v2/scrape`, { method: 'POST', headers: auth(key), body });
      if (status !== 200 || json?.success === false) return lost('firecrawl', job, target, message(json, status), kind(status), { ms: ms() });
      const d = json.data || {};
      if (job === 'extract') return won('firecrawl', job, target, { content: JSON.stringify(d.json, null, 2), data: { extracted: d.json }, cost: need, ms: ms() });
      return won('firecrawl', job, target, { content: d.markdown || '', data: { title: d.metadata?.title, status: d.metadata?.statusCode }, cost: need, ms: ms() });
    });
  },
};
