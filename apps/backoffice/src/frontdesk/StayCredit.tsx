import { useState } from 'react';
import { hasPermission } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, kes, Modal, useAction, useLoad, useSession } from '../ui';

/**
 * Prepaid credit and nightly posting (client request, 5 Nov 2026), and the
 * booking confirmation email.
 */

export interface CreditRow {
  stayId: string;
  stayNumber: string;
  reservationId: string;
  roomNumber: string | null;
  guestName: string;
  departureDate: string;
  folioId: string;
  folioNumber: string;
  autoPostRoomCharges: boolean;
  paid: string;
  credit: string;
  nightsUnposted: number;
  nightsCovered: number;
  paidThrough: string;
  status: 'no_prepayment' | 'covered' | 'ok' | 'runs_out_tomorrow' | 'exhausted';
}

/** One line describing how far the money paid covers the stay. */
export function creditMessage(c: CreditRow): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  switch (c.status) {
    case 'no_prepayment':
      return { text: 'No prepayment; the guest pays at checkout.', tone: 'muted' };
    case 'covered':
      return { text: `All remaining nights are paid (credit ${kes(c.credit)}).`, tone: 'ok' };
    case 'ok':
      return { text: `Paid through the night before ${c.paidThrough} (${c.nightsCovered} of ${c.nightsUnposted} nights, credit ${kes(c.credit)}).`, tone: 'ok' };
    case 'runs_out_tomorrow':
      return { text: `Credit covers tonight only. Ask the guest to top up before tomorrow (credit ${kes(c.credit)}).`, tone: 'warn' };
    case 'exhausted':
      return Number(c.credit) > 0
        ? { text: `Credit of ${kes(c.credit)} does not cover tonight. Take a payment before the day close.`, tone: 'danger' }
        : { text: `Credit used up${Number(c.credit) < 0 ? `: the guest owes ${kes((-Number(c.credit)).toFixed(2))}` : ''}. Tonight is not paid.`, tone: 'danger' };
  }
}

export function StayCreditPanel({ stayId, autoPost, onChanged }: { stayId: string; autoPost: boolean; onChanged: () => void }) {
  const { property, me } = useSession();
  const canRead = hasPermission(me.roles, 'folio.read');
  const { data, reload } = useLoad(
    () => (canRead ? api.get<CreditRow[]>(`${base(property.code)}/front-desk/credit`) : Promise.resolve([] as CreditRow[])),
    [property.code, stayId, autoPost],
  );
  const [toggling, setToggling] = useState(false);
  const c = data?.find((x) => x.stayId === stayId);
  const m = c ? creditMessage(c) : null;
  return (
    <div className="ys-credit">
      {m && <p className={`ys-tone-${m.tone}`}>{m.text}</p>}
      <p className="ys-muted">
        Nightly room charge: <strong>{autoPost ? 'posted at each day close' : 'switched off, posted at checkout'}</strong>
        {hasPermission(me.roles, 'stay.auto_posting') && (
          <>
            {' '}
            <button className="ys-link" onClick={() => setToggling(true)}>{autoPost ? 'Switch off' : 'Switch on'}</button>
          </>
        )}
      </p>
      {toggling && (
        <AutoPostingModal
          stayId={stayId}
          enable={!autoPost}
          onClose={() => setToggling(false)}
          onDone={() => {
            setToggling(false);
            reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function AutoPostingModal({ stayId, enable, onClose, onDone }: { stayId: string; enable: boolean; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [reason, setReason] = useState('');
  const action = useAction();
  return (
    <Modal title={enable ? 'Switch nightly posting on' : 'Switch nightly posting off'} onClose={onClose}>
      <form
        className="ys-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await action.run(() => api.post(`${base(property.code)}/stays/${stayId}/auto-posting`, { enabled: enable, reason }));
          if (ok) onDone();
        }}
      >
        <p>
          {enable
            ? 'The room charge will be posted to the folio again at each day close. Nights not yet posted are posted at the next close.'
            : 'The day close will stop posting this stay’s room charge each night. All nights are posted together at checkout. Managers only; recorded in the audit log.'}
        </p>
        <Field label="Reason" required><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Confirm</button>
        </div>
      </form>
    </Modal>
  );
}

interface EmailMessage {
  id: string;
  to: string;
  subject: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  createdBy: string | null;
  attachments: string[];
}

const EMAIL_STATUS: Record<EmailMessage['status'], string> = {
  pending: 'Waiting to send',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed, will retry',
  dead: 'Failed, gave up',
};

/** Booking confirmation emails for a reservation, with a button to send or resend. */
export function EmailsSection({ reservationId, bookerEmail }: { reservationId: string; bookerEmail: string | null }) {
  const { property, me } = useSession();
  const { data, reload } = useLoad(
    () => api.get<{ configured: boolean; messages: EmailMessage[] }>(`${base(property.code)}/reservations/${reservationId}/emails`),
    [property.code, reservationId],
  );
  const [to, setTo] = useState(bookerEmail ?? '');
  const send = useAction();
  const canSend = hasPermission(me.roles, 'reservation.manage');
  return (
    <section className="ys-section">
      <h2>Emails to the guest</h2>
      <p className="ys-muted">
        The booking confirmation includes the reservation details, cancellation terms, hotel policies, and the pro forma and receipts as PDF attachments. It is sent
        automatically when a booking is confirmed and the booker has an email address.
      </p>
      {data && !data.configured && <p className="ys-warn">The email server is not set up yet, so messages wait here and go out once it is.</p>}
      {data && data.messages.length > 0 && (
        <table className="ys-table compact">
          <thead><tr><th>Queued</th><th>To</th><th>Attachments</th><th>Status</th></tr></thead>
          <tbody>
            {data.messages.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.createdAt).toLocaleString()}{m.createdBy ? ` · ${m.createdBy}` : ''}</td>
                <td>{m.to}</td>
                <td>{m.attachments.join(', ') || '—'}</td>
                <td title={m.lastError ?? undefined}>
                  {EMAIL_STATUS[m.status]}
                  {m.sentAt ? ` ${new Date(m.sentAt).toLocaleString()}` : ''}
                  {m.lastError && m.status !== 'sent' ? <div className="ys-muted">{m.lastError}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canSend && (
        <form
          className="ys-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await send.run(({ key }) => api.post(`${base(property.code)}/reservations/${reservationId}/emails/confirmation`, { to: to.trim() || undefined }, key));
            if (ok) reload();
          }}
        >
          <Field label="Send the booking confirmation to">
            <input type="email" required value={to} onChange={(e) => setTo(e.target.value)} placeholder="guest@example.com" />
          </Field>
          <button className="ys-btn" disabled={send.busy}>{data?.messages.length ? 'Send again' : 'Send confirmation'}</button>
        </form>
      )}
      <ErrorText error={send.error} />
    </section>
  );
}
