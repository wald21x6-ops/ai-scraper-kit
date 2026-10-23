// Teaching the user's AI agents that the kit exists. Two pieces per agent:
//   1. a skill (skill/SKILL.md, with this kit's path filled in) — how to use it
//   2. a short block in the agent's standing instructions — so it is used for
//      any web job and always asks before spending, even when the skill isn't loaded
//
//   Claude Code: ~/.claude/skills/scraper-kit/SKILL.md   + ~/.claude/CLAUDE.md
//   Codex:       ~/.agents/skills/scraper-kit/SKILL.md   + ~/.codex/AGENTS.md  (or $CODEX_HOME)
//
// The block sits between markers, so re-running setup replaces it and
// `uninstall` removes exactly what was added.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT } from './state.mjs';

const START = '<!-- scraper-kit:start -->';
const END = '<!-- scraper-kit:end -->';
const kitPath = () => KIT.replace(/\\/g, '/');

function onPath(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

export function targets() {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  return [
    { id: 'claude', name: 'Claude Code', detected: fs.existsSync(join(home, '.claude')) || onPath('claude'),
      skill: join(home, '.claude', 'skills', 'scraper-kit', 'SKILL.md'), rules: join(home, '.claude', 'CLAUDE.md') },
    { id: 'codex', name: 'Codex', detected: fs.existsSync(codexHome) || onPath('codex'),
      skill: join(home, '.agents', 'skills', 'scraper-kit', 'SKILL.md'), rules: join(codexHome, 'AGENTS.md') },
  ];
}

export const block = () => `${START}
## Web data: use scraper-kit
For any task that needs information from the internet — pages, search results, lists of businesses,
prices, reviews, ads, social profiles, Google Maps — use the \`scraper-kit\` skill
(\`node "${kitPath()}/scrape.mjs"\`). Free tools run first. Before anything paid, tell the user what it
will cost and what is left (\`plan --count N\`, \`apify price <actor>\`), and add \`--paid\` only after they
say yes. If a request would be done better with web data, say so and quote the cost.
${END}`;

const strip = (text) => text.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`, 'g'), '\n\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');

export function install(only = []) {
  const done = [];
  const template = fs.readFileSync(join(KIT, 'skill', 'SKILL.md'), 'utf8');
  for (const t of targets()) {
    if (only.length ? !only.includes(t.id) : !t.detected) continue;
    fs.mkdirSync(dirname(t.skill), { recursive: true });
    fs.writeFileSync(t.skill, template.replaceAll('{{KIT}}', kitPath()));
    fs.mkdirSync(dirname(t.rules), { recursive: true });
    const before = fs.existsSync(t.rules) ? fs.readFileSync(t.rules, 'utf8') : '';
    const kept = strip(before).trimEnd();
    fs.writeFileSync(t.rules, `${kept ? `${kept}\n\n` : ''}${block()}\n`);
    done.push(t.name);
  }
  return done;
}

export function uninstall() {
  const done = [];
  for (const t of targets()) {
    let touched = false;
    if (fs.existsSync(t.rules)) {
      const before = fs.readFileSync(t.rules, 'utf8');
      if (before.includes(START)) { fs.writeFileSync(t.rules, strip(before).trimEnd() + '\n'); touched = true; }
    }
    if (fs.existsSync(dirname(t.skill))) { fs.rmSync(dirname(t.skill), { recursive: true, force: true }); touched = true; }
    if (touched) done.push(t.name);
  }
  return done;
}

export function status() {
  return targets().map((t) => ({
    name: t.name,
    detected: t.detected,
    installed: fs.existsSync(t.skill) && fs.existsSync(t.rules) && fs.readFileSync(t.rules, 'utf8').includes(START),
  }));
}
