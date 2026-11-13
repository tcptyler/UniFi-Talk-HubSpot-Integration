// A stand-in UniFi console for tests: HTTPS with a freshly generated self-signed certificate, the Talk
// sign-in flow, sessions that can be expired on demand, API keys, rate limiting, and canned Talk responses.
// All data here is synthetic.
import https from 'node:https';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generate } from 'selfsigned';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
}

export interface MockConsoleOptions {
  username?: string;
  password?: string;
  apiKey?: string;
  /** A pre-issued session token (as a browser would have). */
  sessionToken?: string;
}

type Handler = (url: URL, req: IncomingMessage) => { status?: number; body: unknown; headers?: Record<string, string> };

export interface MockConsole {
  port: number;
  pin: string;
  requests: RecordedRequest[];
  logins: number;
  route(path: string, handler: Handler): void;
  expireSessions(): void;
  rateLimitNext(retryAfterSeconds: number): void;
  close(): Promise<void>;
}

export function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

export async function startMockConsole(options: MockConsoleOptions = {}): Promise<MockConsole> {
  const pems = await generate([{ name: 'commonName', value: 'Mock UniFi Console' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 24 * 60 * 60_000),
  });
  const pin = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const validTokens = new Set<string>(); // issued by sign-in; expireSessions() clears these
  const browserToken = options.sessionToken;
  const routes = new Map<string, Handler>();
  let rateLimit: number | null = null;
  const state = { logins: 0, requests: [] as RecordedRequest[] };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
    res.end(text);
  };

  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://console');
    state.requests.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers });
    if (rateLimit !== null) {
      const seconds = rateLimit;
      rateLimit = null;
      return send(res, 429, { code: 'RATE_LIMITED' }, { 'Retry-After': String(seconds) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        state.logins++;
        const body = JSON.parse(raw || '{}') as { username?: string; password?: string };
        if (options.username && body.username === options.username && body.password === options.password) {
          const token = jwt({ csrfToken: `csrf-${state.logins}`, iat: 0, exp: 4102444800 });
          validTokens.add(token);
          return send(res, 200, {}, { 'Set-Cookie': `TOKEN=${token}; Path=/; HttpOnly; Secure`, 'X-Updated-Csrf-Token': `csrf-${state.logins}` });
        }
        return send(res, 401, { code: 'INVALID_PAYLOAD' });
      });
      return;
    }
    const token = /(?:^|;\s*)TOKEN=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const keyOk = options.apiKey !== undefined && req.headers['x-api-key'] === options.apiKey;
    const sessionOk = token !== undefined && (validTokens.has(token) || token === browserToken);
    if (!keyOk && !sessionOk) return send(res, 401, { code: 'TOKEN_EXPIRED' });
    const path = url.pathname.replace(/^\/proxy\/talk\/api\//, '');
    const handler = routes.get(path) ?? [...routes.entries()].find(([p]) => p.endsWith('/*') && path.startsWith(p.slice(0, -1)))?.[1];
    if (!handler) return send(res, 404, { error: 'not found' });
    const out = handler(url, req);
    return send(res, out.status ?? 200, out.body, out.headers);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    pin,
    get requests() {
      return state.requests;
    },
    get logins() {
      return state.logins;
    },
    route(path, handler) {
      routes.set(path, handler);
    },
    expireSessions() {
      validTokens.clear();
    },
    rateLimitNext(seconds) {
      rateLimit = seconds;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ------------------------------------------------------------ synthetic Talk data

const T0 = Date.parse('2026-11-12T20:15:00Z');
export const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export function callRecord(overrides: Record<string, unknown> & { events?: Array<[number, string, Record<string, unknown>?]> }) {
  const { events = [], ...rest } = overrides;
  return {
    uuid: `call-${crypto.randomUUID()}`,
    time: at(0),
    from: '+12025550100',
    to: '+12025550199',
    direction: 'in',
    status: 'accepted',
    duration: 60,
    recording: false,
    recording_filename: null,
    call_events: events.map(([s, event, event_data = {}]) => ({ time: at(s), event, event_data })),
    ...rest,
  };
}
