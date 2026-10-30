/**
 * YeaStay Rewards at the till (LOY11, LOY13, LOY15, LOY16, LOY22, CLUB02).
 * Find or enrol a member, show what the bill earns and what they can use,
 * verify the member (OTP or card) and redeem points or wallet credit. The
 * server prices every reward; the tablet only shows its answer.
 */
import { api, ApiError, newKey } from './api';
import { esc, kes, modal, toast } from './ui';

export interface MemberHit {
  id: string;
  number: string;
  name: string;
  phone: string | null;
  status: string;
  staffFlagged: boolean;
  cardScanned: boolean;
  points: { available: string; value: string };
  wallet: { available: string; pendingCashback: string };
  club: { tier: string; discountPercent: string; cashbackPercent: string } | null;
}

export interface Preview {
  member: { id: string; number: string; name: string; staffFlagged: boolean } | null;
  club: { tier: string; discountPercent: string; cashbackPercent: string; benefit: 'discount' | 'cashback' } | null;
  settings: { stacking: boolean; pointValue: string; redeemCapPercent: string; otpDelivery: string };
  balances?: { points: { available: string; reserved: string; deficit: string }; wallet: { available: string; reserved: string; deficit: string } };
  eligible?: { beforeRewards: string; forRewards: string; afterRewards: string };
  memberDiscount?: string;
  redeem?: { maxPoints: number; maxPointsValue: string; maxWallet: string; blocked: string[]; ceiling: null | { percent: string; billRoom: string; monthRoom: string } };
  applied?: { points: number; wallet: string; rewardAmount: string };
  earnPreview?: { points: number; cashback: string; note: string | null };
}

const pts = (v: string | number) => Number(v).toLocaleString('en-KE');

/** The rewards strip in the order panel. */
export function loyaltyHtml(p: Preview | null, open: boolean, offline: boolean): string {
  if (!p?.member) {
    if (!open) return '';
    return `<div class="loy"><button class="loy-add" data-act="member" ${offline ? 'disabled' : ''}>☆ Add YeaStay Rewards member</button></div>`;
  }
  const m = p.member;
  const b = p.balances!;
  const applied = p.applied!;
  const r = p.redeem!;
  const earn = p.earnPreview!;
  const canRedeem = open && !offline && (r.maxPoints > 0 || Number(r.maxWallet) > 0);
  const switchable = open && !offline && p.club && !p.settings.stacking;
  return `<div class="loy on">
    <div class="loy-head">
      <span><b>★ ${esc(m.name)}</b> <small>${esc(m.number)}</small>${p.club ? ` <span class="loy-tier">${esc(p.club.tier)}</span>` : ''}${m.staffFlagged ? ' <span class="loy-tier staff">Staff</span>' : ''}</span>
      ${open ? `<button class="link" data-act="member" ${offline ? 'disabled' : ''}>Change</button>` : ''}
    </div>
    <div class="loy-bal">${pts(b.points.available)} pts${Number(b.points.reserved) ? ` (${pts(b.points.reserved)} held for this bill)` : ''}${Number(b.wallet.available) ? ` · Wallet KSh ${kes(b.wallet.available)}${Number(b.wallet.reserved) ? ` (KSh ${kes(b.wallet.reserved)} held)` : ''}` : ''}</div>
    ${switchable
      ? `<div class="loy-switch" role="group" aria-label="Club benefit on this bill">
          <button class="${p.club!.benefit === 'discount' ? 'on' : ''}" data-benefit="discount">${Number(p.club!.discountPercent)}% off now</button>
          <button class="${p.club!.benefit === 'cashback' ? 'on' : ''}" data-benefit="cashback">${Number(p.club!.cashbackPercent)}% cashback</button>
        </div>`
      : ''}
    ${Number(applied.rewardAmount) ? `<div class="loy-used">Using ${applied.points ? `${pts(applied.points)} pts` : ''}${applied.points && Number(applied.wallet) ? ' + ' : ''}${Number(applied.wallet) ? `KSh ${kes(applied.wallet)} credit` : ''} = KSh ${kes(applied.rewardAmount)} off
      ${open ? `<button class="link" data-act="unredeem" ${offline ? 'disabled' : ''}>Remove</button>` : ''}</div>` : ''}
    <div class="loy-earn">${earn.points ? `Earns <b>${pts(earn.points)} pts</b> on this bill` : Number(earn.cashback) ? `Earns <b>KSh ${kes(earn.cashback)}</b> cashback (credited at month end)` : esc(earn.note ?? 'Nothing to earn yet')}</div>
    ${r.blocked.map((x) => `<p class="loy-warn">${esc(x)}</p>`).join('')}
    ${open && !Number(applied.rewardAmount) ? `<button class="loy-redeem" data-act="redeem" ${canRedeem ? '' : 'disabled'}>${canRedeem ? `Use ${r.maxPoints ? `up to ${pts(r.maxPoints)} pts` : ''}${r.maxPoints && Number(r.maxWallet) ? ' / ' : ''}${Number(r.maxWallet) ? `KSh ${kes(r.maxWallet)} credit` : ''}` : 'Nothing to use on this bill'}</button>` : ''}
  </div>`;
}

