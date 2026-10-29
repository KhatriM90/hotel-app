/**
 * Invented demo guests. Every name, phone number and ID number is made up;
 * phones use the +254 700 55x xxx range so demo guests are easy to tell from
 * real ones, and every profile carries the note "Demo data".
 */
export interface DemoGuest {
  key: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  nationality: string;
  /** Identity document recorded at check-in (FD-03). */
  id: { documentType: 'national_id' | 'passport'; documentNumber: string; issuingCountry: string };
  preferences?: string;
}

const ke = (key: string, firstName: string, lastName: string, n: number, idNumber: string, preferences?: string): DemoGuest => ({
  key,
  firstName,
  lastName,
  phone: `+254700${String(550000 + n)}`,
  email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@demo.yeastay.example',
  nationality: 'KE',
  id: { documentType: 'national_id', documentNumber: idNumber, issuingCountry: 'KE' },
  preferences,
});

const visitor = (key: string, firstName: string, lastName: string, n: number, country: string, passport: string): DemoGuest => ({
  key,
  firstName,
  lastName,
  phone: `+254700${String(550000 + n)}`,
  email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@demo.yeastay.example',
  nationality: country,
  id: { documentType: 'passport', documentNumber: passport, issuingCountry: country },
});

export const DEMO_GUESTS: DemoGuest[] = [
  // K1 Klubhouse, Parklands
  ke('k1-corporate', 'Peter', 'Kamau', 101, '28451937', 'Quiet room, away from the lift'),
  ke('k1-due-out', 'Mercy', 'Wanjiku', 102, '31205846'),
  ke('k1-checked-out', 'David', 'Ochieng', 103, '27764019'),
  ke('k1-late-out', 'Faith', 'Muthoni', 104, '33918265'),
  ke('k1-no-show', 'Kevin', 'Kiprotich', 105, '29573148'),
  ke('k1-city-ledger', 'Esther', 'Achieng', 106, '30681427'),
  ke('k1-arrival-deposit', 'Samuel', 'Njoroge', 107, '26390578', 'Airport pick-up on arrival'),
  ke('k1-arrival-dirty', 'Lucy', 'Wambui', 108, '32847106'),
  ke('k1-walk-in', 'Joseph', 'Mutua', 109, '25163984'),
  ke('k1-override', 'Ann', 'Chebet', 110, '34572910'),
  ke('k1-late-cancel', 'Daniel', 'Omondi', 111, '28036751'),
  ke('k1-future', 'Grace', 'Nyambura', 112, '31749263'),
  ke('k1-enquiry', 'Brian', 'Kibet', 113, '29918437'),
  ke('k1-hold', 'Caroline', 'Akinyi', 114, '33106582'),
  ke('k1-cancelled', 'Moses', 'Waweru', 115, '27390814'),
  visitor('k1-group-lead', 'Sophie', 'Laurent', 116, 'FR', '19FR42871'),
  ke('k1-group-2', 'Ibrahim', 'Abdi', 117, '30027465'),

  // Small World Country Club, Lukenya
  ke('sw-family', 'John', 'Maina', 201, '24781036', 'Baby cot in the cottage'),
  ke('sw-family-2', 'Ruth', 'Maina', 202, '25890314'),
  ke('sw-due-out', 'Nancy', 'Wairimu', 203, '32158947'),
  ke('sw-checked-out', 'Collins', 'Otieno', 204, '29647310'),
  ke('sw-arrival', 'Beatrice', 'Nduta', 205, '31570682'),
  ke('sw-walk-in', 'Patrick', 'Kariuki', 206, '27913845'),
  ke('sw-group-lead', 'Elizabeth', 'Njeri', 207, '30485129'),
  ke('sw-festive', 'George', 'Owino', 208, '26074918'),
  ke('sw-cancelled', 'Agnes', 'Moraa', 209, '33682057'),

  // Kahama, Mombasa
  visitor('km-agent', 'Hans', 'Becker', 301, 'DE', 'C4F7K2M91'),
  ke('km-due-out', 'Fatuma', 'Ali', 302, '28530194'),
  ke('km-checked-out', 'Hassan', 'Mohamed', 303, '31046827'),
  ke('km-no-show', 'Zawadi', 'Kombo', 304, '29781350'),
  ke('km-arrival', 'Mwanajuma', 'Salim', 305, '32694017'),
  ke('km-walk-in', 'Omar', 'Bakari', 306, '27158493'),
  visitor('km-future', 'Emma', 'Clarke', 307, 'GB', '548213097'),
  ke('km-enquiry', 'Rashid', 'Juma', 308, '30915742'),
];

export function demoGuest(key: string): DemoGuest {
  const g = DEMO_GUESTS.find((x) => x.key === key);
  if (!g) throw new Error(`Unknown demo guest ${key}`);
  return g;
}

/** Text that marks a record as demo data wherever the app has a notes field. */
export const DEMO_NOTE = 'Demo data';
