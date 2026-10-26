# Requirement traceability: foundation PR

Source of truth: *Hotel & Bar Web App Development Brief v1.2* (26 Oct 2026).
Status key: **Done** = satisfied for what exists today · **Partial** = foundation in place, feature work outstanding · **Not started**.

## Brief §9 non-negotiable rules

| Rule | Status | Where |
|---|---|---|
| Permanent stay/folio IDs | Partial | `STAY` and `FOLIO` number types exist (`0003`); stay/folio tables arrive with reservations and billing. |
| Separate fulfilment, payment, posting and fiscal status | Partial | Pattern set: integration status lives in `integration_outbox`, not on source records; `app_guard_finalised()` only lets whitelisted status columns change. |
| Transactional local updates; durable pending events for external systems | Done (foundation) | `DbService.tx()`; `integration_outbox` written in the business transaction; worker never reports success it did not get. |
| Idempotency keys on POS postings, nightly charges, payment callbacks, fiscal submissions | Partial | `idempotency_keys` + `@Idempotent()` interceptor (same transaction, concurrent-safe); SAP `U_HTL_ExtRef` lookup-before-post. Must be applied to each posting route as those routes are built. |
| Decimal money, consistent rounding, snapshots | Partial | `money_amount`/`money_precise`/`rate`/`quantity` domains; `Money` class (decimal.js, half-up, allocation without lost cents). Rounding rule is provisional until the accountant signs off (BIL-08). Price/tax snapshots arrive with POS/billing. |
| Freeze stay for checkout (concurrency) | Not started | Needs stays/folios. |
| Linked reversals, never edit/delete finalised records | Partial | `app_forbid_mutation()` (append-only) and `app_guard_finalised()` triggers, tested; attached to `audit_events`, `number_allocations`, `integration_outbox`. Financial tables attach them when created. |
| Calendar timestamp vs business date | Partial | `properties.current_business_date` and `business_day_cutoff`; audit rows carry business date. |
| Guest balance definition | Not started | Billing. |
| POS revenue recorded once | Not started | POS/billing. |

## Requirement IDs touched by this PR

