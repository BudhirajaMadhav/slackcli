/**
 * Curl command parser for extracting Slack authentication tokens
 */

import type { BrowserRequestSnapshot } from '../types/index.ts';

export interface ParsedCurlResult {
  workspaceName: string;
  workspaceUrl: string;
  xoxd: string;
  xoxc: string;
  /** The Cookie header exactly as copied. A secret: it holds the `d` session cookie. */
  cookie: string;
  /** The browser's identifying headers, stable query parameters and constant form fields. */
  request: BrowserRequestSnapshot;
}

export interface ParseError {
  field: 'workspace' | 'xoxd' | 'xoxc';
  message: string;
}

/**
 * Extract the workspace name (first subdomain segment) from a Slack workspace URL.
 * Handles both standard (myorg.slack.com) and enterprise (myorg.enterprise.slack.com) URLs.
 * Returns 'workspace' if the URL does not match.
 */
export function extractSlackWorkspaceName(url: string): string {
  const match = /https?:\/\/([\w.-]+)\.slack\.com/.exec(url);
  return match ? match[1].split('.')[0] : 'workspace';
}

const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// Bash's numeric escapes inside $'...': \xHH, \uHHHH, \UHHHHHHHH and octal \NNN.
// Chrome writes control characters and `!` as \uHHHH; a surrogate pair arrives
// as two \u escapes, which fromCharCode joins back up.
const ANSI_C_NUMERIC: Record<string, { digits: RegExp; radix: number; max: number }> = {
  x: { digits: /^[0-9a-fA-F]{1,2}/, radix: 16, max: 2 },
  u: { digits: /^[0-9a-fA-F]{1,4}/, radix: 16, max: 4 },
  U: { digits: /^[0-9a-fA-F]{1,8}/, radix: 16, max: 8 },
};

/** Decode one escape inside $'...' starting after the backslash; returns [text, next index]. */
function readAnsiCEscape(input: string, i: number): [string, number] {
  const c = input[i];
  if (c === undefined) return ['\\', i];
  if (c in ANSI_C_ESCAPES) return [ANSI_C_ESCAPES[c], i + 1];
  const numeric = ANSI_C_NUMERIC[c];
  if (numeric) {
    const digits = numeric.digits.exec(input.slice(i + 1, i + 1 + numeric.max))?.[0];
    if (!digits) return ['\\' + c, i + 1];
    const code = Number.parseInt(digits, numeric.radix);
    const text = c === 'U' && code <= 0x10ffff ? String.fromCodePoint(code) : String.fromCharCode(code);
    return [text, i + 1 + digits.length];
  }
  const octal = /^[0-7]{1,3}/.exec(input.slice(i, i + 3))?.[0];
  if (octal) return [String.fromCharCode(Number.parseInt(octal, 8)), i + octal.length];
  return ['\\' + c, i + 1];
}

/** Read a $'...' body starting after the opening quote; returns [text, next index]. */
function readAnsiC(input: string, start: number): [string, number] {
  let out = '';
  let i = start;
  while (i < input.length && input[i] !== "'") {
    if (input[i] === '\\') {
      const [text, next] = readAnsiCEscape(input, i + 1);
      out += text;
      i = next;
    } else {
      out += input[i++];
    }
  }
  return [out, i + 1];
}

/** Read a "..." body starting after the opening quote; returns [text, next index]. */
function readDoubleQuoted(input: string, start: number): [string, number] {
  let out = '';
  let i = start;
  while (i < input.length && input[i] !== '"') {
    const next = input[i + 1];
    if (input[i] === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
      if (next !== '\n') out += next;
      i += 2;
    } else {
      out += input[i++];
    }
  }
  return [out, i + 1];
}

