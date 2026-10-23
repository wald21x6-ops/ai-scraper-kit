import test from 'node:test';
import assert from 'node:assert/strict';
import { fake, sandbox } from './helpers.mjs';
import * as state from '../lib/state.mjs';
import { ladder, plan, preflight, run } from '../lib/router.mjs';

const ROUTES = (routes) => ({ ...state.DEFAULTS, routes, prefer: {} });
const quiet = { warn: () => {} };

test('a free tool that works means the paid one is never touched', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const free = fake('fetch', ['static']);
  const paid = fake('firecrawl', ['static'], { paid: true, cost: 1 });
  const { result } = await run('static', 'https://a.test', { paid: true }, { providers: { fetch: free, firecrawl: paid }, ...quiet });
  assert.equal(result.provider, 'fetch');
  assert.equal(paid.calls.length, 0);
});

test('without --paid the router stops at the first paid tool and says what it would cost', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const free = fake('fetch', ['static'], { result: 'empty_or_js' });
  const paid = fake('firecrawl', ['static'], { paid: true, cost: 1 });
  const { result, attempts } = await run('static', 'https://a.test', {}, { providers: { fetch: free, firecrawl: paid }, ...quiet });
  assert.equal(result.kind, 'needs_paid');
  assert.match(result.error, /free tools could not do this.*Firecrawl, about 1 credit.*--paid/);
  assert.deepEqual(result.data, { next: 'firecrawl', cost: 1, unit: 'credits' });
  assert.equal(attempts.length, 1, 'the free tool was still tried first');
  assert.equal(paid.calls.length, 0, 'spent without --paid');
});

test('with --paid the balance is checked with the service first, then the paid tool runs', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const paid = fake('firecrawl', ['search'], { paid: true, cost: 2 });
  const { result } = await run('search', 'dentists austin', { paid: true }, { providers: { firecrawl: paid }, ...quiet });
  assert.ok(result.ok);
  assert.equal(paid.synced, 1);
  const [row] = state.readLog();
  assert.deepEqual([row.provider, row.cost, row.unit, row.ok], ['firecrawl', 2, 'credits', true]);
});

test('a paid tool without enough left is skipped and the next one used', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  process.env.SGAI_API_KEY = 'sgai-test';
  state.setUsage('firecrawl', '1', { quota: 1000, used: 999.5 });
  const fc = fake('firecrawl', ['search'], { paid: true, cost: 2 });
  const sg = fake('scrapegraph', ['search'], { paid: true, cost: 2 });
  const steps = plan('search', 'q', {}, { providers: { firecrawl: fc, scrapegraph: sg } });
  assert.match(steps[0].reason, /only 0.5 credits left/);
  const { result } = await run('search', 'q', { paid: true }, { providers: { firecrawl: fc, scrapegraph: sg }, ...quiet });
  assert.equal(result.provider, 'scrapegraph');
  assert.equal(fc.calls.length, 0);
});

test('nothing configured gives a plain answer, not a crash', async (t) => {
  sandbox(t);
  const paid = { ...fake('firecrawl', ['search'], { paid: true, cost: 2 }), available: () => [false, 'no key yet'] };
  const { result } = await run('search', 'q', { paid: true }, { providers: { firecrawl: paid }, ...quiet });
  assert.equal(result.kind, 'no_tool');
  assert.match(result.error, /firecrawl: no key yet/);
});

test('memory: what worked goes first, but never a paid tool ahead of a free one', (t) => {
  sandbox(t);
  const providers = { fetch: fake('fetch', ['static']), chrome: fake('chrome', ['static']), firecrawl: fake('firecrawl', ['static'], { paid: true }) };
  const cfg = ROUTES({ static: ['fetch', 'chrome', 'firecrawl'] });
  state.remember('https://site.test/a', 'chrome', 'ok');
  assert.deepEqual(ladder('static', 'https://www.site.test/b', { cfg, providers }), ['chrome', 'fetch', 'firecrawl']);
  state.remember('https://site.test/a', 'firecrawl', 'ok');
  assert.deepEqual(ladder('static', 'https://site.test/b', { cfg, providers }), ['fetch', 'chrome', 'firecrawl']);
});

test('a tool blocked on a website is benched there for a week, and only that tool', (t) => {
  sandbox(t);
  const providers = { fetch: fake('fetch', ['static']), chrome: fake('chrome', ['static']) };
  const cfg = ROUTES({ static: ['fetch', 'chrome'] });
  state.remember('https://blocked.test/', 'fetch', 'blocked_403');
  state.remember('https://blocked.test/', 'chrome', 'timeout');      // a bad minute is not remembered
  assert.deepEqual(ladder('static', 'https://blocked.test/x', { cfg, providers }), ['chrome']);
  assert.deepEqual(ladder('static', 'https://other.test/x', { cfg, providers }), ['fetch', 'chrome']);
});

test('facebook.com goes straight to Chrome, whatever the job', (t) => {
  sandbox(t);
  const providers = { fetch: fake('fetch', ['static']), chrome: fake('chrome', ['static']) };
  assert.equal(ladder('static', 'https://www.facebook.com/ads/library/?q=x', { providers })[0], 'chrome');
});

test('a --js snippet skips every tool that cannot run it', async (t) => {
  sandbox(t);
  const fetchTool = fake('fetch', ['static']);
  const chrome = fake('chrome', ['static'], { runsJs: true });
  const { result } = await run('static', 'https://a.test', { js: '1+1' }, { providers: { fetch: fetchTool, chrome }, ...quiet });
  assert.equal(result.provider, 'chrome');
  assert.equal(fetchTool.calls.length, 0);
});

test('a batch the paid tools cannot cover is refused up front, with the stopping point', (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  state.setUsage('firecrawl', '1', { quota: 1000, used: 990 });
  const providers = { firecrawl: fake('firecrawl', ['search'], { paid: true, cost: 2 }) };
  const pf = preflight('search', 300, 'q', {}, { providers });
  assert.equal(pf.covered, false);
  assert.match(pf.summary, /cover 5 of 300.*stop at number 6/);
  assert.equal(preflight('search', 5, 'q', {}, { providers }).covered, true);
  assert.match(preflight('search', 5, 'q', {}, { providers }).quote, /about 10 credits for 5 \(2 credits each, 10 credits left\)/);
});

test('a batch with a free tool first is covered even when paid credit is short', (t) => {
  sandbox(t);
  const providers = { fetch: fake('fetch', ['static']), firecrawl: fake('firecrawl', ['static'], { paid: true, cost: 1 }) };
  assert.equal(preflight('static', 500, 'https://a.test', {}, { providers }).covered, true);
});

test('the nearly-out warning fires once per run, not once per call', async (t) => {
  sandbox(t);
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  state.setUsage('firecrawl', '1', { quota: 1000, used: 950 });
  const warnings = [];
  const providers = { firecrawl: fake('firecrawl', ['search'], { paid: true, cost: 2 }) };
  for (let i = 0; i < 3; i++) await run('search', `q${i}`, { paid: true }, { providers, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Firecrawl is nearly out/);
});
