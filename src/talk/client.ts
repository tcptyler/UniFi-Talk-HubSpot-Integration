// Client for the UniFi Talk web UI API (`https://<console>/proxy/talk/api/...`).
// Talk has no official API; this uses the same endpoints the Talk web app does, read-only unless noted.
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { z } from 'zod';
import { pinnedAgent } from './tls.ts';
import * as S from './schemas.ts';

/** How the integration signs in to the console. See the project README for which to use. */
export type TalkAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'localAccount'; username: string; password: string }
  | { kind: 'sessionToken'; token: string };

export class TalkError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TalkError';
    this.status = status;
  }
}
export class TalkAuthError extends TalkError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'TalkAuthError';
  }
}
export class TalkRateLimitError extends TalkError {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super(`console is rate limiting; not sending anything until ${retryAt.toISOString()}`, 429);
    this.name = 'TalkRateLimitError';
    this.retryAt = retryAt;
  }
}
/** The console answered with a shape this version of the integration doesn't understand (a Talk update). */
export class TalkSchemaError extends TalkError {
  readonly path: string;
  readonly issues: string[];
  constructor(path: string, issues: string[]) {
    super(`unexpected response shape from ${path}: ${issues.join('; ')}`);
    this.name = 'TalkSchemaError';
    this.path = path;
    this.issues = issues;
  }
}

