# How to test: reservations, front desk and basic folio

This checklist covers the module built in this PR: RES-01 to RES-08, FD-01 to FD-08, BIL-01, BIL-06 and BIL-09. It walks through the four acceptance tests from brief §10 that this module must pass (AT-01, AT-05, AT-08, AT-18) and then a shorter pass over each requirement.

Every acceptance test below also runs automatically in `apps/api/test/frontoffice.e2e-spec.ts`, so `npm test` must be green before anyone tests by hand.

## Before you start

1. Migrate and seed a database (see the README, "Run locally"). The seed is safe to run again.
2. Open the back office (`http://localhost:5173` locally, or the dev or test domain).
3. Every seeded user has the password you gave as `SEED_PASSWORD`.

| User | Role | Property | Use it for |
|---|---|---|---|
| `k1.reception` | Receptionist | K1 Klubhouse | Bookings, check-in, folio, checkout |
| `k1.manager` | Manager | K1 Klubhouse | Approvals (rate override, fee waiver, reversal, credit transfer, room not ready) and closing the day |
| `k1.cashier` | Cashier | K1 Klubhouse | Payments only (cannot book or check in) |
| `sw.reception`, `sw.manager` | Receptionist, manager | Small World | Small World tests |
| `km.reception`, `km.manager` | Receptionist, manager | Kahama | Isolation test (AT-18) |
| `group.accounts` | Group accounts | All three | Sees every property |
| `owner` | Owner | All three | Everything |

**Seeded test data**

| Property | Rooms | Room types and rack rates (weekday / weekend, KES) | Other rates | Policy |
|---|---|---|---|---|
| K1 Klubhouse | 13: 101–107, 201–206 | STD 6,500 / 7,000 · DLX 8,500 / 9,000 · STE 12,000 / 13,000 | CORPACME (Acme Logistics): STD 5,500, DLX 7,500 | Deposit 1 night, free cancellation to 24 h, early check-in 2,000, late check-out 2,500 |
| Small World | 42: 101–118, 119–130, C1–C12 | STD, TWN, FAM (cottages C1–C8), EXE (C9–C12), festive season 20 Dec to 4 Jan | | Deposit 50%, free cancellation to 72 h |
| Kahama | 32: 101–120, 201–212 | STD, TWN, DLX, JST, with high seasons | AGENTSAV (Savannah Tours) | Deposit 30%, free cancellation to 7 days |

The exact prices are on **Rates and policy** for each property. Weekend means Friday and Saturday nights. There are 6 seeded guests (for example James Mwangi of Acme Logistics) and two companies (Acme Logistics, and Savannah Tours & Travel as a travel agent).

**Closing the day moves the business date forward for the whole property.** Steps that close the day (AT-01) are best run on the test stack, or on a database you can re-seed. The business date is shown in the header.

---

## AT-01 Full stay

> Book two nights, take deposit, add meals/drinks/laundry, settle with two tenders. Charges total 16,500; deposit 5,000; settlement 11,500; balance zero.

Sign in as `k1.reception`, property K1 Klubhouse.

- [ ] **Book.** Go to **Reservations**, then **New booking**. Set arrival to today's business date and departure two days later. Source: Email. Guest: search "Mwangi" and pick James Mwangi. Company: Acme Logistics Ltd. Room type: STD. Rate plan: CORPACME. 1 adult. The price line shows 5,500 per night and **Total KES 11,000.00**. Click **Create booking**.
  - Expect: booking `K1-BK-…`, stay `K1-ST-…`, folio `K1-FO-…`, status Confirmed, and a deposit of 5,500 required (1 night).
- [ ] **Deposit.** Click **Folio**, then **Take payment** (the dialog is titled "Take a deposit" before arrival). Tender M-PESA, amount 5,000, any reference such as `QAT01TEST`. Click **Record payment**.
  - Expect: a payment marked "(deposit)", Confirmed, with receipt `K1-RCT-…`. The receipt opens as a printable page. The booking shows 500 of the deposit still outstanding.
- [ ] **Check in.** Back on the booking, click **Check in**. Enter a national ID number. Leave "Outlets may charge to this room" ticked. Click **Check in**.
- [ ] **Charges.** On the folio, use **Post charge** three times:
  - Food, outlet Klub Koffee, description Dinner, quantity 2, unit price 1,250.
  - Beverage, outlet Cocktail Bar, description Drinks, quantity 1, unit price 1,500.
  - Laundry, outlet Laundry, quantity 1, unit price 1,500.
  - Expect: each line shows the outlet, quantity, amount and the tax included. The tax line under the table shows VAT 16% and the catering levy 2% as separate lines.
- [ ] **Two nights pass.** Sign in as `k1.manager`. On **Front desk**, click **Close day** and confirm. Do this twice.
  - Expect: each close posts one room night (5,500) to the folio. The header date moves forward by one day each time. Closing the same date twice is refused.
- [ ] **Preview.** Open the folio again. Click **Print statement**.
  - Expect: Charges **16,500.00**, Paid **5,000.00**, Balance **11,500.00**. There are two accommodation lines, one per night.
