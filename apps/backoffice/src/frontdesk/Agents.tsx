import { useState } from 'react';
import { hasPermission, KRA_PIN_PATTERN } from '@hotel/shared';
import { api } from '../api';
import { ErrorText, Field, Modal, useAction, useLoad, useSession } from '../ui';

/**
 * Travel agents and companies (client request, 5 Nov 2026: "there should be
 * an option to define a new travel agent"). Shared across the three
 * properties; reception can add and edit them, nothing is ever deleted
 * (an agent that stops working with the hotel is made inactive).
 */

export interface Company {
  id: string;
  kind: 'company' | 'agent';
  name: string;
  kraPin: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  creditDays: number | null;
  notes: string | null;
  isActive: boolean;
}

const KIND_LABEL = { agent: 'Travel agent', company: 'Company' } as const;

export function AgentsPage() {
  const { me } = useSession();
  const [kind, setKind] = useState<'agent' | 'company'>('agent');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const { data, error, reload } = useLoad(() => api.get<Company[]>(`/companies?kind=${kind}${showInactive ? '&all=true' : ''}`), [kind, showInactive]);
  const canManage = hasPermission(me.roles, 'company.manage');

  return (
    <>
      <div className="ys-page-head">
        <h1>Travel agents and companies</h1>
        <span className="spacer" />
        <div className="ys-segmented" role="group" aria-label="Show">
          <button aria-pressed={kind === 'agent'} onClick={() => setKind('agent')}>Travel agents</button>
          <button aria-pressed={kind === 'company'} onClick={() => setKind('company')}>Companies</button>
        </div>
        {canManage && <button className="ys-btn" onClick={() => setEditing('new')}>New {kind === 'agent' ? 'travel agent' : 'company'}</button>}
      </div>
      <p className="ys-muted">Shared by all three properties. Agents appear in the booking form under “Travel agent”; companies under “Company”.</p>
      <label className="ys-check">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
      </label>
      <ErrorText error={error} />
      {data && (
        <table className="ys-table">
          <thead>
            <tr><th>Name</th><th>KRA PIN</th><th>Contact</th><th>Phone</th><th>Email</th><th>Credit days</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={7} className="ys-muted">None yet.</td></tr>}
            {data.map((c) => (
              <tr key={c.id} className={canManage ? 'ys-click' : ''} onClick={() => canManage && setEditing(c)}>
                <td>{c.name}</td>
                <td>{c.kraPin ?? '—'}</td>
                <td>{c.contactName ?? '—'}</td>
                <td>{c.contactPhone ?? '—'}</td>
                <td>{c.contactEmail ?? '—'}</td>
                <td>{c.creditDays ?? '—'}</td>
                <td>{c.isActive ? 'Active' : 'Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <CompanyModal
          kind={editing === 'new' ? kind : editing.kind}
          company={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

/** Add or edit a travel agent or company. Also opened from the booking form. */
export function CompanyModal({ kind, company, onClose, onSaved }: { kind: 'agent' | 'company'; company: Company | null; onClose: () => void; onSaved: (c: Company) => void }) {
  const [f, setF] = useState({
    name: company?.name ?? '',
    kraPin: company?.kraPin ?? '',
    contactName: company?.contactName ?? '',
    contactPhone: company?.contactPhone ?? '',
    contactEmail: company?.contactEmail ?? '',
    creditDays: company?.creditDays?.toString() ?? '',
    notes: company?.notes ?? '',
    isActive: company?.isActive ?? true,
  });
  const save = useAction<Company>();
  const pinBad = !!f.kraPin && !KRA_PIN_PATTERN.test(f.kraPin.trim().toUpperCase());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pinBad) return save.setError('KRA PIN looks like P051234567Q: a letter, nine digits and a letter');
    const body = {
      name: f.name.trim(),
      kraPin: f.kraPin.trim() || null,
      contactName: f.contactName.trim() || null,
      contactPhone: f.contactPhone.trim() || null,
      contactEmail: f.contactEmail.trim() || null,
      creditDays: f.creditDays ? Number(f.creditDays) : null,
      notes: f.notes.trim() || null,
      isActive: f.isActive,
    };
    const saved = await save.run(() => (company ? api.patch<Company>(`/companies/${company.id}`, body) : api.post<Company>('/companies', { kind, ...body })));
    if (saved) onSaved(saved);
  }

  return (
    <Modal title={company ? `Edit ${company.name}` : `New ${KIND_LABEL[kind].toLowerCase()}`} onClose={onClose}>
      <form className="ys-form" onSubmit={submit}>
        <Field label="Name" required><input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="ys-row">
          <Field label="KRA PIN" hint={pinBad ? 'Format: P051234567Q' : undefined}>
            <input maxLength={11} value={f.kraPin} aria-invalid={pinBad || undefined} onChange={(e) => setF({ ...f, kraPin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Credit days" hint="Days to pay an invoice">
            <input type="number" min={0} max={365} value={f.creditDays} onChange={(e) => setF({ ...f, creditDays: e.target.value })} />
          </Field>
        </div>
        <div className="ys-row">
          <Field label="Contact person"><input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
          <Field label="Phone"><input value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} placeholder="+254…" /></Field>
          <Field label="Email"><input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {company && (
          <label className="ys-check">
            <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active (inactive ones are hidden from the booking form)
          </label>
        )}
        <ErrorText error={save.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={save.busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
