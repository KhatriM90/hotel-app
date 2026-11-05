/**
 * Guest profile fields the hotel can make mandatory (client request, 5 Nov
 * 2026). The rule set is group-wide because guest profiles are shared across
 * the three properties (CFG-05). The API enforces it; the back office marks
 * required fields with a star.
 */
export const GUEST_RULE_FIELDS = ['phone', 'email', 'nationality', 'kraPin', 'dateOfBirth', 'address'] as const;
export type GuestRuleField = (typeof GUEST_RULE_FIELDS)[number];

/** `required_kenyan`: required when the guest's nationality is Kenya (foreign guests have no KRA PIN). */
export const GUEST_FIELD_REQUIREMENTS = ['required', 'required_kenyan', 'optional'] as const;
export type GuestFieldRequirement = (typeof GUEST_FIELD_REQUIREMENTS)[number];

export type GuestFieldRules = Record<GuestRuleField, GuestFieldRequirement>;

export const GUEST_FIELD_LABELS: Record<GuestRuleField, string> = {
  phone: 'Phone',
  email: 'Email',
  nationality: 'Nationality',
  kraPin: 'KRA PIN',
  dateOfBirth: 'Date of birth',
  address: 'Address',
};

/** Defaults until the hotel changes them in settings. */
export const DEFAULT_GUEST_FIELD_RULES: GuestFieldRules = {
  phone: 'required',
  email: 'optional',
  nationality: 'required',
  kraPin: 'required_kenyan',
  dateOfBirth: 'optional',
  address: 'optional',
};

/** KRA PIN: a letter (A for individuals, P for companies), nine digits and a letter, e.g. A012345678Z. */
export const KRA_PIN_PATTERN = /^[A-Z][0-9]{9}[A-Z]$/;

export function isFieldRequired(rule: GuestFieldRequirement, nationality: string | null | undefined): boolean {
  if (rule === 'required') return true;
  if (rule === 'required_kenyan') return (nationality ?? '').toUpperCase() === 'KE';
  return false;
}

/** Fields that are required by the rules but empty on this guest. */
export function missingGuestFields(guest: Partial<Record<GuestRuleField, string | null | undefined>>, rules: GuestFieldRules): GuestRuleField[] {
  return GUEST_RULE_FIELDS.filter((f) => isFieldRequired(rules[f], guest.nationality) && !String(guest[f] ?? '').trim());
}
