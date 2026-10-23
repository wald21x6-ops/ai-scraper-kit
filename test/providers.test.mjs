import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, stubFetch } from './helpers.mjs';
import * as state from '../lib/state.mjs';
import { htmlToText } from '../lib/text.mjs';
import { withAccounts } from '../lib/providers/paid.mjs';
import fetchTool from '../lib/providers/fetch.mjs';
import firecrawl from '../lib/providers/firecrawl.mjs';
import scrapegraph from '../lib/providers/scrapegraph.mjs';
import apify, { actorId, runUsd, timing } from '../lib/providers/apify.mjs';

timing.settleMs = 0;

const okResult = (cost) => state.won('firecrawl', 'static', 'u', { content: 'x', cost });

test('accounts: an empty one hands the call to the next and is marked spent', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-1';
  process.env.FIRECRAWL_API_KEY_2 = 'fc-2';
  const seen = [];
  const r = await withAccounts('firecrawl', 'static', 'u', 1, async ({ key }) => {
    seen.push(key);
    return key === 'fc-1' ? state.lost('firecrawl', 'static', 'u', 'Insufficient credits', 'out_of_credit') : okResult(1);
  });
  assert.ok(r.ok);
  assert.deepEqual(seen, ['fc-1', 'fc-2']);
  assert.equal(r.data, null);
  assert.ok(state.slotLeft('firecrawl', '1') <= 0, 'empty account not remembered');
  assert.equal(state.slotRow(state.loadBudget(), 'firecrawl', '2').used, 1);
});

test('accounts: a blocked website is not mistaken for an empty account', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-1';
  process.env.FIRECRAWL_API_KEY_2 = 'fc-2';
  const seen = [];
  const r = await withAccounts('firecrawl', 'static', 'u', 1, async ({ key }) => { seen.push(key); return state.lost('firecrawl', 'static', 'u', 'nope', 'blocked_403'); });
  assert.equal(r.kind, 'blocked_403');
  assert.deepEqual(seen, ['fc-1'], 'paid twice for the same error');
});

test('accounts: every account out is a budget problem, said plainly', async (t) => {
  sandbox(t);
  process.env.APIFY_TOKEN = 'a1';
  state.setUsage('apify', '1', { quota: 5, used: 4.9 });
  const r = await withAccounts('apify', 'actor', 'x', 0.5, async () => assert.fail('ran on an account without enough left'));
  assert.equal(r.kind, 'quota');
  assert.match(r.error, /no Apify account has 0.5 USD left/);
});

test('firecrawl: search asks for the right number of results and prices them', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-1';
  const calls = stubFetch(() => [200, { success: true, data: { web: [{ url: 'https://r.test', title: 'R', description: 'd', extra: 1 }] } }]);
  assert.equal(firecrawl.cost('search', { n: 25 }), 6);
  const r = await firecrawl.fetch('search', 'dentists', { n: 25 });
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/search');
  assert.deepEqual(calls[0].body, { query: 'dentists', limit: 25 });
  assert.equal(calls[0].headers.authorization, 'Bearer fc-1');
  assert.deepEqual(r.data, [{ url: 'https://r.test', title: 'R', description: 'd' }]);
  assert.equal(r.cost, 6);
});

test('firecrawl: a hard page uses stealth and costs 5', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-1';
  const calls = stubFetch(() => [200, { success: true, data: { markdown: '# Hi' } }]);
  const r = await firecrawl.fetch('hard', 'https://a.test', { wait: 4000 });
  assert.equal(calls[0].body.proxy, 'stealth');
  assert.equal(calls[0].body.waitFor, 4000);
  assert.deepEqual([r.content, r.cost], ['# Hi', 5]);
});

test('firecrawl: the balance comes from Firecrawl, not from our count', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-1';
  stubFetch(() => [200, { success: true, data: { remainingCredits: 640, planCredits: 1000, billingPeriodEnd: '2026-11-10T14:53:57Z' } }]);
  await firecrawl.sync();
  assert.equal(state.left('firecrawl'), 640);
  assert.equal(state.slotRow(state.loadBudget(), 'firecrawl', '1').resets_on, '2026-11-10');
});

test('scrapegraph: v2 address, key header, search capped at 5 results', async (t) => {
  sandbox(t);
  process.env.SGAI_API_KEY = 'sgai-1';
  const calls = stubFetch(() => [200, { results: [{ url: 'https://r.test', title: 'R', content: 'c'.repeat(900) }] }]);
  const r = await scrapegraph.fetch('search', 'q', { n: 10 });
  assert.equal(calls[0].url, 'https://v2-api.scrapegraphai.com/api/search');
  assert.equal(calls[0].headers['SGAI-APIKEY'], 'sgai-1');
  assert.equal(calls[0].body.numResults, 5);
  assert.equal(r.data[0].description.length, 300);
  assert.equal(r.cost, 2);
});

test('scrapegraph: a refused key is about the key, not the website', async (t) => {
  sandbox(t);
  process.env.SGAI_API_KEY = 'sgai-1';
  stubFetch(() => [403, { error: { type: 'auth_invalid_key', message: 'Invalid or deprecated API key' } }]);
  const r = await scrapegraph.fetch('static', 'https://a.test');
  assert.equal(r.kind, 'bad_key');
  assert.match(r.error, /Invalid or deprecated/);
});

test('apify: short names and full ids both work', () => {
  assert.equal(actorId('google_maps'), 'compass~crawler-google-places');
  assert.equal(actorId('clockworks/tiktok-scraper'), 'clockworks~tiktok-scraper');
});