- [ ] **Settle with two tenders.** Click **Check out**. The dialog says **To settle: KES 11,500.00**. Set the first tender to Cash 8,000. Click **+ Add tender**, then choose Card for 3,500 with an authorisation reference. Click **Settle and check out**.
  - Expect: the invoice `K1-INV-…` opens, totalling 16,500.00 and naming Acme Logistics Ltd. The folio is Closed, its balance is 0.00, and it shows three receipts. The stay is Checked out. On **Rooms**, room 102 (or whichever room was used) is now Dirty.
- [ ] **Frozen.** Try **Post charge** or **Take payment** on the closed folio. The buttons are gone, and the API refuses with "closed" if called directly.

## AT-05 Room move

> Move a guest from 101 to 205. All prior charges remain on the same stay; a new occupant of 101 inherits none.

Sign in as `k1.reception`. On **Rooms**, make sure 101 and 205 are Clean.

- [ ] Create a booking arriving today for 3 nights: STD, RACK, 1 adult. On the booking, room should be 101. If it is not, use **Amend** and choose room 101, or pick 101 in the check-in dialog.
- [ ] **Check in** to room 101. On the folio, post a Beverage (2 × 450) and Laundry (600).
- [ ] On the booking, click **Move room**. Choose 205 and give the reason "Upgrade: AC fault in 101". Click **Move guest**.
  - Expect: the stay number and folio number are unchanged. The room is now 205. The folio still shows both charges and the balance is unchanged. Room 101 is Dirty on **Rooms**. The availability calendar shows the guest in 205 from today.
  - Moving to a room that is not Clean or Inspected asks for a manager's approval.
- [ ] Mark 101 Clean on **Rooms**, then book and check in a second guest into 101.
  - Expect: the new folio is empty. Nothing from the first guest appears.
- [ ] The move is refused on the departure day, because checkout is the right action then.

## AT-08 Double-book race

> Two reception users request the last room for overlapping dates. At most one booking succeeds.

The server enforces this with a database exclusion constraint on room allocations, so it cannot be beaten by timing.

**By hand (two browsers).**

- [ ] Pick dates about two months out. As `k1.reception`, book one of K1's two suites (STE) for 3 nights. The calendar now shows STE with 1 of 2 free on those dates.
- [ ] Open a second browser (or a private window) as `k1.manager`. In both windows fill a New booking for STE with overlapping dates. Click **Create booking** in both windows at about the same time.
  - Expect: one succeeds. The other shows "No Executive Suite is free from … to …". The calendar shows both suites taken and nothing double-booked.

**Truly simultaneous (terminal).** This fires 6 requests for the same room at once:

```bash
API=http://localhost:3000/api   # or https://<test-domain>/api
TOKEN=$(curl -s $API/auth/login -H 'content-type: application/json' \
  -d '{"username":"k1.reception","password":"<SEED_PASSWORD>"}' | jq -r .accessToken)
ROOM=$(curl -s $API/properties/K1/rooms -H "authorization: Bearer $TOKEN" | jq -r '.[] | select(.number=="103") | .id')
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" $API/properties/K1/reservations \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "Idempotency-Key: race-$i-$RANDOM" \
    -d "{\"source\":\"phone\",\"guest\":{\"firstName\":\"Race\",\"lastName\":\"Test$i\"},\"arrival\":\"2027-03-10\",\"departure\":\"2027-03-12\",\"rooms\":[{\"roomTypeCode\":\"STD\",\"ratePlanCode\":\"RACK\",\"adults\":1,\"roomId\":\"$ROOM\"}]}" &
done; wait
```

- [ ] Expect exactly one `201` and five `409`. Change the dates when you rerun it.
- [ ] **Holds expire.** Create a booking with status "Provisional hold" and a hold of 5 minutes. After it expires, the booking returns to Enquiry and the room is free again (the dashboard and calendar release expired holds when they load; the background job also releases them every minute when Redis is configured).

## AT-18 Property isolation

> A Kahama receptionist cannot view or post K1 Klubhouse data; group accounts can see all three.

- [ ] Sign in as `km.reception`. The property picker lists only Kahama Mombasa. Front desk, reservations, rooms and folios show only Kahama data.
- [ ] Note a K1 booking id (from the browser address bar or the API) and, as `km.reception`, call `GET /api/properties/K1/reservations/<id>` and `GET /api/properties/KM/reservations/<id>`.
  - Expect: 403 on the K1 route and 404 on the Kahama route. The same goes for folios, payments and check-in.
- [ ] Open a guest who stayed at K1 (for example James Mwangi, after AT-01) as `km.reception` on **Guests**. Guest profiles are shared across the group (CFG-05), but the stay history shows only Kahama stays. The K1 stay is not listed.
- [ ] Sign in as `group.accounts`. The picker lists all three properties, and each shows its own bookings and folios.
- [ ] Booking, stay, folio, invoice and receipt numbers carry the property prefix (`K1-`, `SW-`, `KM-`), and each property's sequence runs on its own.
- [ ] Consolidated reports are not part of this module, so the "sum of property reports" part of AT-18 is still open.

