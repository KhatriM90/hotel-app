import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { useAction } from './ui';

function Harness({ fn }: { fn: (ctx: { key: string; approval?: { username: string; password: string } }) => Promise<unknown> }) {
  const action = useAction();
  return (
    <div>
      {action.approvalFields}
      <p role="alert">{action.error}</p>
      <button onClick={() => action.run(fn)}>Go</button>
    </div>
  );
}

afterEach(cleanup);

describe('useAction (SEC-02 approvals)', () => {
  it('asks for a manager when the API needs approval, then sends the approval', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(403, 'A manager must approve this', 'approval_required'))
      .mockResolvedValueOnce({ ok: true });
    render(<Harness fn={fn} />);
    fireEvent.click(screen.getByText('Go'));
    await screen.findByText('Manager approval');
    expect(screen.getByRole('alert').textContent).toBe('A manager must approve this');
    expect(fn.mock.calls[0][0].approval).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Approver username'), { target: { value: 'k1.manager' } });
    fireEvent.change(screen.getByLabelText('Approver password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('Go'));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(fn.mock.calls[1][0].approval).toEqual({ username: 'k1.manager', password: 'secret' });
    await waitFor(() => expect(screen.queryByText('Manager approval')).toBeNull());
  });

  it('keeps the same idempotency key when a request fails on the network, so a retry cannot double-post', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce({ ok: true });
    render(<Harness fn={fn} />);
    fireEvent.click(screen.getByText('Go'));
    await screen.findByText('Failed to fetch');
    fireEvent.click(screen.getByText('Go'));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(fn.mock.calls[1][0].key).toBe(fn.mock.calls[0][0].key);
  });
});
