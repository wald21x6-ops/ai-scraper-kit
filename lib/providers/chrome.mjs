// The Chrome (or Edge, or Brave) already on this computer, driven headless over
// the DevTools protocol. Free. Reads pages that need JavaScript, reads Facebook
// and the Meta Ad Library logged out, and is the only tool that runs a caller's
// JavaScript in the page (--js). No browser download: it uses the installed one.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindForStatus, lost, won } from '../state.mjs';

const TIMEOUT_MS = 150000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What a plain read returns: the visible text (footer included) and the HTML.
const PAGE_JS = "({text: document.body ? document.body.innerText : '', html: document.documentElement.outerHTML})";
// One envelope around any snippet, so the HTTP status comes back too: the only
// way to tell a real 403 from a page that simply rendered nothing.
const envelope = (js) => `(async () => ({status: (performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0, url: location.href, title: document.title, value: await (${js})}))()`;

export function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const env = process.env;
  const candidates = {
    win32: [
      `${env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.PROGRAMFILES || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.PROGRAMFILES || 'C:\\Program Files'}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
  }[process.platform];
  if (candidates) return candidates.find((p) => existsSync(p)) || '';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  return '';
}

const NAMES = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', brave: 'Brave' };
const browserName = (path) => {
  const file = path.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '');
  return NAMES[file.toLowerCase()] || file;
};

/** A minimal DevTools-protocol client over Node's built-in WebSocket. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('could not reach the browser')); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else listeners.forEach((fn) => fn(msg));
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    on: (fn) => listeners.add(fn),
    close: () => { try { ws.close(); } catch { /* already gone */ } },
  };
}

async function devtoolsPort(profile) {
  for (let i = 0; i < 100; i++) {
    try {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (port) return { port, path };
    } catch { /* not written yet */ }
    await sleep(150);
  }
  throw new Error('the browser did not start');
}

export default {
  name: 'chrome',
  jobs: ['static', 'rendered', 'hard'],
  paid: false,
  runsJs: true,
  available() {
    const path = findBrowser();
    return path ? [true, browserName(path)] : [false, 'no Chrome, Edge or Brave found (set CHROME_PATH to use another)'];
  },
  cost: () => 0,

  async fetch(job, url, opts = {}) {
    const t0 = Date.now();
    const ms = () => Date.now() - t0;
    const browser = findBrowser();
    if (!browser) return lost('chrome', job, url, 'no Chrome, Edge or Brave found', 'unavailable');

    const profile = await mkdtemp(join(tmpdir(), 'scraper-kit-'));
    const proc = spawn(browser, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--hide-scrollbars', '--mute-audio', '--window-size=1440,900',
      // Headless Chrome throttles pages nobody is watching; these keep timers and rendering running.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
      'about:blank',
    ], { stdio: 'ignore' });
    // A hung page must never leave a browser running in the background.
    const watchdog = setTimeout(() => proc.kill(), TIMEOUT_MS);
    let page, root;
    try {
      const { port, path } = await devtoolsPort(profile);
      root = await connect(`ws://127.0.0.1:${port}${path}`);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
      await page.send('Page.enable');
      const loaded = new Promise((r) => page.on((m) => m.method === 'Page.loadEventFired' && r()));
      await page.send('Page.navigate', { url });
      await Promise.race([loaded, sleep(30000)]);
      await sleep(Number(opts.wait) || 3000);

      const out = await page.send('Runtime.evaluate', { expression: envelope(opts.js || PAGE_JS), awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) {
        const why = out.exceptionDetails.exception?.description || out.exceptionDetails.text;
        return lost('chrome', job, url, `page script failed: ${String(why).slice(0, 300)}`, 'script_error', { ms: ms() });
      }
      const got = out.result.value || {};
      const meta = { status: got.status, final_url: got.url, title: got.title, browser: browserName(browser) };
      if (got.status >= 400) return lost('chrome', job, url, `HTTP ${got.status}`, kindForStatus(got.status), { ms: ms(), data: meta });
      if (opts.js) {
        const value = got.value;
        return won('chrome', job, url, { content: typeof value === 'string' ? value : JSON.stringify(value, null, 2), data: { ...meta, value }, ms: ms() });
      }
      const text = got.value?.text || '';
      if (!text.trim()) return lost('chrome', job, url, 'page rendered no text', 'empty_or_js', { ms: ms(), data: meta });
      return won('chrome', job, url, { content: opts.html ? got.value.html : text, data: meta, ms: ms() });
    } catch (err) {
      return lost('chrome', job, url, err.message, 'browser_error', { ms: ms() });
    } finally {
      clearTimeout(watchdog);
      page?.close();
      // The browser may hang up before it answers, so never wait on the reply for long.
      if (root) await Promise.race([root.send('Browser.close').catch(() => {}), sleep(1500)]);
      root?.close();
      await sleep(300);
      if (proc.exitCode === null) proc.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  },
};