function isBlank(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** Length of a backslash line continuation (`\` + LF or CRLF) at `i`, else 0. */
function continuationAt(input: string, i: number): number {
  if (input[i] !== '\\') return 0;
  if (input[i + 1] === '\n') return 2;
  return input[i + 1] === '\r' && input[i + 2] === '\n' ? 3 : 0;
}

/**
 * Split a shell command into words the way bash does for the quoting a
 * browser's "Copy as cURL" produces: '...' literal, $'...' with ANSI-C escapes
 * (Chrome's multipart body, and any value holding a quote or control
 * character), "..." and $"..." with their escapes, backslash-newline
 * continuations and bare backslash escapes. An unclosed quote runs to the end
 * of the input. One pass, no backtracking, so the cost stays linear in the
 * input whatever it holds (#213).
 */
export function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    const continuation = continuationAt(input, i);
    if (continuation) {
      i += continuation;
      continue;
    }
    if (isBlank(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      i += 1;
      continue;
    }
    inWord = true;
    let text: string;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      text = input.slice(i + 1, end === -1 ? input.length : end);
      i = end === -1 ? input.length : end + 1;
    } else if (c === '$' && input[i + 1] === "'") {
      [text, i] = readAnsiC(input, i + 2);
    } else if (c === '"' || (c === '$' && input[i + 1] === '"')) {
      [text, i] = readDoubleQuoted(input, input.indexOf('"', i) + 1);
    } else if (c === '\\') {
      text = input[i + 1] ?? '';
      i += 2;
    } else {
      text = c;
      i += 1;
    }
    word += text;
  }
  if (inWord) words.push(word);
  return words;
}

// The cURL options this parser reads, and the other ones a copied request uses
// that take a value — skipped as a pair, so their value is never taken for the
// URL. `--data-binary` and `--data-urlencode` stay unread (#214). An option not
// listed is treated as a switch such as `--compressed`.
const OPTIONS_WITH_VALUE = new Map<string, 'url' | 'header' | 'cookie' | 'data' | 'other'>([
  ['--url', 'url'],
  ['-H', 'header'],
  ['--header', 'header'],
  ['-b', 'cookie'],
  ['--cookie', 'cookie'],
  ['-d', 'data'],
  ['--data', 'data'],
  ['--data-raw', 'data'],
  ['--data-binary', 'other'],
  ['--data-urlencode', 'other'],
  ['--data-ascii', 'other'],
  ['-X', 'other'],
  ['--request', 'other'],
  ['-A', 'other'],
  ['--user-agent', 'other'],
  ['-e', 'other'],
  ['--referer', 'other'],
  ['-F', 'other'],
  ['--form', 'other'],
  ['-u', 'other'],
  ['--user', 'other'],
  ['-o', 'other'],
  ['--output', 'other'],
  ['-x', 'other'],
  ['--proxy', 'other'],
]);

interface CurlArguments {
  url?: string;
  headers: Array<[string, string]>;
  // Every -b/--cookie value and Cookie: header value, in command order.
  cookies: string[];
  body?: string;
}

/** Sort a cURL command's words into what the parser reads. */
function readCurlArguments(words: string[]): CurlArguments {
  const args: CurlArguments = { headers: [], cookies: [] };
  let positionalUrl: string | undefined;
  for (let i = 1; i < words.length; i += 1) {
    let option = words[i];
    let value: string | undefined;
    // `--url=value` is not cURL syntax, but hand-edited commands use it.
    const equals = option.indexOf('=');
    if (option.startsWith('--') && equals > 0) {
      value = option.slice(equals + 1);
      option = option.slice(0, equals);
    }
    const kind = OPTIONS_WITH_VALUE.get(option);
    if (!kind) {
      if (!option.startsWith('-')) positionalUrl ??= option;
      continue;
    }
    value ??= words[++i];
    if (value === undefined) break;
    if (kind === 'url') args.url ??= value;
    // The first body option wins, as the leftmost match always has.
    else if (kind === 'data') args.body ??= value;
    else if (kind === 'cookie') args.cookies.push(value);
    else if (kind === 'header') {
      const header = splitHeader(value);
      if (header?.[0] === 'cookie') args.cookies.push(header[1]);
      else if (header) args.headers.push(header);
    }
  }
  args.url ??= positionalUrl;
  return args;
}

/** `name: value` of a `-H` argument, name lower-cased; null when it has no colon. */
function splitHeader(header: string): [string, string] | null {
  const colon = header.indexOf(':');
  if (colon <= 0) return null;
  return [header.slice(0, colon).trim().toLowerCase(), header.slice(colon + 1).trim()];
}

/**
 * Request headers that are about this one request, its transport or its
 * credentials rather than about the client. Everything else a browser sent
 * (user-agent, accept, accept-language, origin, referer, sec-ch-ua*,
 * sec-fetch-*, priority, ...) is kept. The Cookie header is kept apart, as a
 * secret; authorization is a secret too and is never kept at all.
 */
const PER_REQUEST_HEADERS = new Set([
  'content-type', 'content-length', 'host', 'cookie', 'authorization', 'proxy-authorization',
  'accept-encoding', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te',
  'upgrade', 'expect', 'if-none-match', 'if-modified-since',
]);

/** The query parameters of the web client's API URL that change on every call. */
const PER_REQUEST_QUERY = new Set(['_x_id', '_x_num_retries', '_x_reason']);

/** The form fields the web client sends with the same value on every API call. */
const CONSTANT_FORM_FIELDS = new Set(['_x_mode', '_x_sonic', '_x_app_name']);

/** A web-client query parameter that holds for the session (slack_route, fp, _x_csid, ...). */
function isStableQueryParam(name: string): boolean {
  if (PER_REQUEST_QUERY.has(name)) return false;
  return name === 'slack_route' || name === 'fp' || name.startsWith('_x_');
}

/** Whether fetch() accepts this header; an invalid one would fail every call. */
function isSendableHeader(name: string, value: string): boolean {
  try {
    new Headers([[name, value]]);
    return true;
  } catch {
    return false;
  }
}

/** Every top-level field of a request body: multipart, JSON or urlencoded. */
function bodyFields(body: string): Array<[string, string]> {
  if (body.includes('Content-Disposition: form-data')) {
    return [...body.matchAll(/name="([^"]+)"\r?\n\r?\n([^\r\n]*)/g)].map((m) => [m[1], m[2]]);
  }
  if (body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      return Object.entries(parsed ?? {}).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : []));
    } catch {
      return [];
    }
  }
  return [...new URLSearchParams(body)];
}

/**
 * What to replay from a browser's API request: its identifying headers, the
 * stable query parameters of its URL and the constant fields of its body.
 * Shared by `parse-curl` and `login-auto`, so both keep the same set.
 */
export function snapshotBrowserRequest(
  url: string,
  headers: Iterable<[string, string]>,
  body: string,
): BrowserRequestSnapshot {
  const snapshot: BrowserRequestSnapshot = { headers: {}, query: {}, form: {} };
  for (const [rawName, value] of headers) {
    const name = rawName.trim().toLowerCase();
    if (!value || PER_REQUEST_HEADERS.has(name) || !isSendableHeader(name, value)) continue;
    snapshot.headers[name] = value;
  }
  try {
    for (const [name, value] of new URL(url).searchParams) {
      if (isStableQueryParam(name)) snapshot.query[name] = value;
    }
  } catch {
    // No URL, no query to keep.
  }
  for (const [name, value] of bodyFields(body)) {
    if (CONSTANT_FORM_FIELDS.has(name)) snapshot.form[name] = value;
  }
  return snapshot;
}

/** The workspace origin of a Slack URL, or null when it is not on a slack.com host. */
function slackWorkspaceUrl(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    host = parsed.hostname;
  } catch {
    return null;
  }
  return /^[\w.-]+\.slack\.com$/.test(host) ? `https://${host}` : null;
}

/**
 * Parse a cURL command and extract Slack authentication tokens
 */
export function parseCurlCommand(curlInput: string): ParsedCurlResult {
  const args = readCurlArguments(shellWords(curlInput));

  // The URL is either positional (curl 'https://...') or behind the --url flag
  // (curl --url 'https://...'), which Chrome 151+ DevTools emits for "Copy as cURL".
  // The domain can be myorg.slack.com or myorg.enterprise.slack.com.
  const workspaceUrl = slackWorkspaceUrl(args.url);
  if (!workspaceUrl) {
    throw new CurlParseError('workspace', 'Could not find Slack workspace URL in cURL command');
  }
  const workspaceName = extractSlackWorkspaceName(workspaceUrl);

  // Supports: -b 'cookies', --cookie 'cookies', -H 'Cookie: cookies'; the
  // first one that is not blank wins.
  const cookie = args.cookies.map((value) => value.trim()).find(Boolean) ?? '';
  const xoxdMatch = /(?:^|;\s*)d=(xoxd-[^;]+)/.exec(cookie);
  if (!xoxdMatch) {
    throw new CurlParseError('xoxd', 'Could not find xoxd token in cookie header (d=xoxd-...)');
  }
  const xoxd = decodeURIComponent(xoxdMatch[1]);

  const body = args.body ?? '';
  const xoxcMatch =
    /name="token"[\s\S]*?(xoxc-[a-zA-Z0-9-]+)/.exec(body) ||
    /"token"\s*:\s*"(xoxc-[a-zA-Z0-9-]+)"/.exec(body);
  if (!xoxcMatch) {
    throw new CurlParseError('xoxc', 'Could not find xoxc token in request data');
  }

  return {
    workspaceName,
    workspaceUrl,
    xoxd,
    xoxc: xoxcMatch[1],
    cookie,
    request: snapshotBrowserRequest(args.url ?? '', args.headers, body),
  };
}

/**
 * Custom error class for cURL parsing errors
 */
export class CurlParseError extends Error {
  public field: ParseError['field'];

  constructor(field: ParseError['field'], message: string) {
    super(message);
    this.name = 'CurlParseError';
    this.field = field;
  }
}

/**
 * Validate that a string looks like a cURL command
 */
export function looksLikeCurlCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith('curl ') || trimmed.startsWith('curl\t');
}