| ID | Status | Notes |
|---|---|---|
| CFG-01 | Partial | Property name, location, currency, timezone, business-day cut-off, contacts, branding JSON. No edit screen/API yet. |
| CFG-03 | Partial | The client's 43 SAP outlets are loaded (K1 19, SW 11, KM 13; migration `0007`) with type, revenue centre, alcohol flag and the verbatim SAP outlet name. Issuing warehouses, stations, tills and printer destinations not yet. |
| CFG-04 | Partial | Group → property → outlet; per-property business date; property-prefixed, gapless, group-unique numbers (`K1-INV-000123`). Per-property rates, taxes and night audit not yet. |
| CFG-05 | Not started | Group master data with property overrides. |
| SEC-01 | Done (data) | All named roles seeded, plus group roles. No user-management API yet. |
| SEC-02 | Partial | Server-side permission matrix (`packages/shared/src/roles.ts`). Approval matrix (discounts, refunds, comps, credit, rate overrides, reopening days) not yet. |
| SEC-03 | Partial | Server-side checks, scrypt passwords, JWT, deactivation effective immediately, HTTPS/HSTS via Caddy, secrets from env. **Admin MFA, token revocation/device logout and encryption at rest (EBS/RDS setting) are outstanding.** |
| SEC-04 | Partial | Append-only `audit_events` (actor, time, business date, record, previous/new values, reason, request id). Written for login, outlet creation, dead letters and replays. Restricted export and retention not yet. |
| SEC-06 | Done (foundation) | Postgres row-level security on every property-scoped table; API runs as non-superuser `hotel_app`; property routes narrow scope to one property. |
| BIL-04 | Partial | Idempotency and outbox status (pending/claimed/posted/failed/dead), retries with backoff. No postings exist yet. |
| BIL-07 | Partial | Database guards in place; reversal/credit-note flows not yet. |
| BIL-09 | Partial | Numbering for booking, stay, folio, check, invoice, receipt, credit note, refund, pro forma. Documents themselves not yet. |
| INT-07 | Partial | Cloud outbox + HQ pull worker (outbound only) + Service Layer client + mock. |
| SAP-04 | Partial | A/R invoice mapping with branch, dimensions, UDFs; tax codes and item codes TBC from mapping workbook. |
| SAP-05 | Partial | Incoming payment mapping skeleton; invoice allocation not yet. |
| SAP-11 | Partial | Persistent queue, external unique IDs, lookup before retry, validation errors surfaced, authorised replay. Daily reconciliation not yet. |
| SAP-13 | Partial | Real BPLIds loaded: K1 = 1, SW = 4, KM = 3. Sent as `BPL_IDAssignedToInvoice`; worker refuses to post without one. Numbering series per branch not yet. |
| SAP-14 | Partial | `outlets.issuing_warehouse_code` must start with the property code. Warehouse codes for the 43 outlets are still TBC. |
| SAP-15 | Partial | Dimension 1 = property, Dimension 2 = revenue centre, set per line. The client's SAP outlet names are longer than an SAP dimension code (8 characters), so the actual Dimension 2 codes per outlet still need confirming. |
| SAP-02 | Partial | Active SAP tax groups mirrored in `tax_codes` (I1, I2, I4, X1, C1, O1, O2, O4, X0) with rate and GL account. Items, units, price lists and warehouses not yet; no automatic sync yet. |
| SAP-20 | Done (worker) | `U_HTL_ExtRef`, `U_HTL_Property`, `U_HTL_FolioNo` sent; lookup before every attempt. UDFs must still be created in the SAP test company. `HTL_SYNCLOG` UDO not yet. |
| OPS-02 | Partial | Retry queue, duplicate protection, per-property outbox list in back office, replay endpoint. Alerts not yet. |
| OPS-03 | Partial | Back office is responsive with 44px touch targets and visible focus. |
| OPS-04 | Partial | PWA shows live connection status from the API health check and never caches API calls. |
| AT-03 | Partial | Duplicate requests and concurrent duplicates tested at API level. |
| AT-18 | Partial | Kahama receptionist cannot see or post K1 data (tested). Consolidated reports not yet. |
| SAP-AT04 | Done (against mock) | Commit-then-drop test: retry finds the existing document; exactly one invoice. |
| SAP-AT05 / AT12 | Partial (mock) | Outage is retryable; worker backs off and recovers. |
| SAP-AT06 | Partial (mock) | Rejected document dead-letters with SAP's message; authorised replay keeps the source event unchanged. |

## Not yet satisfied (everything else)

All of RES-*, FD-*, HK-*, MT-*, POS-*, BIL-01–03, 05, 06, 08, 10–12, 15–17, INV-*, RPT-*, SEC-05, SEC-07, SEC-08, OPS-01, OPS-05, OPS-06, INT-01–06, INT-08–10, SAP-01, SAP-03, SAP-06–10, SAP-12, SAP-16–19, AT-01–17 and SAP-AT01–03, 07–11, 13 are **not started**. In particular, **INT-02 eTIMS** has only the `properties.etims_branch_id` column.

## Client data received (26 Oct 2026)

KRA PIN `P000598390N`; SAP branches K1 Parklands = 1, Small World = 4, Kahama = 3; active SAP tax groups; 43 outlets. All loaded by migration `0007`.

## Open questions from that data

- **Outlet count.** The brief says 21 outlets (9/8/4); SAP lists 43 (19/11/13) because it includes accommodation, kitchens, housekeeping, laundry, shops, car wash, rental and leisure. All 43 are loaded; POS-19 sizing should use the real count.
- **eTIMS branches.** The client has no separate eTIMS branch IDs, only the KRA PIN. INT-02 and the brief assume one bhfId per property. If all three trade under one eTIMS branch, fiscal invoice numbering must be one group-wide sequence rather than per property. To confirm with the accountant/KRA integrator before eTIMS work.
- **Catering levy.** The combined VAT+levy groups (I3/O3, 18%) are inactive; C1 (2%) is active on its own. Confirm whether the levy is posted as a separate C1 line (matches BIL-16) and which sales it applies to.
- **O4 Output VAT 14%** is active. Confirm whether anything still uses it.
- **Dimension 2 codes, warehouse codes and the legal entity name** are still TBC.
- Pitcher & Butch is set up as a restaurant that sells alcohol, and SWCC Complimentary as a non-revenue outlet. Both are guesses to confirm.
