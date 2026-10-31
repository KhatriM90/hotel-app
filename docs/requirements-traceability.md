# Requirement traceability

Source of truth: *Hotel & Bar Web App Development Brief v1.2* (26 Oct 2026).
Covers the foundation PR (#1) and the reservations, front desk and folio PR. How to test the latter by hand: [how-to-test-reservations.md](how-to-test-reservations.md).
Status key: **Done** = satisfied for what exists today · **Partial** = foundation in place, feature work outstanding · **Not started**.

## Brief §9 non-negotiable rules

| Rule | Status | Where |
|---|---|---|
| Permanent stay/folio IDs | Done | `stays.number` and `folios.number` (`K1-ST-…`, `K1-FO-…`) are immutable columns (`app_immutable_columns`). A room move changes only the allocation; amendments never create a new stay (FD-05, AT-05). |
| Separate fulfilment, payment, posting and fiscal status | Partial | Pattern set: integration status lives in `integration_outbox`, not on source records; `app_guard_finalised()` only lets whitelisted status columns change. |
| Transactional local updates; durable pending events for external systems | Done (foundation) | `DbService.tx()`; `integration_outbox` written in the business transaction; worker never reports success it did not get. |
| Idempotency keys on POS postings, nightly charges, payment callbacks, fiscal submissions | Partial | `idempotency_keys` + `@Idempotent()` interceptor (same transaction, concurrent-safe); SAP `U_HTL_ExtRef` lookup-before-post. Applied to every reservation, check-in/out, charge, payment, reversal, document and close-day route (`frontoffice.controller.ts`). Room nights are unique per stay and date (`folio_charges (stay_id, room_night_date)`); payment references are unique per tender. |
| Decimal money, consistent rounding, snapshots | Partial | `money_amount`/`money_precise`/`rate`/`quantity` domains; `Money` class (decimal.js, half-up, allocation without lost cents). Rounding rule is provisional until the accountant signs off (BIL-08). Agreed nightly prices are stored per stay (`stay_nights`) and each charge keeps its own tax split (`folio_charge_taxes`). |
| Freeze stay for checkout (concurrency) | Done | Checkout locks property (shared), stay, then folio in a fixed order; charges take the same locks, so a charge either lands before settlement or is refused (AT-09 race tested). Closed stays are frozen by trigger (`app_stay_transition`). |
| Linked reversals, never edit/delete finalised records | Partial | `app_forbid_mutation()` (append-only) and `app_guard_finalised()` triggers, tested; attached to `audit_events`, `number_allocations`, `integration_outbox`, and now `folio_charges`, `folio_charge_taxes`, `rate_prices`, `documents`, `approvals` (append-only) and `folios` (finalised guard). Confirmed payments cannot change. A charge is cancelled only by a linked negative reversal. |
| Calendar timestamp vs business date | Partial | `properties.current_business_date` and `business_day_cutoff`; audit rows carry business date. |
| Guest balance definition | Done | `folio_balances` view: charges minus confirmed payments; pending payments shown separately and never reduce the balance; deposits count once taken. |
| POS revenue recorded once | Not started | POS/billing. |

## Requirement IDs: foundation PR

| ID | Status | Notes |
|---|---|---|
| CFG-01 | Partial | Property name, location, currency, timezone, business-day cut-off, contacts, branding JSON. No edit screen/API yet. |
| CFG-03 | Partial | The client's 43 SAP outlets are loaded (K1 19, SW 11, KM 13; migration `0007`) with type, revenue centre, alcohol flag and the verbatim SAP outlet name. Issuing warehouses, stations, tills and printer destinations not yet. |
| CFG-04 | Partial | Group → property → outlet; per-property business date; property-prefixed, gapless, group-unique numbers (`K1-INV-000123`). Per-property rates, taxes and night audit not yet. |
| CFG-05 | Partial | See the reservations PR table below. |
| SEC-01 | Done (data) | All named roles seeded, plus group roles. No user-management API yet. |
| SEC-02 | Partial | Server-side permission matrix (`packages/shared/src/roles.ts`). Approvals for rate overrides, fee waivers, charge reversals, credit transfers and room-not-ready are done (see below). Discounts, refunds, comps, stock adjustments and reopening days not yet. |
| SEC-03 | Partial | Server-side checks, scrypt passwords, JWT, deactivation effective immediately, HTTPS/HSTS via Caddy, secrets from env. **Admin MFA, token revocation/device logout and encryption at rest (EBS/RDS setting) are outstanding.** |
| SEC-04 | Partial | Append-only `audit_events` (actor, time, business date, record, previous/new values, reason, request id). Written for login, outlet creation, dead letters and replays. Restricted export and retention not yet. |
| SEC-06 | Done (foundation) | Postgres row-level security on every property-scoped table; API runs as non-superuser `hotel_app`; property routes narrow scope to one property. |
| BIL-04 | Partial | Idempotency and outbox status (pending/claimed/posted/failed/dead), retries with backoff. No postings exist yet. |
| BIL-07 | Partial | Database guards in place; linked charge reversals done (see below). Refunds and credit notes not yet. |
| BIL-09 | Done (this module) | See below. |
| INT-07 | Partial | Cloud outbox + HQ pull worker (outbound only) + Service Layer client + mock. |
| SAP-04 | Partial | A/R invoice mapping with branch, dimensions, UDFs; tax codes and item codes TBC from mapping workbook. |
| SAP-05 | Partial | Incoming payment mapping skeleton; invoice allocation not yet. |
| SAP-11 | Partial | Persistent queue, external unique IDs, lookup before retry, validation errors surfaced, authorised replay. Daily reconciliation not yet. |
| SAP-13 | Partial | Real BPLIds loaded: K1 = 1, SW = 4, KM = 3. Sent as `BPL_IDAssignedToInvoice`; worker refuses to post without one. Numbering series per branch not yet. |
| SAP-14 | Partial | The client's 51 SAP warehouses are loaded (`warehouses`, migration `0009`; SAP codes are numeric). Each outlet references at most one warehouse of its own property, enforced by a foreign key. 34 outlets are linked; 9 have no warehouse of their own (see below). |
| SAP-15 | Partial | Dimension 1 = property; Dimension 2 = the outlet's short code (`outlets.sap_dimension2_code`, max 8 characters, e.g. `K1COCKTL`), set per line. The 43 codes were proposed by us and approved by Manish; they must be created in SAP with the same values. |
| SAP-02 | Partial | Active SAP tax groups mirrored in `tax_codes` (I1, I2, I4, X1, C1, O1, O2, O4, X0) with rate and GL account. Items, units, price lists and warehouses not yet; no automatic sync yet. |
| INT-02 | Partial | Confirmed: one eTIMS registration for the group (KRA PIN P000598390N). `legal_entity.etims_branch_id` (default `00`, confirm against the device registration) and `next_fiscal_invoice_number()`: one gapless, append-only invoice sequence shared by all properties. Submission, OSCU/VSCU integration and credit-note links not yet. |
| SAP-20 | Done (worker) | `U_HTL_ExtRef`, `U_HTL_Property`, `U_HTL_FolioNo` sent; lookup before every attempt. UDFs must still be created in the SAP test company. `HTL_SYNCLOG` UDO not yet. |
| OPS-02 | Partial | Retry queue, duplicate protection, per-property outbox list in back office, replay endpoint. Alerts not yet. |
| OPS-03 | Partial | Back office is responsive with 44px touch targets and visible focus. |
| OPS-04 | Partial | PWA shows live connection status from the API health check and never caches API calls. |
| AT-03 | Partial | Duplicate requests and concurrent duplicates tested at API level. |
| AT-18 | Partial | See below. |
| SAP-AT04 | Done (against mock) | Commit-then-drop test: retry finds the existing document; exactly one invoice. |
| SAP-AT05 / AT12 | Partial (mock) | Outage is retryable; worker backs off and recovers. |
| SAP-AT06 | Partial (mock) | Rejected document dead-letters with SAP's message; authorised replay keeps the source event unchanged. |

## Requirement IDs: reservations, front desk and folio PR

Migrations `0010`–`0012`; API in `apps/api/src/frontoffice`; reception screens in `apps/backoffice/src/frontdesk`; tests in `apps/api/test/frontoffice.e2e-spec.ts` (37) and `packages/shared/src/frontdesk.test.ts` (13).

| ID | Status | Notes |
|---|---|---|
| RES-01 | Done | Availability calendar by room with day/week/month views, free count per room type per day, arrivals/departures per day; holds, reservations, in-house and maintenance blocks shown distinctly. Blocks are created/released on Rooms. |
| RES-02 | Done | Walk-in, phone, email, agent, website, other; dates, adults/children, room type, rate plan, source, agent and agent reference, company, notes. The booking number (`K1-BK-…`) is the confirmation reference. |
| RES-03 | Done | Enquiry → timed hold → confirmed → checked-in → checked-out, plus cancelled and no-show. Rules live in `stay_status_transitions` and a trigger, so the API cannot skip them; expired holds return to enquiry and free the room. |
| RES-04 | Done | Exclusion constraint on `room_allocations` (no overlapping live allocation per room) covers bookings, amendments, moves, blocks and holds. AT-08 tested with concurrent requests. |
| RES-05 | Done | Weekday/weekend (per plan), seasonal prices with priority and effective dates, extra-adult and child supplements, negotiated company/agent plans. Prices are append-only; each stay stores its agreed price per night. |
| RES-06 | Done | Extend, shorten, change dates, room type, rate plan, occupancy or room. Kept nights keep their price; the difference is returned and stored with who made it and who approved any override. |
| RES-07 | Done | Per-property policy (deposit type and value, due days, hold time, free-cancellation window, late-cancellation and no-show nights, refund text). Snapshot on each booking. Deposits tracked as received and then applied at check-in. Fees post to the folio; waivers need approval. **Refunds of deposits are not built (BIL-07).** Tax treatment of the fees is provisional (BIL-08). |
| RES-08 | Done | One booking, several rooms; each room is its own stay with its own guest, occupants, folio and lifecycle. |
| FD-01 | Done | Dashboard: arrivals (including late), departures, in-house, overdue check-outs, outstanding balances, room readiness by housekeeping status, arrivals whose room is not ready, open requests. |
| FD-02 | Done | Group-wide guest profiles with contacts, nationality, DOB, address, company, preferences, notes, marketing consent. Identity numbers masked everywhere; the full number needs `guest.identity` and every view is audited. Stay history is limited to the viewer's properties (see decisions). |
| FD-03 | Done | Check-in requires a valid identity document, a ready room (or manager approval), records occupants, room-charge permission and credit limit, applies deposits and the early check-in fee. |
| FD-04 | Done | Printable registration card with the property's terms, agreed rates and signature line; acknowledgement (paper, digital signature image, or staff-verified) stored on the stay. |
| FD-05 | Done | Room move changes the allocation only; stay, folio, charges and payments stay put; `room_moves` keeps the history; the old room becomes dirty. AT-05 tested. *Key history needs a door-lock integration, which the brief does not specify.* |
| FD-06 | Done | Early check-in and late check-out fees from policy, waivers with approval, revised departure time; extensions through amendment with availability checks. |
| FD-07 | Done | Guest requests (maintenance, linen, wake-up, housekeeping, transport, other) with owner, priority, due time, status and handover notes. |
| FD-08 | Partial | Folio preview and running statement; blocks while payments are pending; posts nights still due; settles by tenders or an approved company transfer; requires zero balance; issues the invoice; closes the folio and stay; marks the room dirty. Open POS checks now block checkout (BIL-11, POS PR). **SAP posting of the folio (SAP-04) and eTIMS submission (INT-02) are not done yet.** |
| BIL-01 | Done | One folio per stay for accommodation, food, drinks, laundry, minibar and other charges, with service date, quantity, unit price, discount, outlet, reference, and a per-charge tax split. |
| BIL-06 | Done | Deposits, partial payments, several payments, split tenders in one action, a receipt per payment; pending vs confirmed (confirm or fail); references unique per tender; balance = charges − confirmed payments. *Allocation across several folios arrives with split folios (BIL-05).* |
| BIL-09 | Done | Pro forma (`PF`), running statement, final invoice (`INV`) and receipts (`RCT`) with unique, property-prefixed, gapless numbers, stored immutably with links to their booking, stay, folio or payment, and printable. Credit notes arrive with BIL-07. |
| BIL-02 | Done | Server-side checks at posting: stay checked in, outlet belongs to the same property, room-charge flag, credit limit. POS room charges use the same checks (see the POS PR). |
| BIL-07 | Partial | Charge reversal is a linked negative line with reason and manager approval; one reversal per charge. Refunds and credit notes not yet. |
| BIL-10 | Partial | Basic close-day: posts each in-house stay's room night once (unique per stay and date) and advances the business date; refuses a stale date. Reconciliation, exception flags and closed-date locking not yet. |
| BIL-16 | Partial | Charges split VAT (O1, 16%) and catering levy (C1, 2%) as separate tax lines, configured per charge code. SAP/GL mapping arrives with posting. |
| BIL-17 | Done | Folios, charges and outlets are property-scoped by RLS; a charge from another property's outlet is refused. |
| SEC-02 | Partial | Approvals with a manager's username and password for rate overrides, fee waivers, charge reversals, credit transfers and room-not-ready; each stored in `approvals` and linked to the change. |
| CFG-02 | Done (data) | Room types (capacity, beds, amenities) and rooms (number, floor/building, sellable, active dates) for all three properties. No edit screens yet. |
| CFG-05 | Partial | Guest profiles and companies are group-wide. Room types and rate plans are per property; group-level definitions with per-property overrides are not built. |
| HK-01 | Partial | Rooms page shows and sets clean, dirty, inspected, in-progress next to occupancy and blocks; checkout and moves mark rooms dirty. The housekeeping phone app is not built. |
| AT-01 | Done | Two nights, deposit 5,000, food/drink/laundry, cash 8,000 + card 3,500, charges 16,500, balance zero (tested, and by hand per the checklist). |
| AT-04 | Partial | Manual charges to a checked-out stay, a stay with room charges off, or over the credit limit are refused with a reason (tested). Re-tested with POS room charges (POS PR). |
| AT-05 | Done | Move 101 → 205; charges stay on the stay; the next guest in 101 inherits none. |
| AT-08 | Done | Two receptionists race for the last suite, and six requests race for one room: exactly one succeeds. |
| AT-09 | Done (front desk) | A charge posted during checkout is either settled or refused; no balance appears afterwards. Re-tested with POS room charges (POS PR). |
| AT-18 | Partial | Kahama receptionist gets 403 on K1 routes and 404 for K1 ids on Kahama routes; guest stay history hides K1 stays; group accounts see all three. Consolidated reports not yet. |

### Decisions in this PR

- **Guest profiles are shared across properties; stay history is limited to the properties the viewer can access** (confirmed by Manish Khatri, 28 Oct 2026). A Kahama receptionist sees the profile but not the guest's K1 stays, to honour AT-18. Group users see everything.
- **Charge prices include VAT 16% and catering levy 2%** (confirmed by Manish Khatri, 28 Oct 2026). Each is calculated on the net amount; any rounding cent goes to the larger tax. Rounding is still to be signed off by the accountant (BIL-08).
- **Deposits before arrival are payments on the stay's folio**, flagged as deposits. They reduce the balance once confirmed and are marked as applied at check-in.
- **Checkout on the arrival day charges one night** (confirmed by Manish Khatri, 28 Oct 2026); leaving early on later days charges the nights up to today and shortens the stay.
- **Business day runs 08:00 to 08:00** for all three properties (confirmed by Manish Khatri, 28 Oct 2026; migration `0013`). Sales between midnight and 08:00 belong to the previous business date. POS day close and the full night audit (BIL-10) will use this cut-off.
- **Seeded rates, policies, room numbers and guests are test data** for this module, not the client's real tariff.

## Requirement IDs: point of sale PR

Migrations `0014`–`0015`; API in `apps/api/src/pos`; waiter, bar and kitchen tablets in `apps/pwa/src`; back-office POS screens in `apps/backoffice/src/pos`; sample menus in `apps/api/src/seed-pos.ts`; tests in `apps/api/test/pos.e2e-spec.ts` (29), `packages/shared/src/pos.test.ts` and `apps/pwa/src/queue.test.ts`. Manual checklist: `docs/how-to-test-pos.md`.

| ID | Status | Notes |
|---|---|---|
| POS-01 | Done | Tablet POS with search, category tabs, favourites and availability; tablet and desktop layouts. No item images yet (the brief says "if useful"). |
| POS-02 | Done | Group menu with categories, items, portions (tot/double/bottle, glass/bottle), modifier groups with min/max and price deltas, preparation notes and a charge code that carries the tax category. |
| POS-03 | Done | Prices per outlet and portion (append-only history); scheduled happy-hour rules by category, weekday and time; line or check discounts and comps with reasons. Discounts above the property's free limit, and every comp, need a manager (SEC-02). |
| POS-04 | Done | Table, counter, takeaway and room service per outlet; residents (room service, charge to room) and walk-in customers. |
| POS-05 | Done | Tables per outlet, covers, assigned waiter, open checks and named bar tabs; move a check to another table. |
| POS-06 | Done | Line states draft → sent → preparing → ready → served, plus cancelled and wasted; check states open → closed or voided. Every step is in an append-only check history. |
| POS-07 | Done | Food routes to the kitchen, drinks to the outlet's bar, per outlet. Tickets show table/room/tab, server, time, modifiers and notes. Reprints are numbered and say REPRINT; cancellations print a CANCEL ticket. Tickets print from the browser until the print bridge (INT-04) exists. |
| POS-08 | Done | Split by item or part quantity to a new check, merge open checks, move tables, split settlement across tenders, room charge and house account. Totals are unchanged to the cent. |
| POS-09 | Done | Lookup in-house guests by room or name with eligibility and available credit; posts itemised folio charges; shows the folio and reference, or the reason it was refused. |
| POS-10 | Done | Cash (with change), M-PESA, card, bank transfer and other; mixed tenders; pending payments confirmed or failed; printable bill and receipt; balance due kept. M-PESA is a typed reference until the Daraja integration (INT-01). Email receipts are not built. |
| POS-11 | Done | Pre-production cancellation (no approval), post-preparation waste, check void and refund are separate actions with reasons; sent items, voids and refunds need a manager; waiters can never refund. |
| POS-12 | Done | Per-outlet availability and optional daily portion counts; the outlet policy warns or blocks; disabled items cannot be sold, offline included. |
| POS-13 | Done | Cash shift with opening float, cash drops, paid in, paid out (manager), handover; blind count; expected vs counted; variance reviewed and signed by a manager. Cash payments need an open shift. |
| POS-17 | Done | Licensed hours per outlet and weekday (crossing midnight allowed); block or warn policy; a manager override with a reason is logged. Seeded hours are placeholders. |
| POS-18 | Done | Named house accounts (staff meals, directors, entertainment, other) with limits, cost centre and manager approval; reported apart from revenue and never sent to SAP as a sale. |
| POS-19 | Done | All 43 outlets have POS settings; each has its own price list, availability, routing, alcohol hours, stock policy and cut-off; copy one outlet's configuration to another, across properties for group users. |
| POS-14, 15, 16, 20 | Not started | Phase 2 (P2). The ticket screen covers the basics of POS-14: queues, age, ready, cancellation acknowledgement. |
| BIL-02 | Done | The room charge rechecks the stay, folio, room-charge flag and credit limit on the server, under the same locks as checkout. |
| BIL-03 | Done | Room charges need the guest's signature on the tablet or a staff-verified name; the method, name and signature are stored with the charge. A room number alone is never enough. |
| SEC-02 | Partial | POS approvals added: discounts over the free limit, comps, cancelling sent items, voids, refunds, cash paid-out, variance review, house-account charges and alcohol-hours overrides, each stored in `approvals`. Stock adjustments and reopening days not yet. |
| BIL-04 | Partial | Idempotency keys on every POS POST, unique payment references, pending/confirmed/failed payments. Exception reconciliation screen not yet. |
| BIL-11 | Done (POS) | Checkout is refused while the guest has an open POS check (`open_pos_checks`); a room charge racing checkout is either on the settled bill or refused. Pending SAP/eTIMS checks wait for those integrations. |
| BIL-12 | Done | A room charge is a folio charge (guest receivable), not a payment; the POS check is settled by transfer and the folio balance rises by the same amount. |
| OPS-05 | Partial | The tablet keeps the menu and queues new checks, items, sends and holds with device ids and stable idempotency keys; payments and room charges are never queued. On reconnect the queue replays once; a refused action blocks that check and is shown. Tickets need the server, so LAN printing while offline needs the print bridge (INT-04). |
| CFG-01, CFG-03 | Partial | Business-day cut-off per property with an optional per-outlet override (default 08:00), discount limit, service types, routing, alcohol hours and stock policy, each change audited. |
| SAP-04, SAP-05 | Partial (mock) | Checks settled by payment queue an A/R invoice and incoming payment (`C-WALKIN`, item `POS-<charge code>`, outlet dimension and warehouse). On a mixed check only the paid share goes now; the room share goes with the folio. No credit memo for refunds yet. |
| AT-02 | Done | A paid restaurant bill goes to SAP and never to a folio. |
| AT-03 | Done | A replayed payment or room-charge request records once; a reused M-PESA reference is refused. |
| AT-07 | Done | Bill split into M-PESA and room charge: only the unpaid part moves to the folio, itemised; SAP gets only the paid share; the sales report reconciles to zero. |
| AT-09 | Done | A room charge racing checkout lands on the settled bill or is refused (tested with concurrent requests). |
| AT-10 | Partial | Cancel unprepared (no approval), waste prepared, refund with approval; all visible on the check. Stock deduction in SAP waits for SAP-18. |
| AT-13 | Done | Float, cash sales and approved paid-out give the expected count; a short count creates a variance for review. |
| AT-14 | Partial (POS) | Waiters cannot refund; a cashier refunds with a manager. Backup restore is not tested here. |
| AT-17 | Partial | Orders keep being taken offline and sync once; room charges and payments wait. Ticket printing while offline needs INT-04. |
| AT-18 | Done (POS) | Kahama staff cannot see or sell at K1 outlets. |

### Decisions in this PR

- **Business day cut-off is per property with an optional per-outlet override** (Manish Khatri, 28 Oct 2026). Default 08:00. A change applies from the next trading day.
- **POS day close is a manual manager action per outlet** (Manish Khatri, 28 Oct 2026). It refuses while checks are open, stores the Z report and freezes it. The property's business-day close refuses while an outlet day with sales is still open; empty outlet days close themselves.
- **Room-charged sales are invoiced in SAP with the folio**, not from the POS, so a sale is invoiced once. Paid sales, and the paid share of a mixed check, are invoiced from the POS when the check closes.
- **Cash shifts belong to the cashier, not the till.** A cashier has one open shift per property, opened at one outlet, and it takes their cash at any outlet of that property. To be confirmed with the client's cashiers.
- **Seeded menus, prices, alcohol hours, house-account limits and happy hour are test data** until the client sends theirs.

### Gaps carried forward from this PR

- eTIMS fiscal receipts (INT-02); receipts say "eTIMS receipt not yet issued".
- M-PESA STK push and C2B confirmation (INT-01); card terminals (INT-03).
- Print bridge for LAN ticket and receipt printers (INT-04).
- SAP credit memo for POS refunds; SAP till and M-PESA clearing accounts per property (SAP-16); the walk-in customer code.
- Stock deduction and recipes in SAP (SAP-18).

## Requirement IDs: loyalty and club PR (Loyalty Addendum v1.2)

The Loyalty Development Addendum v1.2 amends the brief and **replaces ADV-02**. This PR builds core loyalty (LOY01, LOY05, LOY11 to LOY28) and club membership (CLUB01 to CLUB07). The advanced options LOY02 to LOY10 come later.

Migration `0016`; API in `apps/api/src/loyalty`, with hooks in POS checkout, POS returns, folio settlement and the maintenance tick; tablet screens in `apps/pwa/src/loyalty.ts`; back-office screens in `apps/backoffice/src/loyalty`; SAP journal mapping in `apps/sap-worker/src/mapping.ts`; demo members in `apps/api/src/demo/loyalty-demo.ts`; tests in `apps/api/test/loyalty.e2e-spec.ts` (19) and `packages/shared/src/loyalty.test.ts` (16). Manual checklist and customer demo script: `docs/how-to-test-loyalty.md`.

| ID | Status | Notes |
|---|---|---|
| ADV-02 | Replaced | By the addendum (LOY and CLUB below). |
| LOY01 | Done | 1 point per KES 100 eligible, 1 point = KES 1, minimum redemption 100, 20% redemption cap, all configurable as dated programme versions. |
| LOY02–LOY10 | Not started | Advanced options, later release. |
| LOY05 | Done (core) | Excluded charge codes, menu categories and items, participating outlets, alcohol on/off for rewards. Per-category earning rates are advanced (later). |
| LOY11 | Done | Enrol at reception or at the till; one member per phone, with a duplicate warning; corporate members linked to a company. |
| LOY12 | Done | Points = floor(eligible / unit) once per earning event, on the net amount (excluding VAT and levy); line allocations stored for returns; daily earning cap. |
| LOY13 | Done | Redeem on an open bill with a 15-minute hold, committed when the bill closes and released on void, removal or expiry; capped and verified. |
| LOY14 | Done | Points expire after 12 months (oldest first); restored points get a grace period; the settings version in force at the sale is kept for its returns. |
| LOY15 | Done | Every movement is an append-only ledger event with the user, property, outlet, bill and reason; POS staff see a masked member. Corrections need a manager's approval. |
| LOY16 | Done | Members, ledger events, lots, holds, verifications, programme versions, club tiers and overrides, accruals and batches. |
| LOY17 | Done | Tablet: lookup, enrol, reward preview, redeem, remove. Back office: members, history, programme, cashback, reports. |
| LOY18 | Partial (mock) | Wallet redemptions and cashback post a journal to SAP (JournalEntries). Finance maps the cashback expense and wallet liability G/L accounts on Club cashback (migration `0017`, audited, every change kept); journals made before the mapping are held and go to SAP once when it is saved. Points are a discount on the sale, so they go to SAP inside the A/R invoice. |
| LOY19 | Done | Movement report (opening + movements = closing, ledger vs lots), liability by property and expiry, pending settlement, exceptions. |
| LOY20 | Partial | The reward is a discount line before VAT and levy (switchable in settings). Returns restore and reverse by line; a return is a separate document with a SAP credit note. Confirmed by Manish Khatri (31 Oct 2026). The KRA TIMS invoice and credit note wait for INT-02. |
| LOY21 | Partial | Issued, redeemed, expired and outstanding points by property and month at the point value. Breakage forecast not yet. |
| LOY22 | Done | OTP (shown on screen until there is an SMS gateway) or the member card QR before every redemption; staff accounts flagged and excluded on their own bills; exceptions for many bills a day, one waiter's share and failed codes; daily earning cap. Reprint-before-attach detection is not built. |
| LOY23 | Partial | Balance on every receipt; a member page by secure link with balances, expiring points and the statement (printable). SMS and WhatsApp after each sale wait for a gateway. |
| LOY24 | Partial | Separate programme and marketing consent; 18+ confirmation; anonymise keeps the ledger. The inactive-member retention period is not set yet. |
| LOY25 | Done | Points and credit cannot pay for alcohol unless the setting is turned on. |
| LOY26 | Done | Stacking off by default; with stacking on, a 25% ceiling per bill and per member per month. |
| LOY27 | Partial | Room revenue earns at checkout for direct and corporate bookings; excluded rate plans earn nothing. Redeeming against room nights is not built. |
| LOY28 | Partial | Enrol at reception and the till; printable card with a QR code the tablet camera scans. QR self-enrolment and bulk import are not built. |
| CLUB01 | Done | Club tiers with default discount and cashback, per-member overrides with dates and approval, membership status and dates. |
| CLUB02 | Done | With stacking off, discount or cashback per bill (discount by default, switchable on the tablet); with stacking on, both, inside the ceiling. |
| CLUB03 | Done | Monthly cashback from settled sales at each sale's own rate, net of returns, with minimum spend and cap. |
| CLUB04 | Done | Preview, draft, approval by a second person, posting once per member; adjustment batches after posting. |
| CLUB05 | Done | Wallet with lots, a 12-month expiry and a cap per bill; holds like points. |
| CLUB06 | Done | Returns reduce the entitlement; after posting, an adjustment batch takes it back and can leave a negative wallet that blocks use. |
| CLUB07 | Partial (mock) | Statements and reports done; SAP journals per property, with the G/L accounts finance maps in the app. |
| LAT01–LAT16, CAT01–CAT12 | See `docs/how-to-test-loyalty.md` | LAT13 waits for KRA TIMS; LAT04 packages wait for S10. |

### Defaults used in this PR (confirmed by Manish Khatri, 31 Oct 2026)

- **Reward treatment:** a discount line that reduces the VAT base, so 800 points take KES 944 off a till price that includes tax. The other option (non-cash tender) stays a setting (LOY20).
- **Club members earn cashback only**, not points. Setting.
- **With stacking off, the club discount is the default benefit**, switchable to cashback per bill.
- **Wallet credit can pay up to 100% of a bill** and expires after 12 months.
- **The OTP is shown on screen** until an SMS gateway is chosen.
- **Cashback batches are approved against the head office** (one legal entity) by a second person.

## Not yet satisfied (everything else)

HK-02 onwards, MT-*, POS-14, 15, 16, 20, BIL-05, 08, 13–15, INV-*, RPT-*, SEC-05, SEC-07, SEC-08, OPS-01, OPS-06, INT-01, INT-03–06, INT-08–10, SAP-01, SAP-03, SAP-06–10, SAP-12, SAP-16–19, AT-06, AT-11, AT-12, AT-15, AT-16 and SAP-AT01–03, 07–11, 13 are **not started**. SEC-03 admin MFA is still outstanding.

## Client data received (26 Oct 2026)

KRA PIN `P000598390N`; SAP branches K1 Parklands = 1, Small World = 4, Kahama = 3; active SAP tax groups; 43 outlets. All loaded by migration `0007`.

## Decisions (Manish Khatri, 26 Oct 2026)

- **eTIMS:** one registration for the group, not one per property. Fiscal invoice numbers are one group-wide sequence (migration `0008`). This replaces the brief's per-property bhfId in INT-02 and SAP-AT11.
- **Superseded 31 Oct 2026 (Manish Khatri): the client uses KRA TIMS, not eTIMS.** Each branch has one TIMS device, all registered under the same KRA PIN. The INT-02 integration will talk to each property's device, and the fiscal numbering in `0008` must be reviewed against the per-device numbering when it is built.
- **Outlets:** the 43 SAP outlets are the billing outlets (the brief's 21 is superseded).
- **Catering levy:** posted as its own C1 (2%) line, separate from VAT (BIL-16).
- **SAP Dimension 2:** short outlet codes (max 8 characters) as listed in `0008`.

- **Output VAT 14% (O4)** is still active and stays loaded.
- **Steve's Pool Bar warehouse (44)** belongs to Small World (SWCC), despite being listed under PSH in SAP's export.

## Still open

- **Outlets with no warehouse of their own:** K1 Flavour Bar, K1 Guinness Bar, K1 Laundry, K1 Other Sales, K1 Rental; SW Complimentary, SW Massage; KM Laundry, KM Swimming Pool. Service outlets may need none, but the two K1 bars sell stock; Manish is confirming their warehouse with the customer.
- **PSH warehouses with no K1 outlet:** Pitcher & Butch Bar (3), Shisha Bar (12) and Staff Kitchen (7). Manish is confirming with the customer.
- The legal entity name.
- Pitcher & Butch is set up as a restaurant that sells alcohol, and SWCC Complimentary as a non-revenue outlet. Both are guesses to confirm.
