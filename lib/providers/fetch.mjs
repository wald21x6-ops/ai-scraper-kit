// Plain HTTP fetch. Free, fast, no browser. Fails over to Chrome when the page
// is an empty shell that needs JavaScript, or blocks a non-browser request.

import { htmlToText } from '../text.mjs';
import { kindForStatus, lost, won } from '../state.mjs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export default {
  name: 'fetch',
  jobs: ['static'],
  paid: false,
  available: () => [true, 'built in'],
  cost: () => 0,

  async fetch(job, url, opts = {}) {
    const t0 = Date.now();
    const ms = () => Date.now() - t0;
    let res;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      });
    } catch (err) {
      return lost('fetch', job, url, err.cause?.code || err.message, err.name === 'TimeoutError' ? 'timeout' : 'network', { ms: ms() });
    }
    if (res.status >= 400) return lost('fetch', job, url, `HTTP ${res.status}`, kindForStatus(res.status), { ms: ms() });

    const body = await res.text();
    const meta = { status: res.status, final_url: res.url };
    if (opts.html) return won('fetch', job, url, { content: body, data: meta, ms: ms() });
    if (!/html/i.test(res.headers.get('content-type') || '')) {
      // .txt, .md, .json, robots.txt, sitemaps: the body already is the text.
      return body.trim() ? won('fetch', job, url, { content: body, data: meta, ms: ms() })
        : lost('fetch', job, url, 'empty response', 'empty', { ms: ms() });
    }
    const { title, text } = htmlToText(body);
    const scripts = (body.match(/<script\b/gi) || []).length;
    if (text.length < 50 || (text.length < 400 && scripts >= 3)) {
      return lost('fetch', job, url, 'page has almost no text without JavaScript', 'empty_or_js', { ms: ms(), data: meta });
    }
    return won('fetch', job, url, { content: text, data: { ...meta, title }, ms: ms() });
  },
};