/**
 * Opens the camera and reads a QR code with the browser's BarcodeDetector.
 * Resolves with the text, or null when cancelled or not supported (staff can
 * also type the number or use a USB scanner, which types into the field).
 */
export async function scanQr(): Promise<string | null> {
  const Detector = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    toast('This tablet cannot scan with the camera; type the member number or phone instead', 'info');
    return null;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    toast('Camera not available', 'error');
    return null;
  }
  const detector = new Detector({ formats: ['qr_code'] });
  let found: string | null = null;
  let stop = false;
  const done = modal('Scan member card', '<video class="scan" playsinline muted></video><p class="muted">Hold the card QR code up to the camera.</p>', {
    submit: '',
    onMount: (root) => {
      const video = root.querySelector('video')!;
      video.srcObject = stream;
      void video.play();
      const tick = async () => {
        if (stop) return;
        try {
          const codes = await detector.detect(video);
          if (codes[0]?.rawValue) {
            found = codes[0].rawValue;
            (root.querySelector('[data-cancel]') as HTMLButtonElement | null)?.click();
            return;
          }
        } catch {
          /* frame not ready */
        }
        setTimeout(() => void tick(), 250);
      };
      void tick();
    },
  });
  await done;
  stop = true;
  stream.getTracks().forEach((t) => t.stop());
  return found;
}

/**
 * Finds the member for a bill: lookup by number, phone or card, pick one if
 * several share a phone, or enrol on the spot. Returns the member and, when
 * the card was scanned, the raw QR so the caller can verify it for redemption.
 */
