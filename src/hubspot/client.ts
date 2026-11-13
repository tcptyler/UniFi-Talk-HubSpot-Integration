// HubSpot API client: Service Key auth, the documented rate limits, and retries that are safe to repeat.
// This part only reads; writing comes with the sync.
import { z } from 'zod';
import { API_VERSION, contactSearch } from './calls.ts';

export class HubSpotError extends Error {
  readonly status: number;
  readonly category: string | null;
  readonly correlationId: string | null;
  constructor(message: string, status: number, category: string | null = null, correlationId: string | null = null) {
    super(message);
    this.name = 'HubSpotError';
    this.status = status;
    this.category = category;
    this.correlationId = correlationId;
  }
}

/** The key was refused (401) or lacks a scope (403). */
export class HubSpotAuthError extends HubSpotError {
  constructor(message: string, status: number, category: string | null, correlationId: string | null) {
    super(message, status, category, correlationId);
    this.name = 'HubSpotAuthError';
  }
}

export interface HubSpotClientOptions {
  token: string;
  baseUrl?: string;
  /** Requests per 10 seconds: 100 on Free and Starter, 190 on Pro and Enterprise. */
  perTenSeconds?: number;
  /** CRM search allows 5 per second per account; stay a little under. */
  searchesPerSecond?: number;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** At most `limit` starts in any `windowMs`. */
class SlidingWindow {
  #starts: number[] = [];
  readonly limit: number;
  readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  /** How long to wait before the next start is allowed (0 = now), recording the start when it is. */
  take(now: number): number {
    this.#starts = this.#starts.filter((t) => now - t < this.windowMs);
    if (this.#starts.length < this.limit) {
      this.#starts.push(now);
      return 0;
    }
    return this.#starts[0]! + this.windowMs - now;
  }
}

const Paging = z.looseObject({ next: z.looseObject({ after: z.string() }).optional() }).optional();
export const Owner = z.looseObject({
  id: z.string(),
  email: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});
export type Owner = z.infer<typeof Owner>;
const OwnersPage = z.looseObject({ results: z.array(Owner), paging: Paging });
export const AccountDetails = z.looseObject({
  portalId: z.number(),
  uiDomain: z.string().optional(),
  timeZone: z.string().nullable().optional(),
  dataHostingLocation: z.string().nullable().optional(),
});
export type AccountDetails = z.infer<typeof AccountDetails>;
export const CallOutcome = z.looseObject({ id: z.string(), label: z.string() });
export type CallOutcome = z.infer<typeof CallOutcome>;
const SearchResult = z.looseObject({
  total: z.number().optional(),
  results: z.array(z.looseObject({ id: z.string(), properties: z.record(z.string(), z.unknown()).nullable().optional() })),
});
export type SearchResult = z.infer<typeof SearchResult>;

const ErrorBody = z.looseObject({ message: z.string().optional(), category: z.string().optional(), correlationId: z.string().optional() });

export class HubSpotClient {
  readonly baseUrl: string;
  #token: string;
  #general: SlidingWindow;
  #search: SlidingWindow;
  #maxRetries: number;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;
  #sleep: (ms: number) => Promise<void>;
  #now: () => number;

  constructor(options: HubSpotClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.hubapi.com').replace(/\/$/, '');
    this.#token = options.token;
    this.#general = new SlidingWindow(options.perTenSeconds ?? 100, 10_000);
    this.#search = new SlidingWindow(options.searchesPerSecond ?? 4, 1_000);
    this.#maxRetries = options.maxRetries ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  accountDetails(): Promise<AccountDetails> {
    return this.request('GET', `/account-info/${API_VERSION}/details`, { schema: AccountDetails });
  }

  async owners(): Promise<Owner[]> {
    const all: Owner[] = [];
    let after: string | undefined;
    do {
      const page = await this.request('GET', `/crm/owners/${API_VERSION}`, { query: { limit: '100', archived: 'false', ...(after ? { after } : {}) }, schema: OwnersPage });
      all.push(...page.results);
      after = page.paging?.next?.after;
    } while (after);
    return all;
  }

  /** Every call outcome in the portal, built-in and custom (legacy v1 endpoint; no dated version yet). */
  callOutcomes(): Promise<CallOutcome[]> {
    return this.request('GET', '/calling/v1/dispositions', { schema: z.array(CallOutcome) });
  }

  findContactsByPhone(e164: string): Promise<SearchResult> {
    const req = contactSearch(e164);
    return this.request('POST', req.path, { body: req.body, schema: SearchResult });
  }

  /** A call this integration already logged, found by the Talk call id it stores on the call. */
  async findCallByTalkId(talkCallUuid: string): Promise<string | null> {
    const res = await this.request('POST', `/crm/objects/${API_VERSION}/calls/search`, {
      body: { filterGroups: [{ filters: [{ propertyName: 'hs_call_external_id', operator: 'EQ', value: talkCallUuid }] }], properties: ['hs_call_external_id'], limit: 1 },
      schema: SearchResult,
    });
    return res.results[0]?.id ?? null;
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, options: { body?: unknown; query?: Record<string, string>; schema: z.ZodType<T>; retrySafe?: boolean }): Promise<T> {
    const isSearch = path.endsWith('/search');
    // GETs and searches can always be repeated; a create must not be repeated blindly after a server error.
    const retrySafe = options.retrySafe ?? (method === 'GET' || isSearch);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      await this.#waitForSlot(isSearch);
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        if (retrySafe && attempt < this.#maxRetries) {
          await this.#sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new HubSpotError(`HubSpot request failed: ${(err as Error).message}`, 0);
      }
      if (res.ok) {
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          throw new HubSpotError(`response from ${path} was not JSON`, res.status);
        }
        const parsed = options.schema.safeParse(json);
        if (!parsed.success) throw new HubSpotError(`unexpected response from ${path}: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, res.status);
        return parsed.data;
      }
      const retryable = res.status === 429 || (retrySafe && res.status >= 500);
      if (retryable && attempt < this.#maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await res.body?.cancel();
        await this.#sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : res.status === 429 ? (isSearch ? 1000 : 10_000) : 1000 * 2 ** attempt);
        continue;
      }
      throw await this.#error(res, path);
    }
  }

  async #waitForSlot(isSearch: boolean): Promise<void> {
    for (;;) {
      const wait = Math.max(this.#general.take(this.#now()), 0);
      if (wait === 0) break;
      await this.#sleep(wait);
    }
    if (!isSearch) return;
    for (;;) {
      const wait = this.#search.take(this.#now());
      if (wait === 0) break;
      await this.#sleep(wait);
    }
  }

  async #error(res: Response, path: string): Promise<HubSpotError> {
    let body: z.infer<typeof ErrorBody> = {};
    try {
      body = ErrorBody.parse(JSON.parse(await res.text()));
    } catch {
      // not JSON
    }
    const category = body.category ?? null;
    const correlationId = body.correlationId ?? null;
    if (res.status === 401) return new HubSpotAuthError('HubSpot refused the Service Key (check HUBSPOT_TOKEN)', 401, category, correlationId);
    if (res.status === 403) {
      return new HubSpotAuthError(`the Service Key lacks a scope needed for ${path}${body.message ? `: ${body.message}` : ''}`, 403, category, correlationId);
    }
    return new HubSpotError(`HubSpot answered ${res.status} for ${path}${body.message ? `: ${body.message}` : ''}`, res.status, category, correlationId);
  }
}
