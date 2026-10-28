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
 * Discount, refund, comp and stock approvals arrive with POS and billing.
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

  // Folio (BIL-01, BIL-06, BIL-09)
  'folio.read': ['owner', 'admin', 'area_manager', 'group_accounts', 'manager', 'receptionist', 'cashier', 'accountant'],
  'folio.charge': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier'],
  'payment.take': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier'],
  'payment.confirm': ['owner', 'area_manager', 'manager', 'receptionist', 'cashier', 'accountant'],

  // Approvals (SEC-02). Holders approve their own actions; others need a holder's sign-off.
  'approve.rate_override': ['owner', 'area_manager', 'manager'],
  'approve.fee_waiver': ['owner', 'area_manager', 'manager'],
  'approve.charge_reversal': ['owner', 'area_manager', 'manager'],
  'approve.credit_transfer': ['owner', 'area_manager', 'manager', 'group_accounts'],
  'approve.room_not_ready': ['owner', 'area_manager', 'manager'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  const allowed = PERMISSIONS[permission] as readonly string[];
  return roles.some((r) => allowed.includes(r));
}
