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
 * Server-side permission matrix (SEC-02/SEC-03). Extend as modules land;
 * the approval matrix for discounts, refunds etc. arrives with POS/billing.
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
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  const allowed = PERMISSIONS[permission] as readonly string[];
  return roles.some((r) => allowed.includes(r));
}
