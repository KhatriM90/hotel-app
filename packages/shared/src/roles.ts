/**
 * Named roles (SEC-01) and group-wide roles (SEC-06).
 * Group roles see all properties; every other role is limited to the
 * properties assigned in user_property_access.
 */
export const ROLES = [
  'owner',
  'group_accounts',
  'area_manager',
  'admin',
  'manager',
  'receptionist',
  'cashier',
  'waiter',
  'bartender',
  'kitchen',
  'housekeeper',
  'storekeeper',
  'accountant',
] as const;

export type Role = (typeof ROLES)[number];

export const GROUP_ROLES: readonly Role[] = ['owner', 'group_accounts', 'area_manager', 'admin'];

/**
 * Server-side permission matrix (SEC-02/SEC-03). Extend as modules land.
 * `approve.*` entries are the approval matrix: who may sign off an override.
 * Stock approvals arrive with INV-*.
 */
export const PERMISSIONS = {
  'property.read': ROLES,
  'property.configure': ['owner', 'admin'],
  'outlet.read': ROLES,
  'outlet.manage': ['owner', 'admin', 'manager'],
  'integration.read': ['owner', 'admin', 'group_accounts', 'accountant', 'manager'],
  'integration.manage': ['owner', 'admin', 'group_accounts'],
  'audit.read': ['owner', 'admin', 'group_accounts'],
  'user.manage': ['owner', 'admin'],

  // Rooms and rates (CFG-02, RES-05)
  'room.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'housekeeper', 'accountant'],
  'room.status': ['owner', 'admin', 'manager', 'receptionist', 'housekeeper'],
  'room.block': ['owner', 'admin', 'area_manager', 'manager', 'receptionist'],
  'rate.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'accountant'],
  'rate.manage': ['owner', 'admin', 'area_manager', 'manager'],
  'policy.manage': ['owner', 'admin', 'area_manager', 'manager'],

  // Reservations and front desk (RES-*, FD-*)
  'reservation.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'accountant'],
  'reservation.manage': ['owner', 'admin', 'area_manager', 'manager', 'receptionist'],
  'frontdesk.operate': ['owner', 'admin', 'area_manager', 'manager', 'receptionist'],
  'guest.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'accountant'],
  'guest.manage': ['owner', 'admin', 'area_manager', 'manager', 'receptionist'],
  // FD-02, AT-14: identity documents are restricted; waiters, bar and kitchen staff never see them.
  'guest.identity': ['owner', 'area_manager', 'manager', 'receptionist'],
  'guest_request.manage': ['owner', 'admin', 'area_manager', 'manager', 'receptionist', 'housekeeper'],
  'businessday.close': ['owner', 'admin', 'area_manager', 'manager'],
  // CFG-01: business-day cut-off per property and outlet, POS outlet settings.
  'businessday.configure': ['owner', 'admin', 'area_manager', 'manager'],

  // Folio (BIL-01, BIL-06, BIL-09)
  'folio.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'accountant'],
  'folio.charge': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier'],
  'payment.take': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier'],
  'payment.confirm': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier', 'accountant'],

  // Restaurant, bar and kitchen POS (POS-*)
  'pos.use': ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender'],
  'pos.kitchen': ['owner', 'area_manager', 'manager', 'kitchen', 'bartender'],
  'pos.settle': ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender'],
  'pos.room_charge': ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender'],
  // AT-14: waiters and bartenders cannot refund, even with a manager present.
  'pos.refund': ['owner', 'area_manager', 'manager', 'cashier'],
  'pos.shift': ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender'],
  'pos.day_close': ['owner', 'area_manager', 'manager'],
  'pos.menu.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'cashier', 'waiter', 'bartender', 'kitchen', 'accountant'],
  'pos.menu.manage': ['owner', 'admin', 'area_manager', 'manager'],
  // POS-12: floor and kitchen staff mark items unavailable ("86") as it happens.
  'pos.availability': ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender', 'kitchen'],
  'pos.report': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'accountant'],

  // Loyalty and club membership (LOY15, CLUB01, CAT11). Cashiers identify
  // members and ask for verified redemptions; managers approve adjustments and
  // merges; programme administrators change rules; finance runs month end.
  'loyalty.lookup': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'waiter', 'bartender', 'accountant'],
  'loyalty.enrol': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier', 'waiter', 'bartender'],
  'loyalty.redeem': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier', 'waiter', 'bartender'],
  // Full member profile and history; POS staff see a masked summary only.
  'loyalty.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'accountant'],
  'loyalty.manage': ['owner', 'area_manager', 'manager', 'receptionist'],
  'loyalty.club.manage': ['owner', 'area_manager', 'manager'],
  'loyalty.programme': ['owner', 'admin', 'area_manager'],
  'loyalty.finance': ['owner', 'group_accounts', 'accountant'],
  'loyalty.report': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'accountant'],

  // Approvals (SEC-02). Holders approve their own actions; others need a holder's sign-off.
  'approve.rate_override': ['owner', 'area_manager', 'manager'],
  'approve.fee_waiver': ['owner', 'area_manager', 'manager'],
  'approve.charge_reversal': ['owner', 'area_manager', 'manager'],
  'approve.credit_transfer': ['owner', 'area_manager', 'manager', 'group_accounts'],
  'approve.room_not_ready': ['owner', 'area_manager', 'manager'],
  'approve.discount': ['owner', 'area_manager', 'manager'],
  'approve.comp': ['owner', 'area_manager', 'manager'],
  'approve.void': ['owner', 'area_manager', 'manager'],
  'approve.waste': ['owner', 'area_manager', 'manager'],
  'approve.refund': ['owner', 'area_manager', 'manager'],
  'approve.liquor_override': ['owner', 'area_manager', 'manager'],
  'approve.cash_out': ['owner', 'area_manager', 'manager'],
  'approve.cash_variance': ['owner', 'area_manager', 'manager', 'group_accounts', 'accountant'],
  'approve.house_account': ['owner', 'area_manager', 'manager'],
  'approve.loyalty_adjustment': ['owner', 'area_manager', 'manager'],
  'approve.loyalty_merge': ['owner', 'area_manager', 'manager'],
  'approve.club_override': ['owner', 'area_manager'],
  'approve.cashback_batch': ['owner', 'group_accounts'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  const allowed = PERMISSIONS[permission] as readonly string[];
  return roles.some((r) => allowed.includes(r));
}