test('apify: a run is priced from the events it was charged for', () => {
  const run = {
    usageTotalUsd: 0.0001,
    chargedEventCounts: { item: 10, start: 1, tiered: 2 },
    pricingInfo: { pricingPerEvent: { actorChargeEvents: {
      item: { eventPriceUsd: 0.00075 }, start: { eventPriceUsd: 0.00005 },
      tiered: { eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.01 } } } } } },
  };
  assert.ok(Math.abs(runUsd(run) - 0.02755) < 1e-9);
  assert.equal(runUsd({ usageTotalUsd: 0.006 }), 0.006);
});

test('apify: every run carries a spending cap, and search results come back in the common shape', async (t) => {
  sandbox(t);
  process.env.APIFY_TOKEN = 'a1';
  let settles = 0;
  const calls = stubFetch((url) => {
    const ppe = { pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { 'search-page-scraped': { eventPriceUsd: 0.0045 }, 'apify-actor-start': { eventPriceUsd: 0.00005 } } } };
    if (url.includes('/runs?')) return [201, { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.0001, pricingInfo: ppe, chargedEventCounts: { 'apify-actor-start': 1 } } }];
    if (url.endsWith('/actor-runs/run1')) {   // the bill settles on the second look
      settles++;
      const counts = settles < 2 ? { 'apify-actor-start': 1 } : { 'search-page-scraped': 1, 'apify-actor-start': 1 };
      return [200, { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', pricingInfo: ppe, chargedEventCounts: counts, usageTotalUsd: settles < 2 ? 0.0001 : 0.00455 } }];
    }
    if (url.includes('/datasets/ds1/items')) return [200, [{ organicResults: Array.from({ length: 8 }, (_, i) => ({ url: `https://r${i}.test`, title: `T${i}`, description: 'd', position: i })) }]];
    return [404, {}];
  });
  const r = await apify.fetch('search', 'dentists austin', { n: 5 });
  assert.ok(r.ok, r.error);
  assert.match(calls[0].url, /acts\/apify~google-search-scraper\/runs\?.*maxTotalChargeUsd=0.5/);
  assert.deepEqual(calls[0].body, { queries: 'dentists austin', maxPagesPerQuery: 1 });
  assert.equal(r.data.length, 5);
  assert.deepEqual(Object.keys(r.data[0]), ['url', 'title', 'description']);
  assert.equal(r.cost, 0.0046, 'recorded the early, unsettled price');
  assert.equal(settles, 2);
  assert.equal(state.slotRow(state.loadBudget(), 'apify', '1').used, 0.0046);
});

test('apify: the monthly allowance never plans past the free $5, even on a paid plan', async (t) => {
  sandbox(t);
  process.env.APIFY_TOKEN = 'a1';
  stubFetch(() => [200, { data: { limits: { maxMonthlyUsageUsd: 49 }, current: { monthlyUsageUsd: 1.25 }, monthlyUsageCycle: { endAt: '2026-11-15T23:59:59.999Z' } } }]);
  await apify.sync();
  const row = state.slotRow(state.loadBudget(), 'apify', '1');
  assert.deepEqual([row.quota, row.used, row.resets_on], [5, 1.25, '2026-11-16']);
});

test('apify: an actor with no input is refused before anything is spent', async (t) => {
  sandbox(t);
  process.env.APIFY_TOKEN = 'a1';
  const calls = stubFetch(() => [500, {}]);
  const r = await apify.fetch('actor', 'instagram', { actor: 'instagram' });
  assert.equal(r.kind, 'bad_input');
  assert.equal(calls.length, 0);
});

test('page text: scripts and styles go, emails behind links stay, entities decode', () => {
  const { title, text } = htmlToText('<html><head><title>A &amp; B</title><style>x{}</style></head><body><script>var a=1</script><h1>Hello&nbsp;there</h1><p>Mail <a href="mailto:hi@a.test">us</a></p><header>Top</header></body></html>');
  assert.equal(title, 'A & B');
  assert.match(text, /Hello there/);
  assert.match(text, /hi@a\.test/);
  assert.match(text, /Top/, 'a <header> was taken for <head>');
  assert.doesNotMatch(text, /var a|x\{\}/);
});

test('plain fetch: a text file comes back as-is, a JavaScript shell hands over to Chrome', async (t) => {
  sandbox(t);
  stubFetch((url) => url.endsWith('.txt')
    ? [200, 'User-agent: *', { 'content-type': 'text/plain' }]
    : [200, '<html><body><div id="root"></div><script></script><script></script><script></script></body></html>', { 'content-type': 'text/html' }]);
  assert.equal((await fetchTool.fetch('static', 'https://a.test/robots.txt')).content, 'User-agent: *');
  assert.equal((await fetchTool.fetch('static', 'https://a.test/')).kind, 'empty_or_js');
});

test('apify: an actor that "succeeds" with only an error row is a failure, with its reason', async (t) => {
  sandbox(t);
  process.env.APIFY_TOKEN = 'a1';
  stubFetch((url) => url.includes('/runs?')
    ? [201, { data: { id: 'r', status: 'SUCCEEDED', defaultDatasetId: 'd', usageTotalUsd: 0.0001 } }]
    : [200, [{ error: '"Maximum charged results" option must be atleast 10 to run this actor' }]]);
  const r = await apify.fetch('actor', 'x', { actor: 'facebook_ads', input: { count: 5 } });
  assert.equal(r.kind, 'actor_error');
  assert.match(r.error, /the actor refused: .*atleast 10/);
});

test('scrapegraph: the one-time grant is measured from 500, not from this month', async (t) => {
  sandbox(t);
  process.env.SGAI_API_KEY = 'sgai-1';
  stubFetch(() => [200, { remaining: 495, used: 2, plan: 'Free Plan' }]);
  await scrapegraph.sync();
  const row = state.slotRow(state.loadBudget(), 'scrapegraph', '1');
  assert.deepEqual([row.quota, row.used], [500, 5]);
});