export interface TalkClientOptions {
  host: string;
  /** SHA-256 fingerprint of the console's certificate (see `unifi-talk-hubspot fingerprint`). */
  pin: string;
  auth: TalkAuth;
  port?: number;
  /** Minimum gap between requests, to stay gentle with the console. */
  minIntervalMs?: number;
  requestTimeoutMs?: number;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const SIGN_IN_REFUSED_BACKOFF_MS = 15 * 60_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

/** Claims of a UniFi OS session token (a JWT). Only used for the CSRF token and expiry; never logged. */
export function readSessionToken(token: string): { csrfToken?: string; expiresAt?: Date; remembered?: boolean } {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      csrfToken: typeof claims.csrfToken === 'string' ? claims.csrfToken : undefined,
      expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined,
      remembered: typeof claims.isRemembered === 'boolean' ? claims.isRemembered : undefined,
    };
  } catch {
    return {};
  }
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Talk wraps some lists in an object; accept either form. */
function unwrapList(json: unknown): unknown {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const key of ['messages', 'conversations', 'records', 'data', 'items', 'transcripts']) {
      const value = (json as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return json;
}

export class TalkClient {
  readonly host: string;
  readonly port: number;
  readonly auth: TalkAuth;
  readonly agent: https.Agent;
  #cookies = new Map<string, string>();
  #csrf: string | null = null;
  #signedIn: boolean;
  #signingIn: Promise<void> | null = null;
  #blockedUntil = 0;
  #lastRequestAt = 0;
  #minIntervalMs: number;
  #timeoutMs: number;

  constructor(options: TalkClientOptions) {
    this.host = options.host;
    this.port = options.port ?? 443;
    this.auth = options.auth;
    this.agent = pinnedAgent(options.host, options.pin);
    this.#minIntervalMs = options.minIntervalMs ?? 100;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#signedIn = options.auth.kind !== 'localAccount';
    if (options.auth.kind === 'sessionToken') {
      const token = options.auth.token.replace(/^TOKEN=/, '').trim();
      this.#cookies.set('TOKEN', token);
      this.#csrf = readSessionToken(token).csrfToken ?? null;
    }
  }

  /** Cookie header for the live WebSocket (session sign-ins only; API keys can't open it). */
  cookieHeader(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // ------------------------------------------------------------ typed reads

  info(): Promise<S.TalkInfo> {
    return this.getJson('info', S.TalkInfo);
  }

  userInfo() {
    return this.getJson('user/info', S.TalkUserInfo);
  }

  users(): Promise<S.TalkUser[]> {
    return this.getJson('users', z.array(S.TalkUser));
  }

  numbers(): Promise<S.TalkNumber[]> {
    return this.getJson('number/list', z.array(S.TalkNumber));
  }

  /** One page of the call log, newest first. Pages start at 0; time filters are epoch milliseconds. */
  callLogPage(options: { page?: number; itemsPerPage?: number; fromMs?: number; toMs?: number } = {}): Promise<S.CallLogPage> {
    const q = new URLSearchParams({
      page: String(options.page ?? 0),
      items_per_page: String(options.itemsPerPage ?? 100),
      sort_key: 'time',
      sort_order: 'desc',
    });
    if (options.fromMs !== undefined) q.set('from_time', String(Math.floor(options.fromMs)));
    if (options.toMs !== undefined) q.set('to_time', String(Math.floor(options.toMs)));
    return this.getJson(`call_log?${q}`, S.CallLogPage);
  }

  /** The AI transcript of a call, or null when Talk has none (it answers with a literal `null`). */
  async transcriptForCall(callUuid: string): Promise<S.Transcript | null> {
    const path = `transcript/by_call_uuid?call_uuid=${encodeURIComponent(callUuid)}`;
    const res = await this.#send('GET', path);
    if (res.status === 404) return null;
    this.#assertOk(res, path);
    const text = res.body.toString('utf8').trim();
    if (text === '' || text === 'null') return null;
    return this.#parse(path, text, S.Transcript);
  }

  smsConversations(): Promise<S.SmsConversation[]> {
    return this.getJson('sms/conversations', z.preprocess(unwrapList, z.array(S.SmsConversation)));
  }

  /** Messages of one SMS thread. Reading does not mark the thread read (that is a separate POST). */
  smsMessages(conversationId: string | number): Promise<S.SmsMessage[]> {
    return this.getJson(`sms/conversation/${encodeURIComponent(String(conversationId))}`, z.preprocess(unwrapList, z.array(S.SmsMessage)));
  }

  contacts(): Promise<S.TalkContact[]> {
    return this.getJson('contacts', z.preprocess(unwrapList, z.array(S.TalkContact)));
  }

  /** The call recording (MP3), or null when there is none. */
  async recording(callUuid: string, maxBytes = 50 * 1024 * 1024): Promise<Buffer | null> {
    const path = `call_log/recording/${encodeURIComponent(callUuid)}`;
    const res = await this.#send('GET', path, { maxBytes });
    if (res.status === 404) return null;
    this.#assertOk(res, path);
    return res.body;
  }

  // ------------------------------------------------------------ core

  async getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await this.#send('GET', path);
    this.#assertOk(res, path);
    return this.#parse(path, res.body.toString('utf8'), schema);
  }

  #parse<T>(path: string, text: string, schema: z.ZodType<T>): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TalkSchemaError(path, ['response was not JSON']);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Paths and messages only: values could be personal data.
      throw new TalkSchemaError(path, parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
    }
    return parsed.data;
  }

  #assertOk(res: RawResponse, path: string): void {
    if (res.status === 404) throw new TalkError(`not found: ${path}`, 404);
    if (res.status >= 400) throw new TalkError(`HTTP ${res.status} from ${path}`, res.status);
  }

  async #send(method: string, path: string, options: { body?: unknown; maxBytes?: number } = {}): Promise<RawResponse> {
    await this.#ensureSignedIn();
    let res = await this.#request(method, path, options);
    if (res.status === 401 && this.auth.kind === 'localAccount') {
      // The session expired: sign in once more and retry once. Never sign in per request.
      this.#signedIn = false;
      await this.#ensureSignedIn();
      res = await this.#request(method, path, options);
    }
    if (res.status === 429) this.#rateLimited(res);
    if (res.status === 401) {
      throw new TalkAuthError(
        this.auth.kind === 'sessionToken'
          ? 'the console no longer accepts the session token (it has probably expired)'
          : this.auth.kind === 'apiKey'
            ? 'the console refused the API key'
            : 'the console refused the session after signing in again',
        401,
      );
    }
    return res;
  }

  #rateLimited(res: RawResponse): never {
    const wait = parseRetryAfter(String(res.headers['retry-after'] ?? '')) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    this.#blockedUntil = Date.now() + wait;
    throw new TalkRateLimitError(new Date(this.#blockedUntil));
  }

  async #ensureSignedIn(): Promise<void> {
    if (this.#signedIn || this.auth.kind !== 'localAccount') return;
    // One sign-in at a time, shared by every caller (TalkWatch learned that parallel sign-ins lock accounts).
    this.#signingIn ??= this.#signIn(this.auth).finally(() => {
      this.#signingIn = null;
    });
    return this.#signingIn;
  }

  async #signIn(auth: { username: string; password: string }): Promise<void> {
    this.#cookies.clear();
    this.#csrf = null;
    const res = await this.#request('POST', '/api/auth/login', { body: { username: auth.username, password: auth.password, rememberMe: false } });
    if (res.status === 429) this.#rateLimited(res);
    if (res.status !== 200) {
      // Wrong credentials: stop trying for a while so the account doesn't get locked.
      this.#blockedUntil = Date.now() + SIGN_IN_REFUSED_BACKOFF_MS;
      throw new TalkAuthError(`sign-in refused (HTTP ${res.status}); not retrying for 15 minutes`, res.status);
    }
    if (!this.#cookies.size) throw new TalkAuthError('sign-in succeeded but the console set no session cookie');
    this.#signedIn = true;
  }

  #remember(res: IncomingMessage): void {
    for (const cookie of res.headers['set-cookie'] ?? []) {
      const pair = cookie.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      if (i > 0) {
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value) this.#cookies.set(name, value);
        else this.#cookies.delete(name);
      }
    }
    const csrf = res.headers['x-updated-csrf-token'] ?? res.headers['x-csrf-token'];
    if (typeof csrf === 'string' && csrf) this.#csrf = csrf;
  }

  async #pace(): Promise<void> {
    // Reserve the slot before waiting, so parallel callers queue up instead of all firing together.
    const slot = Math.max(Date.now(), this.#lastRequestAt + this.#minIntervalMs);
    this.#lastRequestAt = slot;
    const wait = slot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async #request(method: string, path: string, options: { body?: unknown; maxBytes?: number }): Promise<RawResponse> {
    if (Date.now() < this.#blockedUntil) throw new TalkRateLimitError(new Date(this.#blockedUntil));
    await this.#pace();
    const fullPath = path.startsWith('/') ? path : `/proxy/talk/api/${path}`;
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string | number> = { Accept: 'application/json, text/plain, */*' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (this.auth.kind === 'apiKey') headers['X-API-Key'] = this.auth.apiKey;
    else {
      if (this.#cookies.size) headers.Cookie = this.cookieHeader();
      if (this.#csrf) headers['X-Csrf-Token'] = this.#csrf;
    }
    const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    return new Promise<RawResponse>((resolve, reject) => {
      const req = https.request({ host: this.host, port: this.port, method, path: fullPath, headers, agent: this.agent }, (res) => {
        this.#remember(res);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new TalkError(`response from ${path} is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.setTimeout(this.#timeoutMs, () => req.destroy(new TalkError(`request to ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
