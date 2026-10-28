import { useState } from 'react';
import { GUEST_REQUEST_CATEGORIES, GUEST_REQUEST_STATUSES } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, label, StatusBadge, useAction, useLoad, useSession } from '../ui';

/** Guest requests with an owner, status and notes (FD-07). */

interface GuestRequest {
  id: string;
  category: string;
  description: string;
  priority: string;
  status: string;
  dueAt: string | null;
  createdAt: string;
  roomNumber: string | null;
  stayNumber: string | null;
  guestName: string | null;
  owner: string | null;
  ownerUserId: string | null;
  createdBy: string | null;
  notes: Array<{ note: string; by: string | null; at: string }>;
}

interface Room {
  id: string;
  number: string;
  stayId: string | null;
  guestName: string | null;
  stayStatus: string | null;
}

export function RequestsPage() {
  const { property } = useSession();
  const [filter, setFilter] = useState('');
  const list = useLoad(() => api.get<GuestRequest[]>(`${base(property.code)}/guest-requests${filter ? `?status=${filter}` : ''}`), [property.code, filter]);
  const staff = useLoad(() => api.get<Array<{ id: string; displayName: string }>>(`${base(property.code)}/staff`), [property.code]);
  const rooms = useLoad(() => api.get<Room[]>(`${base(property.code)}/rooms`), [property.code]);
  const [form, setForm] = useState({ roomId: '', category: 'housekeeping', description: '', priority: 'normal', ownerUserId: '' });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const create = useAction();
  const update = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const room = rooms.data?.find((r) => r.id === form.roomId);
    const inHouse = room?.stayId && room.stayStatus === 'checked_in' ? room.stayId : undefined;
    const ok = await create.run(({ key }) =>
      api.post(
        `${base(property.code)}/guest-requests`,
        {
          stayId: inHouse,
          roomId: inHouse ? undefined : form.roomId || undefined,
          category: form.category,
          description: form.description,
          priority: form.priority,
          ownerUserId: form.ownerUserId || undefined,
        },
        key,
      ),
    );
    if (ok) {
      setForm({ ...form, description: '' });
      list.reload();
    }
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    update.run(() => api.patch(`${base(property.code)}/guest-requests/${id}`, body)).then((ok) => {
      if (ok) {
        setNotes((n) => ({ ...n, [id]: '' }));
        list.reload();
      }
    });

  return (
    <>
      <div className="ys-page-head"><h1>Guest requests · {property.name}</h1></div>
      <form className="ys-form ys-card" onSubmit={submit}>
        <div className="ys-row">
          <Field label="Room">
            <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
              <option value="">No room</option>
              {(rooms.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.number}{r.stayStatus === 'checked_in' && r.guestName ? ` · ${r.guestName}` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {GUEST_REQUEST_CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </Field>
          <Field label="Owner">
            <select value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}>
              <option value="">Unassigned</option>
              {(staff.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
          </Field>
        </div>
        <Field label="What is needed"><input required minLength={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <ErrorText error={create.error} />
        <div className="ys-actions"><button className="ys-btn" disabled={create.busy}>Log request</button></div>
      </form>

      <div className="ys-row filters">
        <Field label="Show">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            {GUEST_REQUEST_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </Field>
      </div>
      <ErrorText error={list.error ?? update.error} />
      {(list.data ?? []).map((r) => (
        <div key={r.id} className="ys-card ys-section">
          <div className="ys-page-head">
            <strong>{label(r.category)}</strong>
            <StatusBadge status={r.status} />
            {r.priority !== 'normal' && <StatusBadge status={r.priority} />}
            <span className="ys-muted">{r.roomNumber ? `Room ${r.roomNumber}` : 'No room'}{r.guestName ? ` · ${r.guestName}` : ''}</span>
            <span className="spacer" />
            <select aria-label="Owner" value={r.ownerUserId ?? ''} onChange={(e) => patch(r.id, { ownerUserId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {(staff.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
            <select aria-label="Status" value={r.status} onChange={(e) => patch(r.id, { status: e.target.value })}>
              {GUEST_REQUEST_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </div>
          <p>{r.description}</p>
          <p className="ys-muted">Logged by {r.createdBy ?? 'system'} · {new Date(r.createdAt).toLocaleString()}</p>
          {r.notes.length > 0 && (
            <ul className="ys-notes">
              {r.notes.map((n, i) => <li key={i}>{n.note} <span className="ys-muted">· {n.by} · {new Date(n.at).toLocaleString()}</span></li>)}
            </ul>
          )}
          <form className="ys-row" onSubmit={(e) => { e.preventDefault(); if (notes[r.id]) void patch(r.id, { note: notes[r.id] }); }}>
            <Field label="Add a note"><input value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} /></Field>
            <button className="ys-btn small ghost">Add</button>
          </form>
        </div>
      ))}
      {list.data?.length === 0 && <p className="ys-muted">No requests.</p>}
    </>
  );
}
