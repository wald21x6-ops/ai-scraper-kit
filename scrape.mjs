#!/usr/bin/env node
// scraper-kit — one command for getting anything off the web, free tools first.
// Run with no arguments for help. Needs Node 22 or newer; nothing to install.

import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as state from './lib/state.mjs';
import * as agents from './lib/agents.mjs';
import { PROVIDERS, formatCost, plan, preflight, run, syncAll } from './lib/router.mjs';
import { find, price } from './lib/providers/apify.mjs';

const HELP = `scraper-kit — get anything off the web. Free tools first; paid ones only with --paid.

  check                         what works, credits left on each service, warnings
  get <url>                     read a page  [--job static|rendered|hard] [--js "<expr>" | --js-file f]
                                             [--wait ms] [--html] [--out file] [--paid]
  search "<query>"              web search (paid)  [--n 10] [--paid]
  extract <url> --prompt "..."  pull structured facts with AI (paid)  [--schema f.json] [--paid]
  crawl <url>                   many pages of one site (paid)  [--max 20] [--paid]
  apify find "<what>"           search Apify's ready-made scrapers (free)
  apify price <actor>           what an actor costs (free)
  apify run <actor>             run it  --input f.json | --input-json '{..}'  [--max-usd 0.5] [--max-items N] --paid
  plan <target> [--job J]       what would run and what it costs; --count N for a batch
  keys                          open the keys file
  setup | update | uninstall    install, update, or remove the kit's instructions from your AI

  --json prints the full result for programs. Exit codes: 0 ok, 2 bad input, 3 needs --paid or no tool, 4 failed.`;

const BOOL = new Set(['json', 'paid', 'html', 'no-open', 'claude', 'codex', 'offline', 'help']);

export function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (BOOL.has(name)) flags[name] = true;
    else flags[name] = inline ?? argv[++i];
  }
  return { args, flags };
}

const out = (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
const say = (text) => process.stderr.write(`${text}\n`);
const fail = (text, code = 2) => { say(`scraper-kit: ${text}`); return code; };
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

function openInEditor(file) {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['notepad.exe', [file]]
    : process.platform === 'darwin' ? ['open', ['-e', file]] : ['xdg-open', [file]];
  try { spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
}

function readJson(flags) {
  if (flags.input) return JSON.parse(fs.readFileSync(flags.input, 'utf8'));
  if (flags['input-json']) return JSON.parse(flags['input-json']);
  return undefined;
}

function report({ result, attempts }, flags) {
  if (flags.json) { out(JSON.stringify({ ...result, attempts: attempts.map(({ content, ...rest }) => rest) }, null, 2)); }
  for (const a of attempts.slice(0, -1)) say(`  tried ${a.provider}: ${a.kind} — ${a.error}`);
  if (result.ok) {
    say(`ok · ${result.provider} · ${result.cost ? formatCost(result.provider, result.cost) : 'free'} · ${seconds(result.ms)}`);
    if (flags.out) { fs.writeFileSync(flags.out, result.content); say(`saved to ${flags.out}`); }
    else if (!flags.json) out(result.content);
    return 0;
  }
  say(`${result.kind === 'needs_paid' ? 'stopped' : 'failed'}: ${result.error}`);
  return ['needs_paid', 'no_tool'].includes(result.kind) ? 3 : 4;
}

// ------------------------------------------------------------------ setup

function writeKeysFile() {
  const file = state.dataFile('keys.env');
  const existing = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) existing[m[1]] = m[2];
    }
  } catch { /* first run */ }
  const sections = Object.values(state.SERVICES).map((s, i) => [
    `# ${i + 1}. ${s.label} — free: ${s.plan}`,
    `#    Get your key: ${s.signup}   (it starts with ${s.prefix})`,
    `${s.keys[0]}=${existing[s.keys[0]] || ''}`,
    // Extra accounts are kept if someone already added them; the template never suggests them.
    ...s.keys.slice(1).filter((k) => existing[k]).map((k) => `${k}=${existing[k]}`),
  ].join('\n'));
  fs.mkdirSync(state.dataDir(), { recursive: true });
  fs.writeFileSync(file, [
    '# scraper-kit keys. Paste each key right after its = sign, then save (Ctrl+S, or Cmd+S on a Mac).',
    '# Skip any service you do not want; an empty line just means that tool stays off.',
    '# This file stays on your computer. Never share it or upload it anywhere.',
    '', ...sections.flatMap((s) => [s, '']),
  ].join('\n'));
  return file;
}

