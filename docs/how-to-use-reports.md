# Reports and downloads

## The Reports page

Open **Reports** in the menu. Each report is a card that answers one question, with its own dates (and outlet, where that applies). Press **Download Excel** for a workbook, or **Also PDF** for an A4 file to print or send. Your last downloads are listed at the bottom, with **Download again** for the same dates and filter.

Excel files have the property and report name at the top, the period and filters, the YeaStay logo, a coloured header row you can filter, frozen headings, and real numbers: amounts and counts add up, occupancy is a percentage, dates are dates. They print on A4 landscape, one page wide.

| Area | Report | What it shows | Dates |
|---|---|---|---|
| Rooms and front office | Daily room sales | Occupancy, rooms sold, room revenue, ADR, RevPAR, arrivals, departures, cancellations, no-shows per business day | Range |
| | Room sales by room type | Occupied, sold, revenue, ADR per room type | Range |
| | Room sales by booking source | Walk-in, phone, email, agent, website compared | Range |
| | Cancellations | Each cancelled booking with booked value, fee and reason | Range |
| | No-shows | Each no-show with booked value and fee | Range |
| | Daily flash | One business day on one page | One day |
| | Hotel report (all tables) | All of the above room tables in one file | Range |
| Restaurants and bars | Sales summary | Gross to net, discounts, comps, tax by code, settlement by method | Range, outlet |
| | Sales by outlet / product / category / waiter | One table each | Range, outlet |
| | Discounts and complimentaries | Every discounted or comp line: check, waiter, item, list value, discount, reason | Range, outlet |
| | Voids and waste | Voided checks with reason; cancelled and wasted lines | Range, outlet |
| | Refunds | Every POS refund with method, reason and who gave it | Range, outlet |
| | House accounts | Staff meals and entertainment by cost centre (not revenue) | Range, outlet |
| | Cash shifts and variances | Float, expected, counted, variance, review | Range, outlet |
| | POS sales (all tables) | Everything above in one file | Range, outlet |
| Money and guest ledger | Money received | Front desk and POS money by day and method, less refunds | Range |
| | Guest ledger | Every open folio, and closed folios with a balance: charges, paid, pending, deposit held, balance | As at now |
| | Deposits held | Confirmed deposits not yet applied to a bill | As at now |
| Group (group users) | Daily flash, all properties | The properties side by side with a group total | One day |

Room and money reports need the *reports* permission (owner, admin, area manager, group accounts, manager, accountant). Restaurant and bar reports need *POS reports*. You only see the cards your role allows, and only for the properties you can open. Every download is written to the audit log.

## Reports on screen

The **Daily flash**, **Room sales**, **POS sales**, **Cash shifts** and **POS day close** screens still show their figures on screen, with **Download: Excel / PDF** buttons for everything on that screen.

## How the figures are counted

- Room nights count once the business day is closed (the night audit posts them). A day still open shows no room nights and is marked *Open*; period totals cover closed days only.
- Room revenue is net of VAT and catering levy. Occupancy = occupied / available rooms (rooms blocked for maintenance are not available). ADR = room revenue / rooms sold. RevPAR = room revenue / available rooms. Complimentary rooms count as occupied, not sold.
- POS sales are closed checks by trading date, counted once. A charge to a room is a way of settling, not a second sale. House accounts are never revenue.
- Money received is confirmed folio payments plus POS payments of the day, less POS refunds.
- Guest ledger balance = posted charges less confirmed payments (deposits included). A negative balance is money owed back to the guest; pending payments are shown but not deducted.

## Not yet

- Sending the flash by email or WhatsApp after each day close (RPT-07) needs an email/SMS gateway.
- Owner dashboard (RPT-01), operations reports (RPT-05), drill-down from a figure to its transactions (RPT-06).
- Loyalty report downloads: after the loyalty PR is merged.

## API

All `GET`, bearer token, same permissions as the screens. Add `format=xlsx`, `format=pdf` or `format=csv` to an `/export` route.

- `/api/properties/{code}/reports/catalog`: the reports you may download here
- `/api/properties/{code}/reports/catalog/{name}/export?from=&to=&outlet=&format=` (Excel by default; "as at now" reports need no dates; one-day reports use `to`)
- `/api/properties/{code}/reports/recent`: your last 12 downloads

- `/api/properties/{code}/reports/hotel?from=&to=` and `/hotel/export`
- `/api/properties/{code}/reports/flash?date=` and `/flash/export`
- `/api/reports/flash?date=` and `/reports/flash/export` (every property you can see, with group totals)
- `/api/properties/{code}/reports/pos-sales/export?from=&to=&outlet=`
- `/api/properties/{code}/reports/cash-shifts?from=&to=&outlet=` and `/cash-shifts/export`
- `/api/properties/{code}/reports/pos-days/{dayId}/export`

Ranges are at most 366 days.
