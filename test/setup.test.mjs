import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import * as agents from '../lib/agents.mjs';
import * as state from '../lib/state.mjs';
import { main, parse } from '../scrape.mjs';

const silently = async (fn) => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await fn(); } finally { process.stdout.write = write; }
};

test('setup teaches both agents once, and keeps what the user already had', async (t) => {
  const root = sandbox(t);
  const home = join(root, 'home');
  fs.mkdirSync(join(home, '.claude'), { recursive: true });
  fs.writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# My rules\nBe brief.\n');

  assert.equal(await silently(() => main(['setup', '--no-open', '--claude', '--codex'])), 0);
  assert.equal(await silently(() => main(['setup', '--no-open', '--claude', '--codex'])), 0);

  const claude = fs.readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# My rules\nBe brief\.\n\n<!-- scraper-kit:start -->/);
  assert.equal(claude.split('scraper-kit:start').length, 2, 'block added twice');
  assert.match(fs.readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /use the `scraper-kit` skill/);

  const skill = fs.readFileSync(join(home, '.agents', 'skills', 'scraper-kit', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: scraper-kit\ndescription: /);
  assert.ok(skill.includes(`${state.KIT.replace(/\\/g, '/')}/scrape.mjs`), 'kit path not filled in');
  assert.ok(!skill.includes('{{KIT}}'));
  assert.ok(fs.existsSync(join(home, '.claude', 'skills', 'scraper-kit', 'SKILL.md')));
});

test('uninstall removes exactly what setup added', async (t) => {
  const root = sandbox(t);
  const home = join(root, 'home');
  fs.mkdirSync(join(home, '.claude'), { recursive: true });
  fs.writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# My rules\n');
  agents.install(['claude']);
  await silently(() => main(['uninstall']));
  assert.equal(fs.readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), '# My rules\n');
  assert.ok(!fs.existsSync(join(home, '.claude', 'skills', 'scraper-kit')));
});

test('the keys file: blank lines for the three services, and a re-run keeps pasted keys', async (t) => {
  sandbox(t);
  await silently(() => main(['setup', '--no-open']));
  const file = state.dataFile('keys.env');
  let text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^FIRECRAWL_API_KEY=$/m);
  assert.match(text, /^APIFY_TOKEN=$/m);
  assert.match(text, /^SGAI_API_KEY=$/m);
  assert.doesNotMatch(text, /_2=|_3=/, 'the template suggests extra accounts');

  fs.writeFileSync(file, text.replace('APIFY_TOKEN=', 'APIFY_TOKEN=apify_api_abc').replace('SGAI_API_KEY=', 'SGAI_API_KEY= "sgai-xyz" '));
  await silently(() => main(['setup', '--no-open']));
  text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^APIFY_TOKEN=apify_api_abc$/m);
  assert.deepEqual(state.accounts('scrapegraph'), [{ slot: '1', key: 'sgai-xyz' }]);
  assert.deepEqual(state.accounts('firecrawl'), []);
});

test('flags parse on either side, with or without =', () => {
  assert.deepEqual(parse(['get', 'https://a.test', '--wait=5000', '--paid', '--out', 'f.txt']),
    { args: ['get', 'https://a.test'], flags: { wait: '5000', paid: true, out: 'f.txt' } });
});

test('commands without what they need fail with a plain message, not a crash', async (t) => {
  sandbox(t);
  const err = process.stderr.write;
  const said = [];
  process.stderr.write = (s) => { said.push(String(s)); return true; };
  try {
    assert.equal(await main(['get']), 2);
    assert.equal(await main(['apify', 'run', 'instagram', '--input-json', '{bad']), 4);
  } finally { process.stderr.write = err; }
  assert.match(said.join(''), /get needs a URL/);
  assert.match(said.join(''), /not valid JSON/);
});
