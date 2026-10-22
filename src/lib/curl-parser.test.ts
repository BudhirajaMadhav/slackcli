import { describe, expect, it } from 'bun:test';
import {
  parseCurlCommand,
  CurlParseError,
  looksLikeCurlCommand,
  extractSlackWorkspaceName,
  shellWords,
  snapshotBrowserRequest,
} from './curl-parser';

// Sample cURL command with anonymized tokens (based on real Slack API request format)
const SAMPLE_CURL_COMMAND = `curl 'https://myworkspace.slack.com/api/conversations.view?_x_id=noversion-1770041775.173&_x_version_ts=1770035254&_x_frontend_build_type=current&_x_desktop_ia=4&_x_gantry=true&fp=66&_x_num_retries=0' \\
  -H 'accept: */*' \\
  -H 'accept-language: en-US,en-GB;q=0.9,en;q=0.8,de-DE;q=0.7,de;q=0.6' \\
  -H 'content-type: multipart/form-data; boundary=----WebKitFormBoundaryBPkbAXdra05yI37u' \\
  -b 'cjConsent=MHxZfDB8Tnww; ssb_instance_id=53f4c0a9-f40a-4a88-9324-d24baa3bff28; d=xoxd-XXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX; lc=1770041685' \\
  -H 'origin: https://app.slack.com' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \\
  --data-raw $'------WebKitFormBoundaryBPkbAXdra05yI37u\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-XXXXXXXXXX-XXXXXXXXXX-XXXXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\\r\\n------WebKitFormBoundaryBPkbAXdra05yI37u\\r\\nContent-Disposition: form-data; name="channel"\\r\\n\\r\\nC038K56TGNB\\r\\n------WebKitFormBoundaryBPkbAXdra05yI37u--\\r\\n'`;

// Alternative format with -H 'Cookie:' header instead of -b
const CURL_WITH_COOKIE_HEADER = `curl 'https://testteam.slack.com/api/users.list' \\
  -H 'Cookie: d=xoxd-AAAABBBBCCCCDDDD-1234567890' \\
  --data-raw $'------WebKitFormBoundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-111222333-444555666-abcdefghij\\r\\n------WebKitFormBoundary--\\r\\n'`;

// Format with --cookie flag
const CURL_WITH_COOKIE_FLAG = `curl 'https://anotherteam.slack.com/api/channels.list' \\
  --cookie 'd=xoxd-TESTTOKEN-12345; other=value' \\
  --data $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-test-token-123\\r\\n------Boundary--\\r\\n'`;

// URL-encoded xoxd token (common in real requests)
const CURL_WITH_ENCODED_TOKEN = `curl 'https://encoded.slack.com/api/test' \\
  -b 'd=xoxd-encoded%2Btoken%2Fwith%3Dspecial' \\
  --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-encoded-test\\r\\n------Boundary--\\r\\n'`;

// Enterprise workspace URL format
const CURL_ENTERPRISE = `curl 'https://myorg.enterprise.slack.com/api/conversations.suggestions?_x_id=475c2359-1772039256.240' \\
  -b 'd=xoxd-enterprise-test-token; other=value' \\
  --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-enterprise-test\\r\\n------Boundary--\\r\\n'`;

// Single line format (no backslashes)
const CURL_SINGLE_LINE = `curl 'https://singleline.slack.com/api/test' -b 'd=xoxd-single-line-token' --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-single-line\\r\\n------Boundary--\\r\\n'`;

// JSON body format (used by some Slack API endpoints)
const CURL_JSON_BODY = `curl 'https://jsonworkspace.slack.com/api/some.method' \\
  -H 'content-type: application/json' \\
  -b 'd=xoxd-json-test-token' \\
  --data-raw '{"token":"xoxc-json-test-111-222","as_admin":false}'`;

// Chrome 151+ "Copy as cURL" prefixes the target URL with the --url flag
const CURL_CHROME_151_URL_FLAG = `curl --url 'https://chrometeam.slack.com/api/conversations.view?_x_id=noversion-1770041775.173' \\
  -H 'accept: */*' \\
  -b 'ssb_instance_id=53f4c0a9-f40a-4a88-9324-d24baa3bff28; d=xoxd-chrome151-test-token; lc=1770041685' \\
  -H 'origin: https://app.slack.com' \\
  --data-raw $'------WebKitFormBoundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-chrome151-test\\r\\n------WebKitFormBoundary--\\r\\n'`;

