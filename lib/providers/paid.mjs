// What every paid tool shares: walking its accounts, billing the right one, and
// talking JSON over HTTP. Firecrawl and Apify accept up to three keys each; the
// first account with enough left does the work, and when the service itself says
// "out of credit" that account is marked spent and the next one takes the call.

import { accounts, charge, exhaust, lost, SERVICES, slotLeft } from '../state.mjs';

// Kinds that mean "this account can't, another might". Everything else (a bad
// input, a blocked site) would fail the same on every account, so it stops here.
const ROTATE = new Set(['out_of_credit', 'bad_key']);

export async function withAccounts(service, job, target, need, call) {
  const tried = [];
  let last = null;
  for (const account of accounts(service)) {
    if (slotLeft(service, account.slot) < need) { tried.push(`${account.slot}:not enough left`); continue; }
    const result = await call(account);
    if (result.cost > 0) charge(service, account.slot, result.cost);
    if (!ROTATE.has(result.kind)) return { ...result, data: result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? { ...result.data, account: account.slot } : result.data };
    if (result.kind === 'out_of_credit') exhaust(service, account.slot);
    tried.push(`${account.slot}:${result.kind}`);
    last = result;
  }
  const { label, unit } = SERVICES[service];
  const why = last ? last.error : `no ${label} account has ${need} ${unit === 'usd' ? 'USD' : 'credits'} left`;
  return lost(service, job, target, `${why} (tried: ${tried.join(', ') || 'no keys'})`, last?.kind === 'bad_key' ? 'bad_key' : 'quota');
}

export async function http(url, { method = 'GET', headers = {}, body, timeout = 120000 } = {}) {
  try {
    const res = await fetch(url, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { error: text.slice(0, 400) }; }
    return { status: res.status, json };
  } catch (err) {
    return { status: -1, json: { error: err.cause?.code || err.message } };
  }
}

export function message(json, status) {
  const e = json?.error;
  return String((e && typeof e === 'object' ? e.message || e.type : e) || json?.message || `HTTP ${status}`).slice(0, 400);
}
