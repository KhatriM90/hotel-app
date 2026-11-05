import { addDays } from './frontdesk';

/**
 * Room status dashboard (client request, 5 Nov 2026, from the Roomscape
 * prototype). Pure functions so the API, the back office and the tests agree
 * on how a room-night is classified and counted.
 *
 * Booking state and housekeeping condition are kept apart: a room can be
 * occupied and dirty at the same time. Booking state comes from room
 * allocations (stays and blocks, checkout-exclusive [from, to) nights);
 * housekeeping is the room's current condition.
 */
export const ROOM_NIGHT_STATES = ['available', 'reserved', 'hold', 'occupied', 'departed', 'blocked'] as const;
export type RoomNightState = (typeof ROOM_NIGHT_STATES)[number];

export const ROOM_NIGHT_LABELS: Record<RoomNightState, string> = {
  available: 'Available',
  reserved: 'Reserved',
  hold: 'On hold',
  occupied: 'Occupied',
  departed: 'Stayed (checked out)',
  blocked: 'Out of order / blocked',
};

export interface DashboardRoom {
  id: string;
  number: string;
  floor: string | null;
  roomTypeCode: string;
  hkStatus: string;
}

export interface DashboardSegment {
  roomId: string;
  kind: 'stay' | 'block';
  /** First night (inclusive). */
  from: string;
  /** Morning of departure (exclusive). */
  to: string;
  status?: string | null;
  guestName?: string | null;
}

/** Longest range the dashboard loads at once (one year, leap years included). */
export const MAX_DASHBOARD_DAYS = 366;

/** Inclusive list of dates from `from` to `to`; throws on a reversed or too-long range. */
export function dashboardDates(from: string, to: string): string[] {
  if (to < from) throw new Error('The end date is before the start date');
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_DASHBOARD_DAYS) throw new Error(`Choose at most ${MAX_DASHBOARD_DAYS} days`);
  }
  return dates;
}

export function segmentState(s: DashboardSegment): RoomNightState {
  if (s.kind === 'block') return 'blocked';
  switch (s.status) {
    case 'checked_in':
      return 'occupied';
    case 'checked_out':
      return 'departed';
    case 'hold':
    case 'enquiry':
      return 'hold';
    default:
      return 'reserved';
  }
}

/** The segment holding a room on a night, if any. */
export function segmentOn<S extends DashboardSegment>(segments: readonly S[], roomId: string, date: string): S | undefined {
  return segments.find((s) => s.roomId === roomId && s.from <= date && date < s.to);
}

export function nightState(segments: readonly DashboardSegment[], roomId: string, date: string): RoomNightState {
  const s = segmentOn(segments, roomId, date);
  return s ? segmentState(s) : 'available';
}

export interface DashboardSummary {
  roomNights: number;
  available: number;
  reserved: number;
  occupied: number;
  blocked: number;
  /** Occupied ÷ (room-nights − blocked), as a percentage with one decimal; null when nothing is sellable. */
  occupancyPercent: number | null;
}

/**
 * Counts room-nights for the given rooms over the dates. Occupied includes
 * nights already stayed by guests who have checked out; reserved includes
 * holds. Occupancy = occupied ÷ (all room-nights − blocked room-nights).
 */
export function summarizeDashboard(rooms: readonly { id: string }[], segments: readonly DashboardSegment[], dates: readonly string[]): DashboardSummary {
  const s = { roomNights: 0, available: 0, reserved: 0, occupied: 0, blocked: 0 };
  for (const room of rooms) {
    for (const date of dates) {
      s.roomNights++;
      const st = nightState(segments, room.id, date);
      if (st === 'available') s.available++;
      else if (st === 'blocked') s.blocked++;
      else if (st === 'occupied' || st === 'departed') s.occupied++;
      else s.reserved++;
    }
  }
  const sellable = s.roomNights - s.blocked;
  return { ...s, occupancyPercent: sellable > 0 ? Math.round((s.occupied / sellable) * 1000) / 10 : null };
}

/** Housekeeping conditions that need someone's attention. */
export function needsHousekeeping(hkStatus: string): boolean {
  return hkStatus === 'dirty' || hkStatus === 'in_progress';
}

/**
 * Makes a value safe for a CSV cell opened in Excel: quotes it, and prefixes
 * text that Excel would read as a formula (=, +, -, @, tab, CR) with an apostrophe.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r']/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
