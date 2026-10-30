/**
 * Test master data for the three properties: room types, rooms, rate plans,
 * booking policies, a corporate client, an agent and a few guests.
 * Room counts are the real ones (K1 13, SW 42, KM 32); room numbers, types
 * and prices are realistic placeholders until the client sends theirs.
 * All prices are KES per night, VAT (16%) and catering levy (2%) inclusive.
 */

export interface SeedRoomType {
  code: string;
  name: string;
  description: string;
  baseOccupancy: number;
  maxAdults: number;
  maxOccupancy: number;
  beds: string;
  amenities: string[];
  rooms: Array<{ number: string; floor: string; building: string }>;
}

export interface SeedPrice {
  roomType: string;
  season: string;
  from: string;
  to: string | null;
  priority: number;
  weekday: string;
  weekend: string;
  extraAdult: string;
  child: string;
}

export interface SeedRatePlan {
  code: string;
  name: string;
  negotiatedWith?: string;
  prices: SeedPrice[];
}

export interface SeedPolicy {
  depositType: 'none' | 'percent' | 'nights';
  depositValue: string;
  depositDueDays: number;
  holdMinutes: number;
  freeCancellationHours: number;
  lateCancellationNights: number;
  noShowNights: number;
  refundPolicy: string;
  checkInTime: string;
  checkOutTime: string;
  earlyCheckInFee: string;
  lateCheckOutFee: string;
}

export interface SeedProperty {
  code: 'K1' | 'SW' | 'KM';
  roomTypes: SeedRoomType[];
  ratePlans: SeedRatePlan[];
  policy: SeedPolicy;
}

function range(prefix: string, from: number, to: number, floor: string, building: string) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({ number: `${prefix}${from + i}`, floor, building }));
}

const BASE_FROM = '2026-01-01';

function base(roomType: string, weekday: string, weekend: string, extraAdult: string, child: string): SeedPrice {
  return { roomType, season: 'Base', from: BASE_FROM, to: null, priority: 0, weekday, weekend, extraAdult, child };
}

function season(name: string, from: string, to: string, roomType: string, weekday: string, weekend: string, extraAdult: string, child: string): SeedPrice {
  return { roomType, season: name, from, to, priority: 10, weekday, weekend, extraAdult, child };
}

const REGISTRATION_TERMS = [
  'Check-in from {checkIn}; check-out by {checkOut}. Early check-in and late check-out are subject to availability and a fee.',
  'The guest is responsible for all charges on this folio, including charges signed to the room at our outlets.',
  'Smoking is not permitted in rooms. Damage or loss of hotel property will be charged to the folio.',
  'Valuables should be kept in the room safe; the hotel is not liable for items left unattended.',
  'Personal data is processed under the Kenya Data Protection Act, 2019, for the stay, legal reporting and billing only.',
].join('\n');

export const SEED_COMPANIES = [
  { kind: 'company' as const, name: 'Acme Logistics Ltd', contactName: 'Accounts Payable', contactEmail: 'ap@acme-logistics.example' },
  { kind: 'agent' as const, name: 'Savannah Tours & Travel', contactName: 'Reservations', contactEmail: 'bookings@savannah-tours.example' },
  { kind: 'company' as const, name: 'Lukenya Engineering Ltd', contactName: 'Finance', contactEmail: 'finance@lukenya-eng.example' },
  { kind: 'company' as const, name: 'Pwani Shipping Ltd', contactName: 'Accounts', contactEmail: 'accounts@pwani-shipping.example' },
];

export const SEED_GUESTS = [
  { firstName: 'Wanjiru', lastName: 'Kamau', phone: '+254712000101', email: 'wanjiru.kamau@example.com', nationality: 'KE' },
  { firstName: 'Brian', lastName: 'Otieno', phone: '+254722000202', email: 'brian.otieno@example.com', nationality: 'KE' },
  { firstName: 'Amina', lastName: 'Hassan', phone: '+254733000303', email: 'amina.hassan@example.com', nationality: 'KE' },
  { firstName: 'James', lastName: 'Mwangi', phone: '+254744000404', email: 'james.mwangi@example.com', nationality: 'KE', company: 'Acme Logistics Ltd' },
  { firstName: 'Grace', lastName: 'Njeri', phone: '+254755000505', email: 'grace.njeri@example.com', nationality: 'KE' },
  { firstName: 'Sarah', lastName: 'Thompson', phone: '+447700900606', email: 'sarah.thompson@example.co.uk', nationality: 'GB' },
];

