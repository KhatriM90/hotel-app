# Reports and downloads

Every report below opens in the back office and has **Download: CSV (Excel)** and **PDF** buttons at the top right. The file covers exactly what the screen shows for the dates and outlet you picked. CSV files open straight in Excel (amounts are plain numbers you can add up); PDFs are A4 with the property name, period, who generated it and page numbers.

You only see the reports your role allows, and only for the properties you can open. Every download is written to the audit log.

| Report | Where | What it shows | Who |
|---|---|---|---|
| Daily flash | **Daily flash** | One business date: occupancy, ADR, RevPAR, room / F&B / other revenue, money received by method, cashier variances and exceptions. Group users can switch to **All properties** for the three side by side with a group total. | Owner, admin, area manager, group accounts, manager, accountant |
| Hotel report | **Hotel report** | Daily room sales, occupancy, ADR, RevPAR, arrivals, departures, cancellations and no-shows for a date range, by room type and booking source, with the list of cancellations and no-shows. | Same as above |
| POS sales | **POS sales** | Gross to net, tax, payment methods, room charges, by outlet, category, product and waiter, voided checks, refunds, house accounts. | Owner, admin, area manager, group accounts, manager, accountant |
| Cash shifts | **Cash shifts** (date range under the filters) | Every shift in the period with float, expected, counted, variance and review. | Same as POS sales |
| Z / X report | **POS day close** (outlet's *Z reports* list, or the close-day window) | One outlet's trading day. Print as before, or download CSV/PDF. | Same as POS sales |

## How the figures are counted

- Room nights count once the business day is closed (the night audit posts them). A day still open shows no room nights and is marked *Open*; period totals cover closed days only.
- Room revenue is net of VAT and catering levy. Occupancy = occupied / available rooms (rooms blocked for maintenance are not available). ADR = room revenue / rooms sold. RevPAR = room revenue / available rooms. Complimentary rooms count as occupied, not sold.
- POS sales are closed checks by trading date, counted once. A charge to a room is a way of settling, not a second sale. House accounts are never revenue.
- Money received is confirmed folio payments plus POS payments of the day, less POS refunds.

## Not yet

- Sending the flash by email or WhatsApp after each day close (RPT-07) needs an email/SMS gateway.
- Owner dashboard (RPT-01), operations reports (RPT-05), guest ledger and deposit reports (RPT-04), drill-down to transactions (RPT-06).
- Loyalty report downloads: after the loyalty PR is merged.

## API

All `GET`, bearer token, same permissions as the screens. Add `format=csv` or `format=pdf` to an `/export` route.

- `/api/properties/{code}/reports/hotel?from=&to=` and `/hotel/export`
- `/api/properties/{code}/reports/flash?date=` and `/flash/export`
- `/api/reports/flash?date=` and `/reports/flash/export` (every property you can see, with group totals)
- `/api/properties/{code}/reports/pos-sales/export?from=&to=&outlet=`
- `/api/properties/{code}/reports/cash-shifts?from=&to=&outlet=` and `/cash-shifts/export`
- `/api/properties/{code}/reports/pos-days/{dayId}/export`

Ranges are at most 366 days.
