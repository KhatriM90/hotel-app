/**
 * SAP Business One Service Layer mock (OData v4, /b1s/v2).
 *
 * Mimics the parts the integration worker uses: Login/Logout with a B1SESSION
 * cookie, POST/GET on document entities, $filter on U_HTL_ExtRef, SAP-style
 * error bodies, and fault injection for the brief's SAP acceptance tests:
 *   - commit-then-drop: stores the document, then kills the connection (SAP-AT04)
 *   - unavailable:      503 for every call (SAP-AT05, SAP-AT12)
 *   - expire-sessions:  invalidates all sessions (forces re-login)
 * Like real SAP, it does NOT enforce uniqueness of U_HTL_ExtRef; the worker
 * must look up before posting (SAP-20).
 */
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export const DOCUMENT_ENTITIES = [
  'Invoices',
  'CreditNotes',
  'IncomingPayments',
  'StockTransfers',
  'InventoryGenExits',
  'InventoryGenEntries',
] as const;
type Entity = (typeof DOCUMENT_ENTITIES)[number];

export type FaultMode = 'commit-then-drop' | 'unavailable' | 'expire-sessions';

export interface MockOptions {
  companyDb?: string;
  username?: string;
  password?: string;
  /** Item codes SAP should reject (simulates invalid item/tax mapping, SAP-AT06). */
  invalidItemPrefix?: string;
}

export interface MockState {
  documents: Record<Entity, Array<Record<string, unknown>>>;
  sessions: Set<string>;
  faults: Array<{ mode: FaultMode; remaining: number }>;
  nextDocEntry: number;
  requests: Array<{ method: string; path: string }>;
}

function sapError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sessionFrom(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? '';
  return /(?:^|;\s*)B1SESSION=([^;]+)/.exec(cookie)?.[1];
}

/** Supports `U_HTL_ExtRef eq 'value'` (quotes doubled for escaping), which is all the worker sends. */
export function parseExtRefFilter(filter: string | null): string | undefined {
  if (!filter) return undefined;
  const m = /^U_HTL_ExtRef eq '((?:[^']|'')*)'$/.exec(filter.trim());
  return m ? m[1].replace(/''/g, "'") : undefined;
}

function validateDocument(entity: Entity, body: Record<string, unknown>, opts: MockOptions): string | undefined {
  if (typeof body.U_HTL_ExtRef !== 'string' || !body.U_HTL_ExtRef) return 'U_HTL_ExtRef is required by the hotel integration';
  if (entity === 'Invoices' || entity === 'CreditNotes') {
    if (typeof body.CardCode !== 'string') return "Property 'CardCode' is required";
    if (typeof body.BPL_IDAssignedToInvoice !== 'number') return 'Branch (BPL_IDAssignedToInvoice) is required in a multi-branch company';
    const lines = body.DocumentLines;
    if (!Array.isArray(lines) || lines.length === 0) return 'Document must contain at least one line';
    for (const [i, line] of lines.entries()) {
      const l = line as Record<string, unknown>;
      if (typeof l.ItemCode !== 'string') return `Line ${i}: ItemCode is required`;
      if (opts.invalidItemPrefix && l.ItemCode.startsWith(opts.invalidItemPrefix)) {
        return `Line ${i}: Invalid item code '${l.ItemCode}'`;
      }
      if (typeof l.Quantity !== 'number' || l.Quantity <= 0) return `Line ${i}: Quantity must be positive`;
    }
  }
  if (entity === 'IncomingPayments' && typeof body.CardCode !== 'string') return "Property 'CardCode' is required";
  return undefined;
}

