// Shared test plumbing: a throwaway data folder and home folder per test, a
// stubbed fetch, and no keys from the real environment. Nothing here opens a
// socket or starts a browser.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICES } from '../lib/state.mjs';

const KEY_NAMES = Object.values(SERVICES).flatMap((s) => s.keys);

export function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'kit-test-'));
  const saved = { data: process.env.SCRAPER_KIT_DATA, home: process.env.HOME, profile: process.env.USERPROFILE, codex: process.env.CODEX_HOME, fetch: globalThis.fetch };
  const keys = Object.fromEntries(KEY_NAMES.map((k) => [k, process.env[k]]));
  process.env.SCRAPER_KIT_DATA = join(root, 'data');
  process.env.HOME = process.env.USERPROFILE = join(root, 'home');
  delete process.env.CODEX_HOME;
  KEY_NAMES.forEach((k) => delete process.env[k]);
  t.after(() => {
    for (const [env, key] of [['SCRAPER_KIT_DATA', 'data'], ['HOME', 'home'], ['USERPROFILE', 'profile'], ['CODEX_HOME', 'codex']]) {
      if (saved[key] === undefined) delete process.env[env]; else process.env[env] = saved[key];
    }
    KEY_NAMES.forEach((k) => (keys[k] === undefined ? delete process.env[k] : (process.env[k] = keys[k])));
    globalThis.fetch = saved.fetch;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Replace fetch. `handler(url, init)` returns [status, body] or [status, body, headers]. Records every call. */
export function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method || 'GET', body, headers: init.headers || {} });
    const [status, payload, headers = { 'content-type': 'application/json' }] = await handler(String(url), { ...init, body });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers });
  };
  return calls;
}

/** A provider that answers however the test wants. */
export function fake(name, jobs, { paid = false, cost = 0, result = 'ok', runsJs = false } = {}) {
  const p = {
    name, jobs, paid, runsJs, calls: [], synced: 0,
    available: () => [true, 'ready'],
    cost: () => cost,
    sync: async () => { p.synced++; },
    fetch: async (job, target) => {
      p.calls.push([job, target]);
      return result === 'ok'
        ? { ok: true, provider: name, job, target, content: 'hello', data: null, cost, ms: 1, error: '', kind: 'ok' }
        : { ok: false, provider: name, job, target, content: '', data: null, cost: 0, ms: 1, error: 'nope', kind: result };
    },
  };
  return p;
}
