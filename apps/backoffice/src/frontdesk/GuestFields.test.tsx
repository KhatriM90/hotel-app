import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GUEST_FIELD_RULES } from '@hotel/shared';
import { contactProblem, ContactFields, CountrySelect, EMPTY_CONTACT, GuestContact } from './GuestFields';

afterEach(cleanup);

function Picker() {
  const [code, setCode] = useState('KE');
  return (
    <>
      <CountrySelect value={code} onChange={setCode} />
      <output>{code}</output>
    </>
  );
}

describe('CountrySelect (every country, searchable)', () => {
  it('shows the name, finds a country by typing and picks it', () => {
    render(<Picker />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('Kenya');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'tanz' } });
    fireEvent.click(screen.getByRole('option', { name: /Tanzania/ }));
    expect(document.querySelector('output')!.textContent).toBe('TZ');
    expect(input.value).toBe('Tanzania');
  });

  it('matches the two-letter code and picks with the keyboard', () => {
    render(<Picker />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ug' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.querySelector('output')!.textContent).toBe('UG');
  });
});

function Contact({ initial }: { initial: GuestContact }) {
  const [c, setC] = useState(initial);
  return <ContactFields value={c} onChange={setC} rules={DEFAULT_GUEST_FIELD_RULES} compact />;
}

describe('ContactFields (mandatory fields marked with a star)', () => {
  it('stars KRA PIN for a Kenyan guest but not for a foreign one', () => {
    render(<Contact initial={EMPTY_CONTACT} />);
    expect(screen.getByText('KRA PIN').querySelector('.ys-req')).not.toBeNull();
    expect(screen.getByText('Email').querySelector('.ys-req')).toBeNull();
    cleanup();
    render(<Contact initial={{ ...EMPTY_CONTACT, nationality: 'GB' }} />);
    expect(screen.getByText('KRA PIN').querySelector('.ys-req')).toBeNull();
  });

  it('explains what is missing or malformed', () => {
    expect(contactProblem({ ...EMPTY_CONTACT, phone: '+254700000000' }, DEFAULT_GUEST_FIELD_RULES)).toBe('Please fill in: KRA PIN');
    expect(contactProblem({ ...EMPTY_CONTACT, phone: '+254700000000', kraPin: 'A12' }, DEFAULT_GUEST_FIELD_RULES)).toMatch(/A012345678Z/);
    expect(contactProblem({ ...EMPTY_CONTACT, phone: '+254700000000', kraPin: 'A123456789Z' }, DEFAULT_GUEST_FIELD_RULES)).toBeNull();
  });
});
