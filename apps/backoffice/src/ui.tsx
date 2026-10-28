import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Money } from '@hotel/shared';
import { api, ApiError, Me, newIdempotencyKey, Property } from './api';

/** Shared building blocks for the reception screens. */

export interface Session {
  me: Me;
  property: Property;
  /** Navigate within the back office, e.g. go('reservation', { id }). */
  go: (page: string, params?: Record<string, string>) => void;
  /** Re-read the property, e.g. after a day close changed the business date. */
  refreshProperty: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('No session');
  return s;
}

export function base(code: string): string {
  return `/properties/${encodeURIComponent(code)}`;
}

export function kes(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  try {
    return Money.of(value).format();
  } catch {
    return value;
  }
}

export function label(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`ys-badge st-${status}`}>{label(status)}</span>;
}

/** Loads data and exposes a reload; errors become a message instead of a blank screen. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let live = true;
    setError(null);
    loader.current().then(
      (d) => live && setData(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ys-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ys-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ys-modal-head">
          <h2>{title}</h2>
          <button className="ys-btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label: text, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="ys-field">
      <span>{text}</span>
      {children}
      {hint && <small className="ys-muted">{hint}</small>}
    </label>
  );
}

/**
 * Runs an action that may need a manager's sign-off (SEC-02). When the API
 * answers approval_required, the form shows approver fields and the same
 * Idempotency-Key is reused on resubmit, so a retry never doubles the action.
 */
export function useAction<T>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approval, setApproval] = useState({ username: '', password: '' });
  const key = useRef(newIdempotencyKey());

  async function run(fn: (ctx: { key: string; approval?: { username: string; password: string } }) => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const result = await fn({ key: key.current, approval: needsApproval ? approval : undefined });
      key.current = newIdempotencyKey();
      setNeedsApproval(false);
      return result;
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'approval_required' || err.code === 'approval_rejected') {
        setNeedsApproval(true);
        key.current = newIdempotencyKey(); // the refused attempt stored nothing, but keep keys honest
      } else if (err.status && err.status < 500) {
        key.current = newIdempotencyKey(); // corrected input is a new request
      }
      setError(err.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const approvalFields = needsApproval ? (
    <fieldset className="ys-approval">
      <legend>Manager approval</legend>
      <div className="ys-row">
        <Field label="Approver username">
          <input value={approval.username} onChange={(e) => setApproval({ ...approval, username: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Approver password">
          <input type="password" value={approval.password} onChange={(e) => setApproval({ ...approval, password: e.target.value })} autoComplete="off" />
        </Field>
      </div>
    </fieldset>
  ) : null;

  return { run, busy, error, approvalFields, setError };
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="ys-error" role="alert">{error}</p> : null;
}

/** Opens a printable document from the API in a new tab (FD-04, BIL-09). */
export async function openPrintable(path: string): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const html = await api.html(path);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (e) {
    win?.close();
    alert((e as Error).message);
  }
}

export function today(property: Property): string {
  return property.currentBusinessDate;
}