// curl itself rejects --url=value, but hand-edited commands use it — accept it defensively.
// Enterprise domain, double-quoted URL.
const CURL_URL_FLAG_EQUALS = `curl --url="https://chromeorg.enterprise.slack.com/api/users.list" \\
  -b 'd=xoxd-url-equals-token' \\
  --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-url-equals-test\\r\\n------Boundary--\\r\\n'`;

describe('parseCurlCommand', () => {
  /** The `field` of the CurlParseError thrown for `curl`, or undefined if it parses. */
  function parseErrorField(curl: string): string | undefined {
    try {
      parseCurlCommand(curl);
    } catch (e) {
      return (e as CurlParseError).field;
    }
    return undefined;
  }

  describe('workspace extraction', () => {
    it('should extract workspace name and URL from standard curl command', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);
      expect(result.workspaceName).toBe('myworkspace');
      expect(result.workspaceUrl).toBe('https://myworkspace.slack.com');
    });

    it('should extract workspace from different team URLs', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
      expect(result.workspaceName).toBe('testteam');
      expect(result.workspaceUrl).toBe('https://testteam.slack.com');
    });

    it('should extract workspace from enterprise URLs', () => {
      const result = parseCurlCommand(CURL_ENTERPRISE);
      expect(result.workspaceName).toBe('myorg');
      expect(result.workspaceUrl).toBe('https://myorg.enterprise.slack.com');
    });

    it('should handle single-line curl commands', () => {
      const result = parseCurlCommand(CURL_SINGLE_LINE);
      expect(result.workspaceName).toBe('singleline');
    });

    it('should extract workspace from Chrome 151+ --url flag format', () => {
      const result = parseCurlCommand(CURL_CHROME_151_URL_FLAG);
      expect(result.workspaceName).toBe('chrometeam');
      expect(result.workspaceUrl).toBe('https://chrometeam.slack.com');
    });

    it('should extract workspace from the --url=value spelling', () => {
      const result = parseCurlCommand(CURL_URL_FLAG_EQUALS);
      expect(result.workspaceName).toBe('chromeorg');
      expect(result.workspaceUrl).toBe('https://chromeorg.enterprise.slack.com');
    });

    it('should prefer the --url target over a Slack URL in an earlier header', () => {
      const curlWithDecoyHeader = `curl -H 'referer: https://decoyteam.slack.com/' --url 'https://realteam.slack.com/api/test' -b 'd=xoxd-decoy-test' --data-raw '{"token":"xoxc-decoy-test"}'`;
      const result = parseCurlCommand(curlWithDecoyHeader);
      expect(result.workspaceName).toBe('realteam');
    });

    it('should throw CurlParseError for missing workspace URL', () => {
      const invalidCurl = `curl 'https://example.com/api/test' -b 'd=xoxd-token'`;
      expect(() => parseCurlCommand(invalidCurl)).toThrow(CurlParseError);
      try {
        parseCurlCommand(invalidCurl);
      } catch (e) {
        expect((e as CurlParseError).field).toBe('workspace');
      }
    });
  });

  describe('xoxd token extraction', () => {
    it('should extract xoxd token from -b flag', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);
      expect(result.xoxd).toMatch(/^xoxd-/);
    });

    it('should extract xoxd token from -H Cookie header', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
      expect(result.xoxd).toBe('xoxd-AAAABBBBCCCCDDDD-1234567890');
    });

    it('should extract xoxd token from --cookie flag', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_FLAG);
      expect(result.xoxd).toBe('xoxd-TESTTOKEN-12345');
    });

    it('should decode URL-encoded xoxd tokens', () => {
      const result = parseCurlCommand(CURL_WITH_ENCODED_TOKEN);
      expect(result.xoxd).toBe('xoxd-encoded+token/with=special');
    });

    it('should throw CurlParseError for missing xoxd token', () => {
      const curlWithoutXoxd = `curl 'https://test.slack.com/api/test' -b 'other=value' --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-test\\r\\n------Boundary--\\r\\n'`;
      expect(() => parseCurlCommand(curlWithoutXoxd)).toThrow(CurlParseError);
      try {
        parseCurlCommand(curlWithoutXoxd);
      } catch (e) {
        expect((e as CurlParseError).field).toBe('xoxd');
      }
    });
  });

  describe('cookie header matching (#213)', () => {
    const URL = `curl 'https://test.slack.com/api/test'`;
    const DATA = `--data 'name="token" xoxc-test'`;

    it('should stay linear on a Cookie header of 50,000 spaces with no closing quote', () => {
      const curl = `${URL} -H 'Cookie:${' '.repeat(50_000)}`;
      const start = performance.now();
      const field = parseErrorField(curl);
      const ms = performance.now() - start;
      expect(field).toBe('xoxd');
      expect(ms).toBeLessThan(100);
    });

    it('should skip whitespace between "Cookie:" and the value', () => {
      const result = parseCurlCommand(`${URL} -H 'cookie: \t  d=xoxd-spaced; x=1' ${DATA}`);
      expect(result.xoxd).toBe('xoxd-spaced');
    });

    it('should use the first cookie source when several are present', () => {
      const bFirst = `${URL} -b 'd=xoxd-from-b' -H 'Cookie: d=xoxd-from-header' ${DATA}`;
      expect(parseCurlCommand(bFirst).xoxd).toBe('xoxd-from-b');

      const headerFirst = `${URL} -H 'Cookie: d=xoxd-from-header' --cookie 'd=xoxd-from-cookie' ${DATA}`;
      expect(parseCurlCommand(headerFirst).xoxd).toBe('xoxd-from-header');

      const cookieFirst = `${URL} --cookie 'd=xoxd-from-cookie' -b 'd=xoxd-from-b' ${DATA}`;
      expect(parseCurlCommand(cookieFirst).xoxd).toBe('xoxd-from-cookie');
    });

    it('should not treat a whitespace-only Cookie header as a cookie value', () => {
      // An empty header previously shadowed a later -b; it is now skipped.
      const curl = `${URL} -H 'Cookie:   ' -b 'd=xoxd-later' ${DATA}`;
      expect(parseCurlCommand(curl).xoxd).toBe('xoxd-later');
      expect(parseErrorField(`${URL} -H 'Cookie:   ' ${DATA}`)).toBe('xoxd');
    });
  });

  describe('xoxc token extraction', () => {
    it('should extract xoxc token from --data-raw', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);
      expect(result.xoxc).toMatch(/^xoxc-/);
    });

    it('should extract xoxc token from --data flag', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_FLAG);
      expect(result.xoxc).toBe('xoxc-test-token-123');
    });

    it('should handle different token formats', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
      expect(result.xoxc).toBe('xoxc-111222333-444555666-abcdefghij');
    });

    it('should extract xoxc token from JSON body format', () => {
      const result = parseCurlCommand(CURL_JSON_BODY);
      expect(result.xoxc).toBe('xoxc-json-test-111-222');
    });

    it('should throw CurlParseError for missing xoxc token', () => {
      const curlWithoutXoxc = `curl 'https://test.slack.com/api/test' -b 'd=xoxd-test' --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="other"\\r\\n\\r\\nvalue\\r\\n------Boundary--\\r\\n'`;
      expect(() => parseCurlCommand(curlWithoutXoxc)).toThrow(CurlParseError);
      try {
        parseCurlCommand(curlWithoutXoxc);
      } catch (e) {
        expect((e as CurlParseError).field).toBe('xoxc');
      }
    });
  });

  describe('request body flag matching (#214)', () => {
    const URL = `curl 'https://test.slack.com/api/test' -b 'd=xoxd-test'`;
    const LATER_BODY = `--data-raw '{"token":"xoxc-later"}'`;

    // A double-quoted body cannot hold the quoted "token" key the xoxc
    // extraction needs, so these prove the form is matched by showing it takes
    // the place of a later, valid single-quoted body.
    it.each([
      ['--data-raw "a=1"'],
      ['--data "a=1"'],
      ['--data-raw $"a=1"'],
      ['--data $"a=1"'],
    ])('should match a double-quoted body: %s', (body) => {
      expect(parseErrorField(`${URL} ${body} ${LATER_BODY}`)).toBe('xoxc');
    });

    it('should extract xoxc token from --data with a plain single-quoted body', () => {
      const result = parseCurlCommand(`${URL} --data '{"token":"xoxc-plain-data"}'`);
      expect(result.xoxc).toBe('xoxc-plain-data');
    });

    it('should use the leftmost body flag when --data and --data-raw are both present', () => {
      const dataFirst = `${URL} --data '{"token":"xoxc-from-data"}' --data-raw '{"token":"xoxc-from-raw"}'`;
      expect(parseCurlCommand(dataFirst).xoxc).toBe('xoxc-from-data');

      const rawFirst = `${URL} --data-raw '{"token":"xoxc-from-raw"}' --data '{"token":"xoxc-from-data"}'`;
      expect(parseCurlCommand(rawFirst).xoxc).toBe('xoxc-from-raw');
    });

    it.each([
      ['--data-binary'],
      ['--data-urlencode'],
    ])('should not read the body of unsupported flag %s', (flag) => {
      expect(parseErrorField(`${URL} ${flag} '{"token":"xoxc-unsupported"}'`)).toBe('xoxc');
    });
  });

  describe('complete parsing', () => {
    it('should parse all tokens from a complete curl command', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);

      expect(result).toHaveProperty('workspaceName');
      expect(result).toHaveProperty('workspaceUrl');
      expect(result).toHaveProperty('xoxd');
      expect(result).toHaveProperty('xoxc');

      expect(result.workspaceName).toBeTruthy();
      expect(result.workspaceUrl).toContain('slack.com');
      expect(result.xoxd).toMatch(/^xoxd-/);
      expect(result.xoxc).toMatch(/^xoxc-/);
    });

    it('should handle real-world curl command formats', () => {
      // Test with various real-world formats
      const formats = [
        SAMPLE_CURL_COMMAND,
        CURL_WITH_COOKIE_HEADER,
        CURL_WITH_COOKIE_FLAG,
        CURL_SINGLE_LINE,
        CURL_ENTERPRISE,
        CURL_CHROME_151_URL_FLAG,
        CURL_URL_FLAG_EQUALS,
      ];

      for (const curl of formats) {
        const result = parseCurlCommand(curl);
        expect(result.xoxd).toMatch(/^xoxd-/);
        expect(result.xoxc).toMatch(/^xoxc-/);
      }
    });
  });
});

