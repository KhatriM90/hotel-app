import { useState } from 'react';
import { hasPermission, IDENTITY_DOCUMENT_TYPES } from '@hotel/shared';
import { api } from '../api';
import { GuestLoyaltyPanel } from '../loyalty/Loyalty';
import { ErrorText, Field, label, StatusBadge, useAction, useLoad, useSession } from '../ui';

/** Guest profiles shared across the group (FD-02, CFG-05). Identity numbers stay masked unless the user may see them. */

interface GuestRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  companyName: string | null;
}

interface GuestDetail extends GuestRow {
  dateOfBirth: string | null;
  address: string | null;
  preferences: string | null;
  notes: string | null;
  marketingConsentAt: string | null;
  stays: Array<{ id: string; number: string; propertyCode: string; status: string; arrivalDate: string; departureDate: string; roomNumber: string | null; reservationNumber: string; reservationId: string }>;
  identityDocuments: Array<{ id: string; documentType: string; documentNumber: string; issuingCountry: string; expiryDate: string | null; verifiedAt: string | null }>;
}

export function GuestsPage() {
  const { go } = useSession();
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const { data, error } = useLoad(
    () => (submitted.length >= 2 ? api.get<GuestRow[]>(`/guests?q=${encodeURIComponent(submitted)}`) : Promise.resolve([])),
    [submitted],
  );
  return (
    <>
      <div className="ys-page-head"><h1>Guests</h1></div>
      <form className="ys-row filters" onSubmit={(e) => { e.preventDefault(); setSubmitted(term.trim()); }}>
        <Field label="Search by name, phone or email"><input value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
        <button className="ys-btn">Search</button>
      </form>
      <ErrorText error={error} />
      {data && submitted && (
        <table className="ys-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Company</th><th>Nationality</th></tr></thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={5} className="ys-muted">No guest matches “{submitted}”.</td></tr>}
            {data.map((g) => (
              <tr key={g.id} className="ys-click" onClick={() => go('guest', { id: g.id })}>
                <td>{g.firstName} {g.lastName}</td><td>{g.phone ?? '—'}</td><td>{g.email ?? '—'}</td><td>{g.companyName ?? '—'}</td><td>{g.nationality ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function GuestPage({ id }: { id: string }) {
  const { me, go } = useSession();
  const { data: g, error, reload } = useLoad(() => api.get<GuestDetail>(`/guests/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ phone: '', email: '', preferences: '', notes: '' });
  const [revealed, setRevealed] = useState<GuestDetail['identityDocuments'] | null>(null);
  const [doc, setDoc] = useState({ documentType: 'national_id', documentNumber: '', issuingCountry: 'KE', expiryDate: '' });
  const save = useAction();
  const identity = useAction();
  const canIdentity = hasPermission(me.roles, 'guest.identity');

  if (error) return <ErrorText error={error} />;
  if (!g) return <p className="ys-muted">Loading…</p>;

  const docs = revealed ?? g.identityDocuments;
  return (
    <>
      <div className="ys-page-head">
        <h1>{g.firstName} {g.lastName}</h1>
        <span className="spacer" />
        {!editing && (
          <button className="ys-btn ghost" onClick={() => { setForm({ phone: g.phone ?? '', email: g.email ?? '', preferences: g.preferences ?? '', notes: g.notes ?? '' }); setEditing(true); }}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="ys-form ys-card"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await save.run(() =>
              api.patch(`/guests/${id}`, { phone: form.phone || null, email: form.email || null, preferences: form.preferences || null, notes: form.notes || null }),
            );
            if (ok) { setEditing(false); reload(); }
          }}
        >
          <div className="ys-row">
            <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          </div>
          <Field label="Preferences"><textarea rows={2} value={form.preferences} onChange={(e) => setForm({ ...form, preferences: e.target.value })} /></Field>
          <Field label="Notes"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <ErrorText error={save.error} />
          <div className="ys-actions">
            <button type="button" className="ys-btn ghost" onClick={() => setEditing(false)}>Cancel</button>
            <button className="ys-btn" disabled={save.busy}>Save</button>
          </div>
        </form>
      ) : (
        <div className="ys-card">
          <p>{[g.phone, g.email, g.nationality, g.companyName].filter(Boolean).join(' · ') || 'No contact details'}</p>
          {g.preferences && <p>Preferences: {g.preferences}</p>}
          {g.notes && <p className="ys-muted">{g.notes}</p>}
          <p className="ys-muted">Marketing consent: {g.marketingConsentAt ? new Date(g.marketingConsentAt).toLocaleDateString() : 'not given'}</p>
        </div>
      )}

      <GuestLoyaltyPanel guest={g} />

      <section className="ys-section">
        <h2>Identity documents</h2>
        <table className="ys-table compact">
          <thead><tr><th>Type</th><th>Number</th><th>Country</th><th>Expiry</th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={4} className="ys-muted">None on file.</td></tr>}
            {docs.map((d) => (
              <tr key={d.id}><td>{label(d.documentType)}</td><td>{d.documentNumber}</td><td>{d.issuingCountry}</td><td>{d.expiryDate ?? '—'}</td></tr>
            ))}
          </tbody>
        </table>
        {canIdentity && (
          <>
            {!revealed && g.identityDocuments.length > 0 && (
              <button className="ys-btn small ghost" onClick={() => identity.run(() => api.get<GuestDetail['identityDocuments']>(`/guests/${id}/identity-documents`)).then((d) => d && setRevealed(d as GuestDetail['identityDocuments']))}>
                Show full numbers (recorded in the audit log)
              </button>
            )}
            <form
              className="ys-row"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await identity.run(() => api.post(`/guests/${id}/identity-documents`, { ...doc, expiryDate: doc.expiryDate || undefined }));
                if (ok) { setDoc({ ...doc, documentNumber: '', expiryDate: '' }); setRevealed(null); reload(); }
              }}
            >
              <Field label="Document">
                <select value={doc.documentType} onChange={(e) => setDoc({ ...doc, documentType: e.target.value })}>
                  {IDENTITY_DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
                </select>
              </Field>
              <Field label="Number"><input required value={doc.documentNumber} onChange={(e) => setDoc({ ...doc, documentNumber: e.target.value })} /></Field>
              <Field label="Country"><input required maxLength={2} value={doc.issuingCountry} onChange={(e) => setDoc({ ...doc, issuingCountry: e.target.value.toUpperCase() })} /></Field>
              <Field label="Expiry"><input type="date" value={doc.expiryDate} onChange={(e) => setDoc({ ...doc, expiryDate: e.target.value })} /></Field>
              <button className="ys-btn" disabled={identity.busy}>Add document</button>
            </form>
            <ErrorText error={identity.error} />
          </>
        )}
      </section>

      <section className="ys-section">
        <h2>Stay history</h2>
        <p className="ys-muted">Only stays at the properties you can access are shown.</p>
        <table className="ys-table compact">
          <thead><tr><th>Property</th><th>Stay</th><th>Dates</th><th>Room</th><th>Status</th></tr></thead>
          <tbody>
            {g.stays.length === 0 && <tr><td colSpan={5} className="ys-muted">No stays yet.</td></tr>}
            {g.stays.map((s) => (
              <tr key={s.id} className="ys-click" onClick={() => go('reservation', { id: s.reservationId, property: s.propertyCode })}>
                <td>{s.propertyCode}</td><td>{s.number}</td><td>{s.arrivalDate} → {s.departureDate}</td><td>{s.roomNumber ?? '—'}</td><td><StatusBadge status={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
