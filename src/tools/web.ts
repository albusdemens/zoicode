import { type Tool, truncate } from './types.js';

const MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 10;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

/** The most HTML converted: more than any readable page, and a bound on the work. */
const MAX_HTML = 2_000_000;
/** Elements whose content is not text. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'svg', 'head', 'iframe']);
const BLOCK_ENDS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'tr', 'table', 'ul', 'ol', 'blockquote']);

/** Removes <!-- comments -->; one that is never closed runs to the end. */
function dropComments(html: string): string {
  let out = '';
  for (let i = 0; ; ) {
    const start = html.indexOf('<!--', i);
    if (start === -1) return out + html.slice(i);
    out += html.slice(i, start);
    const end = html.indexOf('-->', start + 4);
    if (end === -1) return out;
    i = end + 3;
  }
}

/**
 * Rough HTML → readable text: keeps headings, links, list items and paragraphs. It walks the tags and
 * text once, front to back, with no pattern that could backtrack: a page is fetched from anywhere, and
 * one full of unclosed tags used to take hours here, with the whole app frozen.
 */
export function htmlToText(html: string): string {
  let out = '';
  let link: { href?: string; text: string } | undefined;
  let skipping = ''; // inside <script> and the like: the element whose end tag is awaited
  const emit = (t: string) => {
    if (link) link.text += t;
    else out += t;
  };
  const endLink = () => {
    if (!link) return;
    const { href = '', text } = link;
    link = undefined;
    const t = text.trim();
    out += t && href && !href.startsWith('#') && !href.startsWith('javascript:') ? `[${t}](${href})` : t;
  };
  const token = /<[^<>]*>|[^<]+|</g;
  const source = dropComments(html.slice(0, MAX_HTML));
  for (let m = token.exec(source); m; m = token.exec(source)) {
    const t = m[0];
    const tag = t.length > 1 && t[0] === '<' ? /^<(\/?)([a-z][\w-]*)/i.exec(t) : null;
    if (!tag) {
      // Text, or a stray "<"; anything else in angle brackets (<!doctype html>, a < b > c) is dropped.
      if (!skipping && (t[0] !== '<' || t === '<')) emit(t);
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (skipping) {
      if (closing && name === skipping) skipping = '';
    } else if (!closing && SKIPPED.has(name)) skipping = name;
    else if (/^h[1-6]$/.test(name)) emit(closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `);
    else if (name === 'a') {
      endLink();
      if (!closing) link = { href: /\shref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(t)?.slice(1).find(v => v !== undefined), text: '' };
    } else if (name === 'li' && !closing) emit('\n- ');
    else if (name === 'pre') emit('\n```\n');
    else if ((name === 'br' || name === 'hr') && !closing) emit('\n');
    else if (closing && BLOCK_ENDS.has(name)) emit('\n\n');
  }
  endLink();
  let s = out;
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isNaN(code)) return m;
      // As in browsers: NUL, surrogates and anything past U+10FFFF (which fromCodePoint throws on) become U+FFFD.
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The URL rules for every request, redirects included: http(s) only, and plain http only for localhost. */
function checkUrl(url: URL): string | undefined {
  if (!['http:', 'https:'].includes(url.protocol)) return 'Only http and https URLs are supported.';
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) url.protocol = 'https:';
  return undefined;
}

export const WebFetchTool: Tool<{ url: string }> = {
  name: 'WebFetch',
  description:
    'Fetch a web page (http/https) and return its content as readable text/markdown. Use it to read ' +
    'documentation, issues or articles the user points to. Long pages are truncated. A redirect to another ' +
    'host is not followed: you get its URL and can fetch that with another call.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Fully-formed URL, e.g. https://example.com/docs' } },
    required: ['url'],
  },
  readOnly: false,
  label: i => i.url,
  async run(input, ctx) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { output: `Invalid URL: ${input.url}`, isError: true };
    }
    const invalid = checkUrl(url);
    if (invalid) return { output: invalid, isError: true };

    const stop = new AbortController(); // drops the connection once we know the body is not wanted
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), stop.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const headers = { 'User-Agent': 'zoicode/0.1 (+cli)', Accept: 'text/html,text/plain,application/json,*/*' };
    let res: Response;
    try {
      // Redirects are followed by hand, so every hop gets the URL rules and a hop to another host is not fetched:
      // the user approved this host (permission rules are per host), not wherever it chooses to send us.
      for (let current = url, hops = 0; ; hops++) {
        res = await fetch(current, { signal, redirect: 'manual', headers });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) break;
        await res.body?.cancel();
        const next = new URL(location, current);
        const invalidNext = checkUrl(next);
        if (invalidNext) return { output: `${current.href} redirects to ${next.href}. ${invalidNext}`, isError: true };
        if (next.hostname !== url.hostname) {
          return {
            output: `${current.href} redirects to a different host: ${next.href}\nIt was not fetched. Call WebFetch again with that URL if you need it.`,
            summary: `Redirects to ${next.hostname}`,
          };
        }
        if (hops === MAX_REDIRECTS) return { output: `Too many redirects (last: ${next.href}).`, isError: true };
        current = next;
      }
    } catch (e) {
      return { output: `Fetch failed: ${(e as Error).message}`, isError: true };
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/text|json|xml|javascript/.test(type) && type) {
      stop.abort();
      return { output: `Unsupported content type: ${type}`, isError: true };
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_BYTES) {
      stop.abort();
      return { output: `Response too large (${declared} bytes).`, isError: true };
    }
    // Content-Length is only a shortcut: chunked replies don't send it, and with Content-Encoding it is the
    // compressed size. So the decoded bytes are counted as they arrive, and reading stops past the limit.
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          stop.abort();
          return { output: `Response too large (over ${MAX_BYTES} bytes).`, isError: true };
        }
        chunks.push(value);
      }
    } catch (e) {
      return { output: `Fetch failed while reading the response: ${(e as Error).message}`, isError: true };
    }
    const buf = Buffer.concat(chunks);
    const raw = buf.toString('utf8');
    const isHtml = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw);
    const body = isHtml ? htmlToText(raw) : raw;
    const title = isHtml ? htmlToText(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') : '';
    const header = `URL: ${res.url}\nStatus: ${res.status} ${res.statusText}\n${title ? `Title: ${title}\n` : ''}\n`;
    return {
      output: header + truncate(body, 40_000),
      isError: !res.ok,
      summary: `${res.status} · ${Math.round(buf.length / 1024)} KB · ${body.split('\n').length} lines`,
    };
  },
};