export function createMockServiceLayer(opts: MockOptions = {}): { server: Server; state: MockState } {
  const options = { companyDb: 'HOTEL_TEST', username: 'manager', password: 'manager', invalidItemPrefix: 'INVALID', ...opts };
  const state: MockState = {
    documents: Object.fromEntries(DOCUMENT_ENTITIES.map((e) => [e, []])) as unknown as MockState['documents'],
    sessions: new Set(),
    faults: [],
    nextDocEntry: 1,
    requests: [],
  };

  const takeFault = (mode: FaultMode): boolean => {
    const f = state.faults.find((x) => x.mode === mode && x.remaining > 0);
    if (!f) return false;
    f.remaining -= 1;
    return true;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://mock');
      const method = req.method ?? 'GET';
      state.requests.push({ method, path: url.pathname });

      // --- Mock control endpoints -----------------------------------------
      if (url.pathname === '/mock/health') return json(res, 200, { status: 'ok' });
      if (url.pathname === '/mock/reset' && method === 'POST') {
        for (const e of DOCUMENT_ENTITIES) state.documents[e] = [];
        state.faults = [];
        state.sessions.clear();
        state.nextDocEntry = 1;
        state.requests = [];
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/mock/faults' && method === 'POST') {
        const body = (await readBody(req)) as { mode: FaultMode; times?: number };
        if (body.mode === 'expire-sessions') {
          state.sessions.clear();
        } else {
          state.faults.push({ mode: body.mode, remaining: body.times ?? 1 });
        }
        return json(res, 200, { faults: state.faults });
      }
      if (url.pathname === '/mock/documents' && method === 'GET') return json(res, 200, state.documents);

      // --- Service Layer ----------------------------------------------------
      if (!url.pathname.startsWith('/b1s/v2/')) return sapError(res, 404, '-1', 'Not found');
      if (takeFault('unavailable')) return sapError(res, 503, '-1', 'Service Unavailable');
      const resource = url.pathname.slice('/b1s/v2/'.length);

      if (resource === 'Login' && method === 'POST') {
        const body = (await readBody(req)) as Record<string, string>;
        if (body?.CompanyDB !== options.companyDb || body?.UserName !== options.username || body?.Password !== options.password) {
          return sapError(res, 401, '-304', 'Fail to get DB Credentials from SLD');
        }
        const sid = randomUUID();
        state.sessions.add(sid);
        return json(res, 200, { SessionId: sid, Version: '1000250', SessionTimeout: 30 }, {
          'set-cookie': [`B1SESSION=${sid}; path=/b1s/v2; HttpOnly`, 'ROUTEID=.node1; path=/b1s'],
        });
      }

      const sid = sessionFrom(req);
      if (!sid || !state.sessions.has(sid)) return sapError(res, 401, '301', 'Invalid session or session already timeout.');

      if (resource === 'Logout' && method === 'POST') {
        state.sessions.delete(sid);
        res.writeHead(204).end();
        return;
      }

      const byKey = /^(\w+)\((\d+)\)$/.exec(resource);
      const entity = (byKey ? byKey[1] : resource) as Entity;
      if (!DOCUMENT_ENTITIES.includes(entity)) return sapError(res, 404, '-1', `Unknown entity ${entity}`);
      const store = state.documents[entity];

      if (method === 'GET' && byKey) {
        const doc = store.find((d) => d.DocEntry === Number(byKey[2]));
        return doc ? json(res, 200, doc) : sapError(res, 404, '-2028', 'No matching records found (ODBC -2028)');
      }

      if (method === 'GET') {
        const filter = url.searchParams.get('$filter');
        const extRef = parseExtRefFilter(filter);
        if (filter && extRef === undefined) return sapError(res, 400, '-1', 'Unsupported $filter in mock');
        const rows = extRef === undefined ? store : store.filter((d) => d.U_HTL_ExtRef === extRef);
        const select = url.searchParams.get('$select')?.split(',').map((s) => s.trim());
        const shaped = select ? rows.map((r) => Object.fromEntries(select.map((k) => [k, r[k]]))) : rows;
        return json(res, 200, { value: shaped });
      }

      if (method === 'POST' && !byKey) {
        const body = (await readBody(req)) as Record<string, unknown>;
        const invalid = validateDocument(entity, body ?? {}, options);
        if (invalid) return sapError(res, 400, '-5002', invalid);
        const docEntry = state.nextDocEntry++;
        const doc = { ...body, DocEntry: docEntry, DocNum: 100000 + docEntry };
        store.push(doc);
        if (takeFault('commit-then-drop')) {
          req.socket.destroy(); // committed in "SAP", but the caller never hears back
          return;
        }
        return json(res, 201, doc);
      }

      return sapError(res, 405, '-1', 'Method not allowed');
    } catch (err) {
      sapError(res, 500, '-1', (err as Error).message);
    }
  });

  return { server, state };
}