export async function findMember(base: string, outletCode: string): Promise<{ member: MemberHit; qr: string | null } | 'remove' | null> {
  for (;;) {
    let scanned: string | null = null;
    const res = await modal(
      'YeaStay Rewards member',
      `<label>Member number, phone or card<input name="q" autocomplete="off" placeholder="YS000123 or 0712 345 678" minlength="3"></label>
       <div class="row"><button type="button" class="ghost" data-scan>Scan card with camera</button><button type="button" class="ghost" data-enrol>Enrol new member</button><button type="button" class="ghost" data-remove>Remove from bill</button></div>`,
      {
        submit: 'Find',
        onMount: (root) => {
          const input = root.querySelector<HTMLInputElement>('[name=q]')!;
          root.querySelector('[data-scan]')!.addEventListener('click', async () => {
            scanned = await scanQr();
            if (scanned) {
              input.value = scanned;
              (root as HTMLFormElement).requestSubmit();
            }
          });
          root.querySelector('[data-enrol]')!.addEventListener('click', () => {
            input.value = '__enrol__';
            input.removeAttribute('minlength');
            (root as HTMLFormElement).requestSubmit();
          });
          root.querySelector('[data-remove]')!.addEventListener('click', () => {
            input.value = '__remove__';
            input.removeAttribute('minlength');
            (root as HTMLFormElement).requestSubmit();
          });
        },
      },
    );
    if (!res) return null;
    if (res.q === '__remove__') return 'remove';
    if (res.q === '__enrol__') {
      const m = await enrol(base, outletCode);
      if (m) return { member: m, qr: null };
      continue;
    }
    const term = res.q.trim();
    if (term.length < 3) continue;
    const hits = await api.get<MemberHit[]>(`${base}/members?q=${encodeURIComponent(term)}`);
    const active = hits.filter((h) => h.status === 'active');
    if (!active.length) {
      const again = await modal('No member found', `<p>No active member matches <b>${esc(term)}</b>.</p>`, { submit: 'Enrol them now' });
      if (!again) continue;
      const m = await enrol(base, outletCode, /^\+?[\d ]{9,}$/.test(term) ? term : '');
      if (m) return { member: m, qr: null };
      continue;
    }
    const qr = active[0].cardScanned ? term : null;
    if (active.length === 1) return { member: active[0], qr };
    const pick = await modal(
      'Which member?',
      active
        .map((h, i) => `<label class="radio"><input type="radio" name="id" value="${esc(h.id)}" ${i === 0 ? 'checked' : ''}> ${esc(h.name)} · ${esc(h.number)} · ${pts(h.points.available)} pts</label>`)
        .join(''),
      { submit: 'Use this member' },
    );
    if (!pick) continue;
    return { member: active.find((h) => h.id === pick.id)!, qr: null };
  }
}