function cmdSetup(flags) {
  const file = writeKeysFile();
  const only = ['claude', 'codex'].filter((id) => flags[id]);
  const taught = agents.install(only);
  out('scraper-kit is installed.\n');
  out(taught.length ? `Your AI now knows about it: ${taught.join(' and ')}. Start a new chat for it to take effect.`
    : 'No Claude Code or Codex found on this computer. Run setup again with --claude or --codex once one is installed.');
  out('\nThree free accounts to make (about 2 minutes each, no card needed):');
  Object.values(state.SERVICES).forEach((s, i) => out(`  ${i + 1}. ${s.label} — ${s.plan}\n     ${s.signup}`));
  const opened = !flags['no-open'] && openInEditor(file);
  out(`\n${opened ? 'The keys file is open now' : 'Your keys file is here'}: ${file}`);
  out('Copy each key, paste it after its = sign, save the file, then tell your AI "done".');
  return 0;
}

// ------------------------------------------------------------------ check

async function cmdCheck(flags) {
  if (!flags.offline) await syncAll();
  const budget = state.loadBudget();
  out('scraper-kit check\n');
  out('Free tools (always first):');
  for (const name of ['fetch', 'chrome']) {
    const [ok, why] = PROVIDERS[name].available();
    out(`  ${ok ? 'ok ' : 'no '} ${name.padEnd(12)} ${why}`);
  }
  out('\nPaid tools (only with your go-ahead):');
  const warnings = [];
  for (const [name, s] of Object.entries(state.SERVICES)) {
    const accts = state.accounts(name);
    if (!accts.length) { out(`  --  ${s.label.padEnd(12)} no key yet. Free: ${s.plan}. Get one: ${s.signup}`); continue; }
    const rows = accts.map(({ slot }) => ({ slot, ...state.slotRow(budget, name, slot) }));
    const fresh = rows.every((r) => r.synced_at && Date.now() - Date.parse(r.synced_at) < 120000);
    const left = state.left(name, budget);
    const q = state.quota(name, budget);
    const refill = rows.map((r) => r.resets_on).filter(Boolean).sort()[0];
    const amount = s.unit === 'usd' ? `${formatCost(name, Math.max(left, 0))} of ${formatCost(name, q)}` : `${Math.max(Math.round(left), 0).toLocaleString('en-US')} of ${q.toLocaleString('en-US')} credits`;
    out(`  ${fresh ? 'ok ' : '?? '} ${s.label.padEnd(12)} ${amount} left`
      + `${refill ? `, refills ${refill}` : s.unit === 'credits' && name === 'scrapegraph' ? ', does not refill' : ''}`
      + `${accts.length > 1 ? ` (${accts.length} accounts)` : ''}${fresh || flags.offline ? '' : ' — could not confirm with the service: is the key right?'}`);
    if (q && left < 0.1 * q) warnings.push(`${s.label} is nearly out (${formatCost(name, Math.max(left, 0))} left).`);
  }
  out('\nYour AI:');
  for (const a of agents.status()) out(`  ${a.installed ? 'ok ' : '-- '} ${a.name.padEnd(12)} ${a.installed ? 'knows about the kit' : a.detected ? 'not set up — run setup' : 'not on this computer'}`);
  if (warnings.length) { out('\nWarnings:'); warnings.forEach((w) => out(`  ! ${w}`)); }
  const recent = state.readLog(5);
  if (recent.length) {
    out('\nLast calls:');
    const local = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 5)}`; };
    for (const r of recent) out(`  ${local(r.at)}  ${r.ok ? 'ok  ' : 'fail'} ${r.provider.padEnd(11)} ${r.job.padEnd(8)} ${r.cost ? formatCost(r.provider, r.cost) : 'free'}`);
  }
  return 0;
}

// ------------------------------------------------------------------ main

const JOB = (flags, fallback) => ({ auto: 'static', static: 'static', rendered: 'rendered', hard: 'hard' }[flags.job || fallback] || flags.job || fallback);

export async function main(argv = process.argv.slice(2)) {
  const { args, flags } = parse(argv);
  const [cmd, ...rest] = args;
  if (!cmd || flags.help || cmd === 'help') { out(HELP); return cmd ? 0 : 2; }
  if (Number(process.versions.node.split('.')[0]) < 22) return fail(`needs Node 22 or newer (this is ${process.versions.node}).`);

  const common = { paid: !!flags.paid, wait: flags.wait, html: !!flags.html, n: flags.n, max: flags.max };
  try {
    switch (cmd) {
      case 'setup': return cmdSetup(flags);
      case 'check': return await cmdCheck(flags);
      case 'keys': {
        const file = state.dataFile('keys.env');
        if (!fs.existsSync(file)) writeKeysFile();
        openInEditor(file);
        out(`opened ${file}`);
        return 0;
      }
      case 'get': {
        if (!rest[0]) return fail('get needs a URL');
        const js = flags['js-file'] ? fs.readFileSync(flags['js-file'], 'utf8') : flags.js;
        return report(await run(JOB(flags, 'auto'), rest[0], { ...common, js }), flags);
      }
      case 'search':
        if (!rest[0]) return fail('search needs a query');
        return report(await run('search', rest.join(' '), common), flags);
      case 'extract': {
        if (!rest[0] || !flags.prompt) return fail('extract needs a URL and --prompt "what to pull out"');
        const schema = flags.schema ? JSON.parse(fs.readFileSync(flags.schema, 'utf8')) : undefined;
        return report(await run('extract', rest[0], { ...common, prompt: flags.prompt, schema }), flags);
      }
      case 'crawl':
        if (!rest[0]) return fail('crawl needs a URL');
        return report(await run('crawl', rest[0], common), flags);
      case 'apify': {
        const [sub, ...what] = rest;
        if (sub === 'find') {
          const { items, error } = await find(what.join(' '));
          if (error) return fail(error, 4);
          if (flags.json) { out(JSON.stringify(items, null, 2)); return 0; }
          items.forEach((a) => out(`${a.id.padEnd(48)} ${String(a.price).padEnd(34)} ${a.users ?? '?'} users\n  ${a.title}`));
          return 0;
        }
        if (sub === 'price') {
          const p = await price(what[0]);
          if (p.error) return fail(`${p.id}: ${p.error}`, 4);
          if (flags.json) { out(JSON.stringify(p, null, 2)); return 0; }
          out(`${p.title} (${p.id}) — ${p.model}`);
          p.events.forEach((e) => out(`  $${e.usd} per ${e.title || e.event}${e.primary ? '   <- main charge' : ''}`));
          if (p.perUnitUsd) out(`  $${p.perUnitUsd} per unit`);
          if (p.minCapUsd) out(`  smallest spending cap it accepts: $${p.minCapUsd}`);
          return 0;
        }
        if (sub === 'run') {
          if (!what[0]) return fail('apify run needs an actor: a short name or a full id like apify/instagram-scraper');
          return report(await run('actor', what[0], { ...common, actor: what[0], input: readJson(flags), maxUsd: flags['max-usd'], maxItems: flags['max-items'] }), flags);
        }
        return fail('apify find "<what>" | apify price <actor> | apify run <actor> --input f.json --paid');
      }
      case 'plan': {
        if (!rest[0]) return fail('plan needs a URL or a query');
        const job = JOB(flags, 'auto');
        const opts = { n: flags.n, js: flags.js, maxUsd: flags['max-usd'], actor: rest[0] };
        if (flags.count) await syncAll();
        for (const [i, s] of plan(job, rest[0], opts).entries()) {
          out(`${s.usable ? '->' : '  '} ${i + 1}. ${s.provider.padEnd(12)} ${(s.paid ? formatCost(s.provider, s.cost) : 'free').padEnd(14)} ${s.reason}`);
        }
        if (flags.count) {
          const pf = preflight(job, Number(flags.count), rest[0], opts);
          out(`\nbatch of ${flags.count}: ${pf.summary}`);
          if (pf.quote && pf.covered) out(`quote for the user: ${pf.quote}`);
          pf.lines.forEach((l) => out(`  ${l}`));
          return pf.covered ? 0 : 3;
        }
        return 0;
      }
      case 'update': {
        try { out(execFileSync('git', ['-C', state.KIT, 'pull', '--ff-only'], { encoding: 'utf8' }).trim()); }
        catch (err) { return fail(`could not update: ${String(err.stderr || err.message).trim()}`, 4); }
        const taught = agents.install(agents.status().filter((a) => a.installed).map((a) => (a.name === 'Codex' ? 'codex' : 'claude')));
        out(`updated${taught.length ? `; refreshed the instructions for ${taught.join(' and ')}` : ''}.`);
        return 0;
      }
      case 'uninstall': {
        const removed = agents.uninstall();
        out(removed.length ? `Removed the kit's instructions from ${removed.join(' and ')}.` : 'Nothing to remove.');
        out(`Your keys and history are still in ${state.dataDir()}. Delete the scraper-kit folder to remove everything.`);
        return 0;
      }
      default: return fail(`unknown command "${cmd}". Run with no arguments for help.`);
    }
  } catch (err) {
    return fail(err instanceof SyntaxError ? `that is not valid JSON: ${err.message}` : err.message, 4);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; });
}
