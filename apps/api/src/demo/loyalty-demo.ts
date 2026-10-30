import { ApiError, DemoApi } from './api-client';
import { PropertyCode, ScenarioResult } from './context';

/**
 * Loyalty demo members (addendum v1.2) at each property: a regular guest with
 * 800 points, a club member with KES 5,000 wallet credit (and 1,000 points for
 * the ceiling test), a corporate member and a flagged staff account linked to
 * the property's waiter. Balances are opened with approved adjustments, the
 * same way a manager would load a migrated balance, so every shilling and
 * point is in the ledger with a reason (LOY16).
 *
 * Re-running is safe: a member is found by phone and left as it is, so test
 * activity on the demo members is never topped up or undone.
 */

interface DemoMember {
  key: 'regular' | 'club' | 'corporate' | 'staff';
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  company?: string;
  points?: number;
  wallet?: string;
  club?: boolean;
  staffUser?: string;
}

export const LOYALTY_MEMBERS: Record<PropertyCode, DemoMember[]> = {
  K1: [
    { key: 'regular', firstName: 'Wanjiru', lastName: 'Kamau', phone: '+254712000101', email: 'wanjiru.kamau@example.com', points: 800 },
    { key: 'club', firstName: 'Daniel', lastName: 'Mutua', phone: '+254711300101', email: 'daniel.mutua@example.com', club: true, wallet: '5000.00', points: 1000 },
    { key: 'corporate', firstName: 'Acme Logistics', lastName: 'Ltd', phone: '+254711300102', email: 'ap@acme-logistics.example', company: 'Acme Logistics Ltd' },
    { key: 'staff', firstName: 'Kevin', lastName: 'Ochieng (staff)', phone: '+254711300103', staffUser: 'k1.waiter', points: 200 },
  ],
  SW: [
    { key: 'regular', firstName: 'Brian', lastName: 'Otieno', phone: '+254722000202', email: 'brian.otieno@example.com', points: 800 },
    { key: 'club', firstName: 'Grace', lastName: 'Njeri', phone: '+254755000505', email: 'grace.njeri@example.com', club: true, wallet: '5000.00', points: 1000 },
    { key: 'corporate', firstName: 'Lukenya Engineering', lastName: 'Ltd', phone: '+254711300202', email: 'finance@lukenya-eng.example', company: 'Lukenya Engineering Ltd' },
    { key: 'staff', firstName: 'Mercy', lastName: 'Wambui (staff)', phone: '+254711300203', staffUser: 'sw.waiter', points: 200 },
  ],
  KM: [
    { key: 'regular', firstName: 'Amina', lastName: 'Hassan', phone: '+254733000303', email: 'amina.hassan@example.com', points: 800 },
    { key: 'club', firstName: 'Fatuma', lastName: 'Ali', phone: '+254711300301', email: 'fatuma.ali@example.com', club: true, wallet: '5000.00', points: 1000 },
    { key: 'corporate', firstName: 'Pwani Shipping', lastName: 'Ltd', phone: '+254711300302', email: 'accounts@pwani-shipping.example', company: 'Pwani Shipping Ltd' },
    { key: 'staff', firstName: 'Said', lastName: 'Omar (staff)', phone: '+254711300303', staffUser: 'km.waiter', points: 200 },
  ],
};

const MANAGER: Record<PropertyCode, string> = { K1: 'k1.manager', SW: 'sw.manager', KM: 'km.manager' };
const RECEPTION: Record<PropertyCode, string> = { K1: 'k1.reception', SW: 'sw.reception', KM: 'km.reception' };

export interface LoyaltyDemoMember {
  property: PropertyCode;
  key: DemoMember['key'];
  number: string;
  name: string;
  created: boolean;
}

export async function loyaltyDemo(
  api: DemoApi,
  properties: PropertyCode[],
  results: ScenarioResult[],
  log: (line: string) => void,
  today = new Date().toISOString().slice(0, 10),
): Promise<LoyaltyDemoMember[]> {
  const out: LoyaltyDemoMember[] = [];
  const owner = await api.as('owner');
  const companies = await owner.get<Array<{ id: string; name: string }>>('/companies?kind=company');
  for (const code of properties) {
    log(`\n${code}: loyalty demo members`);
    const base = `/properties/${code}/loyalty`;
    const reception = await api.as(RECEPTION[code]);
    const manager = await api.as(MANAGER[code]);
    for (const m of LOYALTY_MEMBERS[code]) {
      const name = `${m.key} member ${m.firstName} ${m.lastName}`;
      try {
        const found = await reception.get<Array<{ id: string; number: string; status: string }>>(`${base}/members?q=${encodeURIComponent(m.phone)}`);
        const existing = found.find((x) => x.status === 'active');
        if (existing) {
          out.push({ property: code, key: m.key, number: existing.number, name: `${m.firstName} ${m.lastName}`, created: false });
          results.push({ property: code, scenario: name, ok: true, detail: `already there as ${existing.number}` });
          log(`  - ${name}: already there as ${existing.number}`);
          continue;
        }
        const guests = await reception.get<Array<{ id: string; phone: string }>>(`/guests?q=${encodeURIComponent(m.phone)}`);
        const guest = guests.find((g) => g.phone === m.phone);
        const company = m.company ? companies.find((c) => c.name === m.company) : undefined;
        if (m.company && !company) throw new Error(`company ${m.company} is not in the seed; run the normal seed first`);
        const member = await reception.post<{ id: string; number: string }>(`${base}/members`, {
          firstName: m.firstName, lastName: m.lastName, phone: m.phone, email: m.email ?? null, guestId: guest?.id ?? null,
          companyId: company?.id ?? null, kind: m.company ? 'corporate' : 'individual', adultConfirmed: true, programmeAccepted: true,
          marketingConsent: m.key === 'regular', channel: 'reception',
        });
        const did: string[] = [];
        if (m.club) {
          await manager.put(`${base}/members/${member.id}/club`, { tierCode: 'CLUB', status: 'active', startsOn: `${today.slice(0, 7)}-01`, reason: 'Demo club member' });
          did.push('club member');
        }
        if (m.staffUser) {
          await manager.post(`${base}/members/${member.id}/staff`, { username: m.staffUser, reason: `Demo: staff account of ${m.staffUser}` });
          did.push(`flagged as staff (${m.staffUser})`);
        }
        if (m.points) {
          await manager.post(`${base}/members/${member.id}/adjust`, { unit: 'points', amount: String(m.points), reason: 'Demo opening balance' });
          did.push(`${m.points} points`);
        }
        if (m.wallet) {
          await manager.post(`${base}/members/${member.id}/adjust`, { unit: 'wallet', amount: m.wallet, reason: 'Demo opening wallet credit' });
          did.push(`KES ${Number(m.wallet).toLocaleString('en-KE')} wallet`);
        }
        out.push({ property: code, key: m.key, number: member.number, name: `${m.firstName} ${m.lastName}`, created: true });
        const detail = `${member.number}${did.length ? `, ${did.join(', ')}` : ''}`;
        results.push({ property: code, scenario: name, ok: true, detail });
        log(`  ✓ ${name}: ${detail}`);
      } catch (err) {
        const detail = err instanceof ApiError || err instanceof Error ? err.message : String(err);
        results.push({ property: code, scenario: name, ok: false, detail });
        log(`  ✗ ${name}: ${detail}`);
      }
    }
  }
  return out;
}
