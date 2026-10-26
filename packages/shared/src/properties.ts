/**
 * The three properties in scope (brief v1.2 "Planning assumptions", CFG-04, §15A).
 * Codes double as the document-number prefix and SAP Dimension 1.
 * SAP branch (BPLId) and eTIMS branch ID (bhfId) are still TBC with the client.
 */
export const PROPERTY_CODES = ['K1', 'SW', 'KM'] as const;
export type PropertyCode = (typeof PROPERTY_CODES)[number] | (string & {});

export interface PropertySeed {
  code: (typeof PROPERTY_CODES)[number];
  name: string;
  location: string;
  isHeadOffice: boolean;
  plannedRooms: number;
  plannedOutlets: number;
}

export const PROPERTY_SEEDS: readonly PropertySeed[] = [
  { code: 'K1', name: 'K1 Klubhouse', location: 'Parklands, Nairobi', isHeadOffice: true, plannedRooms: 13, plannedOutlets: 9 },
  { code: 'SW', name: 'Small World Country Club', location: 'Lukenya, Athi River', isHeadOffice: false, plannedRooms: 42, plannedOutlets: 8 },
  { code: 'KM', name: 'Kahama Mombasa', location: 'Mombasa', isHeadOffice: false, plannedRooms: 32, plannedOutlets: 4 },
];

/** SAP Dimension 2 / revenue centres (SAP-15, §15C). */
export const REVENUE_CENTRES = ['ROOMS', 'REST', 'BAR', 'RSVC', 'CONF', 'LEIS', 'OTHER'] as const;
export type RevenueCentre = (typeof REVENUE_CENTRES)[number];

/** Outlet and station types (CFG-03). */
export const OUTLET_TYPES = ['restaurant', 'bar', 'room_service', 'store', 'conference', 'leisure', 'other'] as const;
export type OutletType = (typeof OUTLET_TYPES)[number];
