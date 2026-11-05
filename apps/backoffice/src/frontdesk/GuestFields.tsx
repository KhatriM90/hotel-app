import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  COUNTRIES,
  countryName,
  DEFAULT_GUEST_FIELD_RULES,
  GUEST_FIELD_LABELS,
  GuestFieldRules,
  isFieldRequired,
  KRA_PIN_PATTERN,
  missingGuestFields,
} from '@hotel/shared';
import { api } from '../api';
import { Field } from '../ui';

/**
 * Guest contact fields with the hotel's mandatory-field rules (client request,
 * 5 Nov 2026): required fields carry a red star, the KRA PIN is checked for
 * shape, and nationality is a searchable list of every country.
 */

let cached: Promise<GuestFieldRules> | null = null;

/** The group's guest field rules; loaded once per page load, falls back to the defaults while loading. */
export function useGuestRules(): GuestFieldRules {
  const [rules, setRules] = useState<GuestFieldRules>(DEFAULT_GUEST_FIELD_RULES);
  useEffect(() => {
    cached ??= api.get<GuestFieldRules>('/guest-field-rules').catch(() => DEFAULT_GUEST_FIELD_RULES);
    let live = true;
    cached.then((r) => live && setRules(r));
    return () => {
      live = false;
    };
  }, []);
  return rules;
}

/** Forget the cached rules after a manager changes them. */
export function resetGuestRules(): void {
  cached = null;
}

export interface GuestContact {
  phone: string;
  email: string;
  nationality: string;
  kraPin: string;
  dateOfBirth: string;
  address: string;
}

export const EMPTY_CONTACT: GuestContact = { phone: '', email: '', nationality: 'KE', kraPin: '', dateOfBirth: '', address: '' };

/** Message for the first problem with the contact fields, or null when they pass the rules. */
export function contactProblem(c: GuestContact, rules: GuestFieldRules): string | null {
  const missing = missingGuestFields(c, rules);
  if (missing.length) return `Please fill in: ${missing.map((f) => GUEST_FIELD_LABELS[f]).join(', ')}`;
  if (c.kraPin && !KRA_PIN_PATTERN.test(c.kraPin.trim().toUpperCase())) return 'KRA PIN looks like A012345678Z: a letter, nine digits and a letter';
  return null;
}

/** The body the API expects: empty strings become absent. */
export function contactBody(c: GuestContact, emptyAs: null | undefined = undefined) {
  const v = (s: string) => (s.trim() ? s.trim() : emptyAs);
  return {
    phone: v(c.phone),
    email: v(c.email),
    nationality: v(c.nationality),
    kraPin: c.kraPin.trim() ? c.kraPin.trim().toUpperCase() : emptyAs,
    dateOfBirth: v(c.dateOfBirth),
    address: v(c.address),
  };
}

export function ContactFields({ value, onChange, rules, compact }: { value: GuestContact; onChange: (c: GuestContact) => void; rules: GuestFieldRules; compact?: boolean }) {
  const req = (f: keyof GuestFieldRules) => isFieldRequired(rules[f], value.nationality);
  const set = (patch: Partial<GuestContact>) => onChange({ ...value, ...patch });
  const pinBad = !!value.kraPin && !KRA_PIN_PATTERN.test(value.kraPin.trim().toUpperCase());
  return (
    <>
      <Field label="Phone" required={req('phone')}>
        <input value={value.phone} required={req('phone')} onChange={(e) => set({ phone: e.target.value })} placeholder="+254…" />
      </Field>
      <Field label="Email" required={req('email')}>
        <input type="email" value={value.email} required={req('email')} onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field label="Nationality" required={req('nationality')}>
        <CountrySelect value={value.nationality} onChange={(nationality) => set({ nationality })} required={req('nationality')} />
      </Field>
      <Field label="KRA PIN" required={req('kraPin')} hint={pinBad ? 'Format: A012345678Z' : value.nationality && value.nationality !== 'KE' && rules.kraPin === 'required_kenyan' ? 'Not needed for foreign guests' : undefined}>
        <input
          value={value.kraPin}
          required={req('kraPin')}
          maxLength={11}
          aria-invalid={pinBad || undefined}
          onChange={(e) => set({ kraPin: e.target.value.toUpperCase() })}
          placeholder="A012345678Z"
        />
      </Field>
      {(!compact || req('dateOfBirth')) && (
        <Field label="Date of birth" required={req('dateOfBirth')}>
          <input type="date" value={value.dateOfBirth} required={req('dateOfBirth')} onChange={(e) => set({ dateOfBirth: e.target.value })} />
        </Field>
      )}
      {(!compact || req('address')) && (
        <Field label="Address" required={req('address')}>
          <input value={value.address} required={req('address')} onChange={(e) => set({ address: e.target.value })} />
        </Field>
      )}
    </>
  );
}

/**
 * Type-to-search country picker over every ISO country (client request:
 * "Nationality doesn't have all countries and doesn't search"). Matches the
 * name or the two-letter code; arrow keys and Enter pick from the list.
 */
export function CountrySelect({ value, onChange, required, id }: { value: string; onChange: (code: string) => void; required?: boolean; id?: string }) {
  const listId = useId();
  const [text, setText] = useState(countryName(value) ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setText(countryName(value) ?? ''), [value]);

  const matches = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!t || countryName(value)?.toLowerCase() === t) return COUNTRIES.slice();
    return COUNTRIES.filter(([code, name]) => code.toLowerCase() === t || name.toLowerCase().includes(t)).sort(
      ([, a], [, b]) => Number(!a.toLowerCase().startsWith(t)) - Number(!b.toLowerCase().startsWith(t)),
    );
  }, [text, value]);

  function pick(code: string) {
    onChange(code);
    setText(countryName(code) ?? code);
    setOpen(false);
  }

  return (
    <div
      className="ys-combo"
      ref={box}
      onBlur={(e) => {
        if (box.current?.contains(e.relatedTarget as Node)) return;
        setOpen(false);
        // Leaving with text that is not a country puts the last valid choice back.
        if (countryName(value) !== text) setText(countryName(value) ?? '');
      }}
    >
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        required={required}
        value={text}
        placeholder="Type to search"
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          if (!e.target.value.trim() && !required) onChange('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && matches[active]) {
            e.preventDefault();
            pick(matches[active][0]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="ys-combo-list">
          {matches.length === 0 && <li className="ys-muted">No country matches</li>}
          {matches.slice(0, 60).map(([code, name], i) => (
            <li
              key={code}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(code)}
            >
              {name} <span className="ys-muted">{code}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