/** Quick enrolment at the till (LOY11): consent and age confirmation are required. */
async function enrol(base: string, outletCode: string, phone = ''): Promise<MemberHit | null> {
  const form = (v: Record<string, string> = {}) =>
    `<div class="row"><label>First name<input name="firstName" required maxlength="60" value="${esc(v.firstName ?? '')}"></label>
       <label>Last name<input name="lastName" required maxlength="60" value="${esc(v.lastName ?? '')}"></label></div>
     <label>Mobile phone<input name="phone" required inputmode="tel" value="${esc(v.phone ?? phone)}" placeholder="+254 712 345 678"></label>
     <label>Email (optional)<input name="email" type="email" maxlength="120" value="${esc(v.email ?? '')}"></label>
     <label class="check"><input type="checkbox" name="adult" required> The guest confirms they are 18 or over</label>
     <label class="check"><input type="checkbox" name="terms" required> The guest accepts the YeaStay Rewards terms</label>
     <label class="check"><input type="checkbox" name="marketing"> The guest agrees to receive offers</label>`;
  let values: Record<string, string> = {};
  let confirmNotDuplicate = false;
  const key = newKey('enrol');
  for (;;) {
    const res = await modal(confirmNotDuplicate ? 'Enrol: confirm different person' : 'Enrol in YeaStay Rewards', form(values), { submit: 'Enrol' });
    if (!res) return null;
    values = res;
    try {
      const m = await api.post<{ id: string }>(
        `${base}/members`,
        {
          firstName: res.firstName, lastName: res.lastName, phone: res.phone, email: res.email || null,
          adultConfirmed: res.adult === 'on', programmeAccepted: res.terms === 'on', marketingConsent: res.marketing === 'on',
          channel: 'pos', outletCode, confirmNotDuplicate,
        },
        confirmNotDuplicate ? `${key}-confirmed` : key,
      );
      const full = await api.get<MemberHit>(`${base}/members/${m.id}`);
      toast(`Welcome to YeaStay Rewards: ${full.number}`, 'ok');
      return full;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') {
        const go = await modal('Possible duplicate', `<p>${esc(err.message)}</p>`, { submit: 'It is a different person' });
        if (!go) return null;
        confirmNotDuplicate = true;
        continue;
      }
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}

/**
 * Verifies the member before using their balance (LOY22): the scanned card
 * counts; otherwise an OTP to the registered phone. With no SMS gateway yet
 * the demo shows the code on screen and says so.
 */
export async function verifyMember(base: string, memberId: string, checkId: string, qr: string | null): Promise<string | null> {
  if (qr) {
    try {
      const v = await api.post<{ verificationId: string }>(`${base}/members/${memberId}/verify-card`, { qr, checkId });
      return v.verificationId;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }
  const choice = await modal(
    'Confirm it is the member',
    `<p>Before using points or credit, the member confirms with a one-time code sent to their phone, or by showing their card.</p>
     <input type="hidden" name="method" value="otp">
     <button type="button" class="ghost" data-card>Scan their card instead</button>`,
    {
      submit: 'Send code',
      onMount: (root) => {
        root.querySelector('[data-card]')!.addEventListener('click', () => {
          root.querySelector<HTMLInputElement>('[name=method]')!.value = 'card';
          (root as HTMLFormElement).requestSubmit();
        });
      },
    },
  );
  if (!choice) return null;
  if (choice.method === 'card') {
    const scanned = await scanQr();
    return scanned ? verifyMember(base, memberId, checkId, scanned) : null;
  }
  return otp(base, memberId, checkId);
}

async function otp(base: string, memberId: string, checkId: string): Promise<string | null> {
  const sent = await api.post<{ verificationId: string; sentTo: string | null; demoCode?: string }>(`${base}/members/${memberId}/otp`, { purpose: 'redeem', checkId });
  let note = `Code sent to ${esc(sent.sentTo ?? 'the registered phone')}.`;
  if (sent.demoCode) note += ` <span class="demo">Demo, no SMS gateway yet: the code is <b>${esc(sent.demoCode)}</b></span>`;
  for (;;) {
    const res = await modal('Enter the code', `<p>${note}</p><label>Code<input name="code" inputmode="numeric" pattern="\\d{4,8}" required autocomplete="one-time-code"></label>`, { submit: 'Verify' });
    if (!res) return null;
    const v = await api.post<{ verificationId: string; verified: boolean; attemptsLeft?: number }>(`${base}/verifications/${sent.verificationId}/verify`, { code: res.code });
    if (v.verified) return v.verificationId;
    if (!v.attemptsLeft || v.attemptsLeft <= 0) {
      toast('Too many wrong codes. Ask for a new one.', 'error');
      return null;
    }
    note = `Wrong code. ${v.attemptsLeft} attempt(s) left.`;
  }
}

/** Asks how many points and how much credit to use, within the server's limits. */
export async function askRedeem(p: Preview): Promise<{ points: number; wallet: string } | null> {
  const r = p.redeem!;
  const res = await modal(
    'Use points or credit',
    `${r.maxPoints ? `<label>Points (up to ${pts(r.maxPoints)}, worth KSh ${kes(r.maxPointsValue)})<input name="points" type="number" min="0" max="${r.maxPoints}" step="1" value="${r.maxPoints}"></label>` : ''}
     ${Number(r.maxWallet) ? `<label>Wallet credit, KSh (up to ${kes(r.maxWallet)})<input name="wallet" inputmode="decimal" pattern="\\d+(\\.\\d{1,2})?" value="${esc(r.maxWallet)}"></label>` : ''}
     ${r.ceiling ? `<p class="muted">Benefits ceiling (${Number(r.ceiling.percent)}% of the bill): KSh ${kes(Number(r.ceiling.billRoom) < Number(r.ceiling.monthRoom) ? r.ceiling.billRoom : r.ceiling.monthRoom)} left, including tax.</p>` : ''}
     <p class="muted">Points cover at most ${Number(p.settings.redeemCapPercent)}% of the eligible food and drinks (KSh ${kes(p.eligible?.forRewards)} before tax). Rewards reduce the bill before VAT and levy.</p>`,
    { submit: 'Next: verify member' },
  );
  if (!res) return null;
  const points = Math.max(0, Math.floor(Number(res.points ?? 0)));
  const wallet = res.wallet && Number(res.wallet) > 0 ? Number(res.wallet).toFixed(2) : '0.00';
  if (!points && !Number(wallet)) return null;
  return { points, wallet };
}
