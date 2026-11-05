# How to test the front desk changes (5 Nov 2026 demo)

Run the app with the seed and demo data (see the README), sign in as `sw.reception` (or `sw.manager` for manager-only steps; password = `SEED_PASSWORD`) and pick **Small World Country Club**.

## Room dashboard

![Room dashboard](screenshots/room-dashboard.png)

1. Open **Room dashboard**. The six cards count room-nights for the rooms shown over the period; the line under them says which period.
2. Switch **Calendar / Table / Room cards** and **Day / Week / Month / Custom**. Custom refuses an end date before the start and more than 366 days.
3. Search for a guest's name or a room number; filter by room type, floor or status (including "Needs cleaning" and "Credit running out").
4. Click an occupied night: the panel shows the guest, the credit status and **Open booking** / **Move to another room**.
5. Click a free night: **Book room … from …** opens a new booking with that room picked; or block the room with a reason. Click the block to release it.
6. Change housekeeping from the panel; the room's badge updates (booking colour does not).
7. **Export CSV** and open it in Excel: one row per room-night shown.

## Booking

1. **Reservations › New booking**. Required fields have a red star. With nationality Kenya, KRA PIN is required; type "tanz" in Nationality and pick Tanzania: the star on KRA PIN goes.
2. Enter a malformed KRA PIN (e.g. `12345`): the form explains the format.
3. Pick a **Room number** for the room line, or leave "Any free room".
4. Click **Add a travel agent**, save it: it is selected on the booking and listed under **Agents and companies**.
5. Give the guest an email and create the booking. On the booking, **Emails to the guest** shows the confirmation waiting (or sent, if SMTP is set) with the pro forma attached. **Send again** after taking a deposit adds the receipt.

## Policies

![Policies](screenshots/policies.png)

As `sw.manager`: **Rates and policy › Edit policies**. Change the hotel policies (one rule per line) and save. Print a pro forma or a registration card: the rules appear on it. New confirmation emails include them.

## Mandatory guest fields

![Guest field rules](screenshots/guest-fields.png)

As `sw.manager`: **Guests**, scroll to **Mandatory guest fields**. Make Email mandatory and save. A new booking now stars Email and refuses to save without it. Set it back to Optional.

## Prepaid credit and nightly posting

![Booking with credit warning and email](screenshots/booking-email.png)

1. Check in a 3-night booking and take a payment for exactly the first night. The booking, the room dashboard and the **Front desk** page say the credit covers tonight only.
2. As `sw.manager`, on the booking: **Switch off** nightly posting, with a reason. Close the day: no room charge is posted for that stay. **Switch on** again: the next close posts both nights.
3. As `sw.reception`, the switch is not offered and the API refuses it (403).

## Email server

Set `SMTP_URL` (e.g. `smtp://user:pass@smtp.example.com:587`) and `MAIL_FROM` in the API environment. For local testing, run Mailpit (`docker run -p 8025:8025 -p 1025:1025 axllent/mailpit`) and set `SMTP_URL=smtp://localhost:1025`; messages appear at http://localhost:8025. Failed sends retry with backoff (up to 8 attempts); the booking shows the last error.
