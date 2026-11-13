// A stand-in HubSpot API on localhost. All data is made up.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HsRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string | undefined;
}
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (req: HsRequest) => Reply;

export interface MockHubSpot {
  url: string;
  requests: HsRequest[];
  route(method: string, path: string, handler: Handler): void;
  close(): Promise<void>;
}

export const TOKEN = 'hs-test-token';

const filterValue = (body: unknown) =>
  (body as { filterGroups?: Array<{ filters?: Array<{ value?: string }> }> })?.filterGroups?.[0]?.filters?.[0]?.value;

export async function startMockHubSpot(options: { customMeetingOutcome?: boolean } = {}): Promise<MockHubSpot> {
  const routes = new Map<string, Handler>();
  const requests: HsRequest[] = [];
  routes.set('GET /account-info/2026-09/details', () => ({ body: { portalId: 1234567, uiDomain: 'app.hubspot.com', timeZone: 'America/New_York', utcOffset: '-05:00' } }));
  routes.set('GET /crm/owners/2026-09', (r) =>
    r.query.get('after') === '2'
      ? { body: { results: [{ id: '102', email: 'pat@northwind.example', firstName: 'Pat' }] } }
      : { body: { results: [{ id: '101', email: 'Alex@Northwind.example', firstName: 'Alex' }], paging: { next: { after: '2' } } } },
  );
  routes.set('GET /calling/v1/dispositions', () => ({
    body: [
      { id: 'f240bbac-87c9-4f6e-bf70-924b57d47db7', label: 'Connected' },
      { id: '73a0d17f-1163-4015-bdd5-ec830791da20', label: 'No answer' },
      ...(options.customMeetingOutcome ? [{ id: '11111111-2222-3333-4444-555555555555', label: 'Meeting booked' }] : []),
    ],
  }));
  routes.set('POST /crm/objects/2026-09/contacts/search', (r) =>
    filterValue(r.body) === '2025550123' ? { body: { total: 1, results: [{ id: '501', properties: { hubspot_owner_id: '102' } }] } } : { body: { total: 0, results: [] } },
  );
  routes.set('POST /crm/objects/2026-09/calls/search', (r) => (filterValue(r.body) === 'vm' ? { body: { total: 1, results: [{ id: '9001', properties: {} }] } } : { body: { total: 0, results: [] } }));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://hubspot');
      const entry: HsRequest = { method: req.method ?? '', path: url.pathname, query: url.searchParams, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization };
      requests.push(entry);
      const reply: Reply =
        entry.auth !== `Bearer ${TOKEN}`
          ? { status: 401, body: { status: 'error', message: 'Authentication credentials not found.', category: 'INVALID_AUTHENTICATION', correlationId: 'c-401' } }
          : (routes.get(`${entry.method} ${entry.path}`)?.(entry) ?? { status: 404, body: { status: 'error', message: 'not found', category: 'OBJECT_NOT_FOUND' } });
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    route: (method, path, handler) => void routes.set(`${method} ${path}`, handler),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