---

## Requirement checklist

| ID | What to try | Pass when |
|---|---|---|
| RES-01 | **Availability**: switch between Day, Week and Month; use ‹ and ›. Block a room on **Rooms**. | Rooms by type, free counts per type and arrivals/departures per day are shown. Holds, reservations, in-house guests and blocks have distinct colours. Clicking a free cell starts a booking. |
| RES-02 | New booking with each source. Add an agent with a reference, notes and a company. | The booking number is the confirmation reference. Source, agent, reference and notes show on the booking. |
| RES-03 | Create an Enquiry, then **Hold room**, then **Confirm**. Let a hold expire. Try to check in an enquiry via the API. | Allowed steps work. Disallowed steps are refused with "invalid transition". An expired hold returns to Enquiry. |
| RES-04 | AT-08 above. Amend a booking onto dates where the room is taken. | Refused with a clear reason. |
| RES-05 | Book a K1 STD over a Friday night, a Small World stay over 24 Dec, and the Acme rate. Add a new price on **Rates and policy** as `k1.manager`, then open an existing booking. | Weekend, season and negotiated prices apply per night. The existing booking keeps its agreed price. Prices are added, never edited. |
| RES-06 | **Amend**: extend by a night, shorten, change adults, override the price. | Unchanged nights keep their price and new nights use current rates. The price difference is shown. **Changes** lists who made each change and who approved the override. |
| RES-07 | Book at each property and compare the deposit required. Cancel inside the free window, cancel late, and mark a no-show. Try **Waive**. | Deposits follow each property's policy, with a due date. Late cancellation and no-show post a fee to the folio. A waiver needs a manager. A deposit taken before arrival shows as "(deposit)". |
| RES-08 | Add 2 or 3 rooms to one booking with different room types. | One booking number. Each room has its own stay, guest, folio and actions, and can be cancelled on its own. |
| FD-01 | **Front desk** dashboard. | Arrivals, departures, in-house, overdue check-outs, outstanding balances and room readiness are shown. Arrivals whose room is not ready are flagged. |
| FD-02 | **Guests**: search, open, edit, add an ID. Click "Show full numbers". | Identity numbers are masked by default. Full numbers need the identity permission and each view is written to the audit log. Waiters and cashiers cannot see them. |
| FD-03 | Check in without an ID, then into a dirty room, then with a credit limit and room charges off. | Refused without an ID. A dirty room needs a manager. Occupants, room-charge flag and credit limit are saved. Deposits are applied. |
| FD-04 | **Registration card** on the booking. Record who signed in the check-in dialog. | A printable card with the property's terms, agreed rate and signature line. The acknowledgement is stored. |
| FD-05 | AT-05 above. | As above. |
| FD-06 | Early check-in (tick the box at check-in) and **Late check-out**, each with and without a waiver. Extend with **Amend**. | The policy fee posts to the folio. A waiver needs a manager. The revised departure time shows on the booking and the dashboard. |
| FD-07 | **Guest requests**: log a linen request for an occupied room. Assign an owner, add a note, and mark it Done. | Owner, status and handover notes are kept. Open requests are counted on the dashboard. |
| FD-08 | AT-01 checkout. Try checkout with a pending M-PESA payment and with a balance. Try **Transfer the balance to a company account**. | The folio preview and statement show everything due. Checkout is blocked while a payment is pending or a balance remains. A credit transfer needs a manager. The invoice is issued, the stay closes and the room becomes Dirty. |
| BIL-01 | Any folio. | Accommodation, food, drinks, laundry, minibar and other charges show with date, quantity, outlet, tax and reference. |
| BIL-06 | **Take payment** with split tenders. Tick "awaiting confirmation" for M-PESA, then **Confirm** or **Failed**. Reuse an M-PESA reference. | Partial and multiple payments work, each with its own receipt. Pending payments do not reduce the balance until they are confirmed. A reference cannot be used twice. |
| BIL-09 | **Pro forma** on a booking, **Print statement**, receipts, invoice. | Each has a unique property-prefixed number (`K1-PF-`, `K1-RCT-`, `K1-INV-`) and links back to its booking or folio. |
| SEC-02 (part) | As `k1.reception`, override a rate, waive a fee or **Reverse** a charge. | Approver fields appear. A receptionist cannot approve; `k1.manager` can. The approval is recorded with the change. |

## Known limits of this module

- **Close day is a basic stand-in for the night audit (BIL-10).** It posts room nights once per stay and date and moves the business date. It does not yet reconcile totals, flag unresolved transactions or lock the closed date against later changes.
- **Checkout does not post to SAP and does not submit to eTIMS** (SAP-04, INT-02). The invoice is the app's own document; fiscal submission comes with the eTIMS work.
- **No refunds or credit notes yet (BIL-07).** Overpayment blocks checkout with a clear message.
- **No split folios (BIL-05)** and **no open-POS-check warning (BIL-11)**. POS does not exist yet.
- **The tax mapping for cancellation and no-show fees is provisional** until the accountant confirms it (BIL-08).