describe('CurlParseError', () => {
  it('should have correct name and field properties', () => {
    const error = new CurlParseError('workspace', 'Test error');
    expect(error.name).toBe('CurlParseError');
    expect(error.field).toBe('workspace');
    expect(error.message).toBe('Test error');
  });

  it('should be an instance of Error', () => {
    const error = new CurlParseError('xoxd', 'Test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CurlParseError);
  });
});

describe('extractSlackWorkspaceName', () => {
  it('should extract name from standard URL', () => {
    expect(extractSlackWorkspaceName('https://myorg.slack.com')).toBe('myorg');
  });

  it('should extract first segment from enterprise URL', () => {
    expect(extractSlackWorkspaceName('https://myorg.enterprise.slack.com')).toBe('myorg');
  });

  it('should return workspace for non-matching URL', () => {
    expect(extractSlackWorkspaceName('https://example.com')).toBe('workspace');
  });

  it('should handle URLs with paths', () => {
    expect(extractSlackWorkspaceName('https://myorg.slack.com/api/test')).toBe('myorg');
  });
});

describe('looksLikeCurlCommand', () => {
  it('should return true for valid curl commands', () => {
    expect(looksLikeCurlCommand("curl 'https://example.com'")).toBe(true);
    expect(looksLikeCurlCommand('curl "https://example.com"')).toBe(true);
    expect(looksLikeCurlCommand('curl https://example.com')).toBe(true);
    expect(looksLikeCurlCommand('  curl https://example.com')).toBe(true);
    expect(looksLikeCurlCommand('\ncurl https://example.com')).toBe(true);
  });

  it('should return false for non-curl content', () => {
    expect(looksLikeCurlCommand('https://example.com')).toBe(false);
    expect(looksLikeCurlCommand('wget https://example.com')).toBe(false);
    expect(looksLikeCurlCommand('some random text')).toBe(false);
    expect(looksLikeCurlCommand('')).toBe(false);
    expect(looksLikeCurlCommand('curlhttps://example.com')).toBe(false);
  });

  it('should handle curl with tab separator', () => {
    expect(looksLikeCurlCommand('curl\thttps://example.com')).toBe(true);
  });
});

// A Chrome "Copy as cURL (bash)" of an Enterprise Grid API call, all values fake:
// positional URL, $'...' multipart body, the client-hint and fetch-metadata
// headers, and a cookie value Chrome had to put in $'...' because of its `!`.
const CHROME_GRID_COPY = `curl 'https://acme.enterprise.slack.com/api/client.counts?_x_id=8c2a4f1e-1770041775.173&_x_csid=FAKE-csid&slack_route=E000FAKE%3AT000FAKE&_x_version_ts=1770035254&_x_frontend_build_type=current&_x_desktop_ia=4&_x_gantry=true&fp=c7&_x_num_retries=0' \\
  -H 'accept: */*' \\
  -H 'accept-language: en-GB,en;q=0.9' \\
  -H 'content-type: multipart/form-data; boundary=----WebKitFormBoundaryFAKE' \\
  -b $'b=fakeb; x=fakex\\u0021; d=xoxd-FAKE%2Fsession%3D; d-s=1770000000; lc=1770041685' \\
  -H 'origin: https://app.slack.com' \\
  -H 'priority: u=1, i' \\
  -H 'referer: https://app.slack.com/' \\
  -H 'sec-ch-ua: "Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "macOS"' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'sec-fetch-site: same-site' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' \\
  --data-raw $'------WebKitFormBoundaryFAKE\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-FAKE-111-222-abc\\r\\n------WebKitFormBoundaryFAKE\\r\\nContent-Disposition: form-data; name="_x_reason"\\r\\n\\r\\nclient-counts-api/fetchClientCounts\\r\\n------WebKitFormBoundaryFAKE\\r\\nContent-Disposition: form-data; name="_x_mode"\\r\\n\\r\\nonline\\r\\n------WebKitFormBoundaryFAKE\\r\\nContent-Disposition: form-data; name="_x_sonic"\\r\\n\\r\\ntrue\\r\\n------WebKitFormBoundaryFAKE\\r\\nContent-Disposition: form-data; name="_x_app_name"\\r\\n\\r\\nclient\\r\\n------WebKitFormBoundaryFAKE--\\r\\n'`;

const CHROME_GRID_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-GB,en;q=0.9',
  'origin': 'https://app.slack.com',
  'priority': 'u=1, i',
  'referer': 'https://app.slack.com/',
  'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('browser request capture', () => {
  it('keeps the full cookie string as copied, decoding only the shell quoting', () => {
    const result = parseCurlCommand(CHROME_GRID_COPY);
    expect(result.cookie).toBe('b=fakeb; x=fakex!; d=xoxd-FAKE%2Fsession%3D; d-s=1770000000; lc=1770041685');
    expect(result.xoxd).toBe('xoxd-FAKE/session=');
    expect(result.xoxc).toBe('xoxc-FAKE-111-222-abc');
    expect(result.workspaceUrl).toBe('https://acme.enterprise.slack.com');
  });

  it('keeps the identifying headers and drops content-type and the cookie', () => {
    expect(parseCurlCommand(CHROME_GRID_COPY).request.headers).toStrictEqual(CHROME_GRID_HEADERS);
  });

  it('keeps the stable query parameters and drops the per-request ones', () => {
    expect(parseCurlCommand(CHROME_GRID_COPY).request.query).toStrictEqual({
      _x_csid: 'FAKE-csid',
      slack_route: 'E000FAKE:T000FAKE',
      _x_version_ts: '1770035254',
      _x_frontend_build_type: 'current',
      _x_desktop_ia: '4',
      _x_gantry: 'true',
      fp: 'c7',
    });
  });

  it('keeps the constant form fields and drops _x_reason and the token', () => {
    expect(parseCurlCommand(CHROME_GRID_COPY).request.form).toStrictEqual({
      _x_mode: 'online',
      _x_sonic: 'true',
      _x_app_name: 'client',
    });
  });

  it('reads the same request when the URL follows --url (Chrome 151+)', () => {
    const urlFlag = CHROME_GRID_COPY.replace("curl 'https://", "curl --url 'https://");
    expect(parseCurlCommand(urlFlag)).toStrictEqual(parseCurlCommand(CHROME_GRID_COPY));
  });

  it('reads the same request from one line with CRLF continuations', () => {
    const crlf = CHROME_GRID_COPY.replaceAll('\\\n', '\\\r\n');
    expect(parseCurlCommand(crlf)).toStrictEqual(parseCurlCommand(CHROME_GRID_COPY));
  });

  it('takes the cookie from a Cookie: header and keeps it out of the headers', () => {
    const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
    expect(result.cookie).toBe('d=xoxd-AAAABBBBCCCCDDDD-1234567890');
    expect(result.request.headers).toStrictEqual({});
  });

  it('never keeps an authorization header, a pseudo-header or an empty value', () => {
    const curl = `curl 'https://acme.slack.com/api/test' -H 'Authorization: Bearer xoxp-FAKE' ` +
      `-H ':authority: acme.slack.com' -H 'dnt: 1' -H 'sec-gpc:' -H 'Accept-Encoding: gzip' ` +
      `-H 'Host: acme.slack.com' -H 'Content-Length: 10' -b 'd=xoxd-FAKE' --data '{"token":"xoxc-FAKE"}'`;
    expect(parseCurlCommand(curl).request.headers).toStrictEqual({ dnt: '1' });
  });

  it('lower-cases header names and keeps a value with an escaped quote', () => {
    const curl = `curl 'https://acme.slack.com/api/test' -H $'X-Note: it\\'s fine' -H 'User-Agent: UA/1' ` +
      `-b 'd=xoxd-FAKE' --data '{"token":"xoxc-FAKE"}'`;
    expect(parseCurlCommand(curl).request.headers).toStrictEqual({ 'x-note': "it's fine", 'user-agent': 'UA/1' });
  });

  it('captures nothing extra from a bare request', () => {
    expect(parseCurlCommand(CURL_SINGLE_LINE).request).toStrictEqual({ headers: {}, query: {}, form: {} });
  });

  it('reads the constant form fields from a JSON body', () => {
    const curl = `curl 'https://acme.slack.com/api/test' -b 'd=xoxd-FAKE' ` +
      `--data-raw '{"token":"xoxc-FAKE","_x_mode":"online","_x_reason":"x","count":3}'`;
    expect(parseCurlCommand(curl).request.form).toStrictEqual({ _x_mode: 'online' });
  });

  it('does not take the value of a skipped option for the URL', () => {
    const curl = `curl -X POST -e 'https://decoy.slack.com/' 'https://real.slack.com/api/test' --compressed ` +
      `-b 'd=xoxd-FAKE' --data '{"token":"xoxc-FAKE"}'`;
    expect(parseCurlCommand(curl).workspaceUrl).toBe('https://real.slack.com');
  });

  it('rejects a host that only starts like a Slack workspace', () => {
    const curl = `curl 'https://acme.slack.com.evil.example/api/test' -b 'd=xoxd-FAKE' --data '{"token":"xoxc-FAKE"}'`;
    expect(() => parseCurlCommand(curl)).toThrow(CurlParseError);
  });
});