export const SEED_PROPERTIES: SeedProperty[] = [
  {
    // K1 Klubhouse, Parklands: 13 rooms in one urban block.
    code: 'K1',
    roomTypes: [
      {
        code: 'STD', name: 'Standard Double', description: 'Queen bed, work desk, en-suite shower',
        baseOccupancy: 2, maxAdults: 2, maxOccupancy: 3, beds: '1 queen', amenities: ['Wi-Fi', 'TV', 'Shower', 'Desk'],
        rooms: range('', 101, 107, '1', 'Main'),
      },
      {
        code: 'DLX', name: 'Deluxe King', description: 'King bed, balcony, bathtub',
        baseOccupancy: 2, maxAdults: 3, maxOccupancy: 4, beds: '1 king', amenities: ['Wi-Fi', 'TV', 'Bathtub', 'Balcony', 'Minibar'],
        rooms: range('', 201, 204, '2', 'Main'),
      },
      {
        code: 'STE', name: 'Executive Suite', description: 'Separate lounge, king bed, city view',
        baseOccupancy: 2, maxAdults: 3, maxOccupancy: 4, beds: '1 king + sofa bed', amenities: ['Wi-Fi', 'TV', 'Bathtub', 'Lounge', 'Minibar', 'Coffee machine'],
        rooms: range('', 205, 206, '2', 'Main'),
      },
    ],
    ratePlans: [
      {
        code: 'RACK', name: 'Rack rate, room only',
        prices: [base('STD', '6500.00', '7000.00', '1500.00', '750.00'), base('DLX', '8500.00', '9000.00', '1500.00', '750.00'), base('STE', '12000.00', '13000.00', '2000.00', '1000.00')],
      },
      {
        code: 'CORPACME', name: 'Acme Logistics corporate rate', negotiatedWith: 'Acme Logistics Ltd',
        prices: [base('STD', '5500.00', '5500.00', '1500.00', '750.00'), base('DLX', '7500.00', '7500.00', '1500.00', '750.00')],
      },
    ],
    policy: {
      depositType: 'nights', depositValue: '1', depositDueDays: 3, holdMinutes: 1440,
      freeCancellationHours: 24, lateCancellationNights: 1, noShowNights: 1,
      refundPolicy: 'Deposits are refundable for cancellations more than 24 hours before arrival. Later cancellations and no-shows forfeit the first night.',
      checkInTime: '14:00', checkOutTime: '10:00', earlyCheckInFee: '2000.00', lateCheckOutFee: '2500.00',
    },
  },
  {
    // Small World Country Club, Lukenya: 42 rooms; main block and garden cottages.
    code: 'SW',
    roomTypes: [
      {
        code: 'STD', name: 'Standard Double', description: 'Double bed, garden view',
        baseOccupancy: 2, maxAdults: 2, maxOccupancy: 3, beds: '1 double', amenities: ['Wi-Fi', 'TV', 'Shower'],
        rooms: range('', 101, 118, '1', 'Main block'),
      },
      {
        code: 'TWN', name: 'Standard Twin', description: 'Two single beds, garden view',
        baseOccupancy: 2, maxAdults: 2, maxOccupancy: 3, beds: '2 single', amenities: ['Wi-Fi', 'TV', 'Shower'],
        rooms: range('', 119, 130, '1', 'Main block'),
      },
      {
        code: 'FAM', name: 'Family Cottage', description: 'Two bedrooms, private veranda',
        baseOccupancy: 4, maxAdults: 4, maxOccupancy: 6, beds: '1 king + 2 single', amenities: ['Wi-Fi', 'TV', 'Veranda', 'Kitchenette'],
        rooms: range('C', 1, 8, 'G', 'Cottages'),
      },
      {
        code: 'EXE', name: 'Executive Cottage', description: 'King bed, lounge, golf course view',
        baseOccupancy: 2, maxAdults: 3, maxOccupancy: 4, beds: '1 king', amenities: ['Wi-Fi', 'TV', 'Bathtub', 'Lounge', 'Minibar'],
        rooms: range('C', 9, 12, 'G', 'Cottages'),
      },
    ],
    ratePlans: [
      {
        code: 'RACK', name: 'Rack rate, room only',
        prices: [
          base('STD', '7500.00', '9000.00', '2000.00', '1000.00'),
          base('TWN', '7500.00', '9000.00', '2000.00', '1000.00'),
          base('FAM', '14000.00', '16500.00', '2000.00', '1000.00'),
          base('EXE', '12000.00', '14000.00', '2500.00', '1250.00'),
          season('Festive', '2026-12-20', '2027-01-04', 'STD', '9500.00', '10500.00', '2000.00', '1000.00'),
          season('Festive', '2026-12-20', '2027-01-04', 'TWN', '9500.00', '10500.00', '2000.00', '1000.00'),
          season('Festive', '2026-12-20', '2027-01-04', 'FAM', '17500.00', '19000.00', '2000.00', '1000.00'),
          season('Festive', '2026-12-20', '2027-01-04', 'EXE', '15000.00', '16500.00', '2500.00', '1250.00'),
        ],
      },
    ],
    policy: {
      depositType: 'percent', depositValue: '50', depositDueDays: 7, holdMinutes: 1440,
      freeCancellationHours: 72, lateCancellationNights: 1, noShowNights: 1,
      refundPolicy: 'Deposits are refundable for cancellations more than 72 hours before arrival; otherwise the first night is retained.',
      checkInTime: '14:00', checkOutTime: '11:00', earlyCheckInFee: '2500.00', lateCheckOutFee: '3000.00',
    },
  },
  {
    // Kahama Mombasa: 32 rooms over two floors; coastal high seasons.
    code: 'KM',
    roomTypes: [
      {
        code: 'STD', name: 'Standard Double', description: 'Double bed, garden view',
        baseOccupancy: 2, maxAdults: 2, maxOccupancy: 3, beds: '1 double', amenities: ['Wi-Fi', 'TV', 'Air conditioning', 'Shower'],
        rooms: range('', 101, 112, '1', 'Main'),
      },
      {
        code: 'TWN', name: 'Standard Twin', description: 'Two single beds',
        baseOccupancy: 2, maxAdults: 2, maxOccupancy: 3, beds: '2 single', amenities: ['Wi-Fi', 'TV', 'Air conditioning', 'Shower'],
        rooms: range('', 113, 120, '1', 'Main'),
      },
      {
        code: 'DLX', name: 'Deluxe Pool View', description: 'King bed, balcony over the pool',
        baseOccupancy: 2, maxAdults: 3, maxOccupancy: 4, beds: '1 king', amenities: ['Wi-Fi', 'TV', 'Air conditioning', 'Balcony', 'Minibar'],
        rooms: range('', 201, 208, '2', 'Main'),
      },
      {
        code: 'JST', name: 'Junior Suite', description: 'King bed, sitting area, sea breeze terrace',
        baseOccupancy: 2, maxAdults: 3, maxOccupancy: 4, beds: '1 king + sofa bed', amenities: ['Wi-Fi', 'TV', 'Air conditioning', 'Terrace', 'Minibar', 'Bathtub'],
        rooms: range('', 209, 212, '2', 'Main'),
      },
    ],
    ratePlans: [
      {
        code: 'RACK', name: 'Rack rate, room only',
        prices: [
          base('STD', '8000.00', '9000.00', '2000.00', '1000.00'),
          base('TWN', '8000.00', '9000.00', '2000.00', '1000.00'),
          base('DLX', '11000.00', '12500.00', '2500.00', '1250.00'),
          base('JST', '16000.00', '18000.00', '3000.00', '1500.00'),
          ...(['STD', 'TWN', 'DLX', 'JST'] as const).flatMap((rt) => {
            const p: Record<string, [string, string]> = {
              STD: ['10500.00', '11500.00'], TWN: ['10500.00', '11500.00'], DLX: ['14000.00', '15500.00'], JST: ['20000.00', '22000.00'],
            };
            const [wd, we] = p[rt];
            const extra = rt === 'JST' ? '3000.00' : rt === 'DLX' ? '2500.00' : '2000.00';
            const child = rt === 'JST' ? '1500.00' : rt === 'DLX' ? '1250.00' : '1000.00';
            return [
              season('High season (festive)', '2026-12-15', '2027-01-06', rt, wd, we, extra, child),
              season('High season (July–August)', '2027-07-01', '2027-09-01', rt, wd, we, extra, child),
            ];
          }),
        ],
      },
      {
        code: 'AGENTSAV', name: 'Savannah Tours net rate', negotiatedWith: 'Savannah Tours & Travel',
        prices: [
          base('STD', '6800.00', '7600.00', '1700.00', '850.00'),
          base('TWN', '6800.00', '7600.00', '1700.00', '850.00'),
          base('DLX', '9400.00', '10600.00', '2100.00', '1050.00'),
        ],
      },
    ],
    policy: {
      depositType: 'percent', depositValue: '30', depositDueDays: 14, holdMinutes: 2880,
      freeCancellationHours: 168, lateCancellationNights: 1, noShowNights: 1,
      refundPolicy: 'Deposits are refundable for cancellations at least 7 days before arrival; later cancellations and no-shows forfeit the first night.',
      checkInTime: '14:00', checkOutTime: '10:00', earlyCheckInFee: '3000.00', lateCheckOutFee: '3500.00',
    },
  },
];

export function registrationTerms(policy: SeedPolicy): string {
  return REGISTRATION_TERMS.replace('{checkIn}', policy.checkInTime).replace('{checkOut}', policy.checkOutTime);
}
