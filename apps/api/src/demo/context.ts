import { ApiError, DemoApi, UserApi } from './api-client';
import { DEMO_NOTE, DemoGuest } from './demo-data';

export type PropertyCode = 'K1' | 'SW' | 'KM';

export interface ScenarioResult {
  property: PropertyCode;
  scenario: string;
  ok: boolean;
  detail: string;
}

/** Everything a property's demo needs: who acts, which dates, and where results go. */
export interface DemoContext {
  api: DemoApi;
  code: PropertyCode;
  /** `/properties/K1` */
  base: string;
  /** The property's business date when the demo starts. */
  startDate: string;
  /** The date the demo is built around: the business date after any history days are closed. */
  today: string;
  /** True when stays could be started on an earlier business date (arrived yesterday, due out today). */
  history: boolean;
  /** Written into every demo booking so a re-run on the same date can find it. */
  marker: string;
  results: ScenarioResult[];
  log: (line: string) => void;
}

/** Amount helpers for tender splits. The API does the money; this only divides a total into tenders. */
export const cents = (amount: string): number => Math.round(Number(amount) * 100);
export const amount = (c: number): string => (c / 100).toFixed(2);

let refSeq = 0;
/** An M-PESA-style confirmation code: 10 characters, unique per run. */
export function mpesaRef(): string {
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const n = (++refSeq).toString(36).toUpperCase().padStart(2, '0');
  const rand = Math.random().toString(36).toUpperCase().slice(2, 5);
  return `T${stamp}${n}${rand}`.slice(0, 10).padEnd(10, 'X');
}
export const cardRef = (): string => `AUTH${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

/**
 * Runs one scenario and records the outcome. A failure is logged and the demo
 * moves on, so one blocked room or a tester's open check never stops the rest.
 */
export async function scenario<T = undefined>(ctx: DemoContext, name: string, fn: () => Promise<string | Done<T>>): Promise<T | undefined> {
  try {
    const out = await fn();
    const { detail, value } = typeof out === 'string' ? { detail: out, value: undefined } : out;
    ctx.results.push({ property: ctx.code, scenario: name, ok: true, detail });
    ctx.log(`  ✓ ${name}${detail ? `: ${detail}` : ''}`);
    return value;
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    ctx.results.push({ property: ctx.code, scenario: name, ok: false, detail });
    ctx.log(`  ✗ ${name}: ${detail}`);
    return undefined;
  }
}

export interface Done<T> {
  detail: string;
  value: T;
}
export const done = <T>(detail: string, value: T): Done<T> => ({ detail, value });

// ---------------------------------------------------------------------------
// Front office helpers
// ---------------------------------------------------------------------------

export interface Stay {
  id: string;
  number: string;
  status: string;
  folioId: string;
  folioNumber: string;
  roomId: string | null;
  roomNumber: string | null;
  arrivalDate: string;
  departureDate: string;
  nights: Array<{ amount: string }>;
  total: string;
  balance: { balance: string; chargesTotal: string };
}

export interface Reservation {
  id: string;
  number: string;
  stays: Stay[];
  deposit: { required: string; received: string; outstanding: string };
}

/** Finds the demo guest by phone (guests are shared across the group) or creates the profile. */
export async function guestId(user: UserApi, g: DemoGuest): Promise<string> {
  const found = await user.get<Array<{ id: string; phone: string }>>(`/guests?q=${encodeURIComponent(g.phone)}`);
  const hit = found.find((x) => x.phone === g.phone);
  if (hit) return hit.id;
  const created = await user.post<{ id: string }>('/guests', {
    firstName: g.firstName,
    lastName: g.lastName,
    phone: g.phone,
    email: g.email,
    nationality: g.nationality,
    preferences: g.preferences,
    notes: `${DEMO_NOTE}: invented guest for demonstrations`,
  });
  return created.id;
}

export interface BookingInput {
  guest: DemoGuest;
  arrival: string;
  departure: string;
  roomTypeCode: string;
  ratePlanCode?: string;
  adults: number;
  children?: number;
  status?: 'enquiry' | 'hold' | 'confirmed';
  holdMinutes?: number;
  source?: 'walk_in' | 'phone' | 'email' | 'agent' | 'website' | 'other';
  companyId?: string;
  agentId?: string;
  agentReference?: string;
  roomId?: string;
  rateOverride?: { amountPerNight: string; reason: string };
  approval?: { username: string; password: string };
  /** Extra rooms on the same booking (RES-08). */
  extraRooms?: Array<{ roomTypeCode: string; adults: number; children?: number; guest: DemoGuest }>;
  note: string;
}

export async function book(ctx: DemoContext, user: UserApi, b: BookingInput): Promise<Reservation> {
  const rooms = [
    {
      roomTypeCode: b.roomTypeCode,
      ratePlanCode: b.ratePlanCode ?? 'RACK',
      adults: b.adults,
      children: b.children ?? 0,
      roomId: b.roomId,
      rateOverride: b.rateOverride,
    },
    ...(await Promise.all(
      (b.extraRooms ?? []).map(async (r) => ({
        roomTypeCode: r.roomTypeCode,
        ratePlanCode: b.ratePlanCode ?? 'RACK',
        adults: r.adults,
        children: r.children ?? 0,
        guest: { id: await guestId(user, r.guest) },
      })),
    )),
  ];
  return user.post<Reservation>(`${ctx.base}/reservations`, {
    source: b.source ?? 'phone',
    guest: { id: await guestId(user, b.guest) },
    arrival: b.arrival,
    departure: b.departure,
    status: b.status ?? 'confirmed',
    holdMinutes: b.holdMinutes,
    companyId: b.companyId,
    agentId: b.agentId,
    agentReference: b.agentReference ?? ctx.marker,
    notes: `${DEMO_NOTE}: ${b.note}`,
    rooms,
    approval: b.approval,
  });
}

/**
 * Checks a guest in the way reception does: the identity document is recorded
 * if none is on file, and a room still marked dirty is first reported clean by
 * housekeeping (unless the scenario wants it left as it is).
 */
export async function checkIn(
  ctx: DemoContext,
  user: UserApi,
  stay: Stay,
  g: DemoGuest,
  extra: Record<string, unknown> = {},
): Promise<Reservation> {
  const body = { roomChargeAllowed: true, ...extra };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await user.post<Reservation>(`${ctx.base}/stays/${stay.id}/check-in`, body);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'identity_required' && !('identity' in body)) {
        Object.assign(body, { identity: g.id });
        continue;
      }
      if (err.code === 'room_not_ready' && stay.roomId) {
        await user.patch(`${ctx.base}/rooms/${stay.roomId}/hk-status`, { hkStatus: 'clean' });
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not check in ${stay.number}`);
}

export async function folio(ctx: DemoContext, user: UserApi, folioId: string) {
  return user.get<{ number: string; balance: { balance: string; chargesTotal: string }; charges: Array<{ id: string; chargeCode: string; description: string }> }>(
    `${ctx.base}/folios/${folioId}`,
  );
}

export async function charge(
  ctx: DemoContext,
  user: UserApi,
  folioId: string,
  c: { chargeCode: string; description: string; unitPrice: string; quantity?: string; outletCode?: string },
) {
  return user.post<{ id: string }>(`${ctx.base}/folios/${folioId}/charges`, { quantity: '1', ...c });
}

export async function pay(ctx: DemoContext, user: UserApi, folioId: string, tenders: Array<Record<string, unknown>>) {
  return user.post<{ payments: Array<{ id: string; receiptNumber: string | null; status: string }> }>(`${ctx.base}/folios/${folioId}/payments`, { tenders });
}

export async function closeDay(ctx: DemoContext, manager: UserApi, date: string) {
  return manager.post<{ closedDate: string; businessDate: string; roomChargesPosted: number }>(`${ctx.base}/front-desk/close-day`, { businessDate: date });
}