describe('snapshotBrowserRequest', () => {
  it('reads form fields from a urlencoded body and tolerates a URL that does not parse', () => {
    expect(snapshotBrowserRequest('not a url', [['Accept', '*/*']], 'token=xoxc-FAKE&_x_sonic=true')).toStrictEqual({
      headers: { accept: '*/*' },
      query: {},
      form: { _x_sonic: 'true' },
    });
  });
});

describe('shellWords', () => {
  it('splits on blanks and joins backslash-newline continuations', () => {
    expect(shellWords("curl 'a b' \\\n  c \\\r\n d")).toStrictEqual(['curl', 'a b', 'c', 'd']);
    // As in bash, a continuation inside a word joins its two halves.
    expect(shellWords('c\\\nd')).toStrictEqual(['cd']);
  });

  it('decodes ANSI-C escapes inside $\'...\'', () => {
    expect(shellWords(String.raw`$'a\r\n\t\\\'\"\x41!\U0001F600\101\q'`)).toStrictEqual([
      'a\r\n\t\\\'"A!\u{1F600}A\\q',
    ]);
  });

  it('decodes the escapes double quotes allow and keeps the others', () => {
    expect(shellWords(String.raw`"a\"b\\c\$d\e" $"x"`)).toStrictEqual(['a"b\\c$d\\e', 'x']);
  });

  it('concatenates adjacent quoted parts into one word', () => {
    expect(shellWords(`-H'a: '"b"$'\\x63'd`)).toStrictEqual(['-Ha: bcd']);
  });

  it('runs an unclosed quote to the end of the input', () => {
    expect(shellWords("curl 'abc")).toStrictEqual(['curl', 'abc']);
    expect(shellWords("curl $'abc\\")).toStrictEqual(['curl', 'abc\\']);
  });
});
