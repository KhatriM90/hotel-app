/**
 * Durable offline order queue (OPS-05). While the connection is down a waiter
 * can open checks, add items and send them; each action is stored with its
 * own idempotency key and device-generated ids and replayed in order when the
 * server is back. A replay that the server already processed is answered from
 * the server's idempotency record, so nothing is posted twice. Payments and
 * room charges are never queued: they need a live answer (OPS-04).
 */
import { ApiError, OfflineError } from './api';

export interface QueuedAction {
  id: string;
  method: 'POST';
  path: string;
  body: unknown;
  key: string;
  /** What the waiter did, for the pending list. */
  label: string;
  checkId: string;
  createdAt: string;
  error?: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Sender = (action: QueuedAction) => Promise<unknown>;

const QUEUE_KEY = 'yeastay.pwa.queue';

export class OfflineQueue {
  private flushing: Promise<FlushResult> | null = null;

  constructor(private readonly store: Store = localStorage) {}

  list(): QueuedAction[] {
    try {
      return JSON.parse(this.store.getItem(QUEUE_KEY) ?? '[]') as QueuedAction[];
    } catch {
      return [];
    }
  }

  private save(items: QueuedAction[]): void {
    this.store.setItem(QUEUE_KEY, JSON.stringify(items));
  }

  add(action: Omit<QueuedAction, 'id' | 'createdAt'>): QueuedAction {
    const item = { ...action, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.save([...this.list(), item]);
    return item;
  }

  pendingFor(checkId: string): QueuedAction[] {
    return this.list().filter((a) => a.checkId === checkId);
  }

  /** Drops a failed action the waiter has seen (the server refused it). */
  dismiss(id: string): void {
    this.save(this.list().filter((a) => a.id !== id));
  }

  /**
   * Sends queued actions oldest first. Stops at the first one that cannot reach
   * the server; an action the server refuses is kept with its error, and later
   * actions for the same check wait behind it so they are not applied out of order.
   */
  flush(send: Sender): Promise<FlushResult> {
    if (!this.flushing) {
      this.flushing = this.run(send).finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async run(send: Sender): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, failed: 0, offline: false };
    const blocked = new Set<string>();
    for (const action of this.list()) {
      if (action.error || blocked.has(action.checkId)) {
        blocked.add(action.checkId);
        continue;
      }
      try {
        await send(action);
        this.save(this.list().filter((a) => a.id !== action.id));
        result.sent++;
      } catch (err) {
        if (err instanceof OfflineError) {
          result.offline = true;
          break;
        }
        const message = err instanceof ApiError ? err.message : String(err);
        this.save(this.list().map((a) => (a.id === action.id ? { ...a, error: message } : a)));
        blocked.add(action.checkId);
        result.failed++;
      }
    }
    return result;
  }
}

export interface FlushResult {
  sent: number;
  failed: number;
  offline: boolean;
}
