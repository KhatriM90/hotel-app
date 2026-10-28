# How to test: point of sale (POS)

This checklist covers the POS module: waiter and bar tablets, kitchen and bar tickets, payments, charge to room, house accounts, cash shifts, POS day close and the business-day cut-off settings. It follows the brief's POS requirements (POS-01 to POS-13, POS-17 to POS-19), the billing rules they touch (BIL-02, BIL-03, BIL-11, BIL-12), offline capture (OPS-05) and the acceptance tests AT-02, AT-03, AT-07, AT-09, AT-10, AT-13, AT-14, AT-17 and AT-18.

Each acceptance test below also runs automatically in `apps/api/test/pos.e2e-spec.ts` (29 tests). `npm test` must be green before anyone tests by hand.

## Before you start

1. Migrate and seed a database (see the README, "Run locally"). The seed adds the sample menus and is safe to run again.
2. Open two windows:
   - **Tablet (PWA):** `http://localhost:5174/pwa/` locally, or `/pwa/` on the dev or test domain. A tablet or a narrow browser window works; the layout is built for 10-inch tablets.
   - **Back office:** `http://localhost:5173` locally, or the dev or test domain.
3. Every seeded user has the password you gave as `SEED_PASSWORD`.

| User | Role | Property | Use it for |
|---|---|---|---|
| `k1.waiter` | Waiter | K1 Klubhouse | Tables, orders, bills, M-PESA/card payments, charge to room. Cannot refund. |
| `k1.bartender` | Bartender | K1 Klubhouse | Bar sales and the bar ticket screen |
| `k1.kitchen` | Kitchen | K1 Klubhouse | Kitchen ticket screen only |
| `k1.cashier` | Cashier | K1 Klubhouse | Cash shifts, payments, refunds (with a manager) |
| `k1.manager` | Manager | K1 Klubhouse | Approvals, cash-out, shift review, POS day close, settings, menus |
| `k1.reception` | Receptionist | K1 Klubhouse | Checking a guest in so they can charge to their room |
| `sw.waiter`, `sw.manager`, `sw.reception` | | Small World | Small World tests |
| `km.waiter`, `km.manager` | | Kahama | Isolation test (AT-18) |

**Seeded test data (placeholders until the client sends real menus, prices and licence hours)**

- One group menu: 14 categories and about 35 items (breakfast, starters, mains, nyama choma, desserts, coffee, soft drinks, beer, spirits, wine, cocktails, shop, leisure, spa) with portions (tot / double / bottle, glass / bottle, ½ kg / 1 kg) and modifiers (cooking, extras, side, mixer, ice).
- Each selling outlet gets the part of the menu that fits its type: bars sell drinks and bitings, restaurants and kitchens sell food and drinks, the shop and leisure outlets sell their own items. Prices include VAT 16% and catering levy 2%. Examples: Tusker 350, Johnnie Walker Black tot 450 / double 850, Chicken curry 1,250, Klub beef burger 1,100, Café latte 320.
- Stations at each property: **Main kitchen** (KITCHEN), **Service bar** (SERVICE-BAR), and one bar station for each bar outlet (for example **Cocktail Bar**). Food goes to the kitchen; drinks go to the outlet's own bar.
- Tables: 8 at each bar and 12 at each restaurant.
- Alcohol hours: 10:00 to 02:00 every day, outside those hours alcohol is blocked unless a manager overrides with a reason.
- House accounts: STAFF-MEALS (limit 150,000), DIRECTORS (no limit), ENTERTAIN (limit 50,000).
- Happy hour at **Shed Bar** (K1-SHED): beer 20% off, Monday to Friday, 17:00 to 19:00.
- Business day cut-off: 08:00 for every property. Sales between midnight and 08:00 belong to the previous trading day.
- Discounts without approval: 0%, so every discount needs a manager until a property raises it.

---

## 1. Settings: business day cut-off (CFG-01, CFG-03)

Back office, sign in as `k1.manager`, property K1 Klubhouse, **Business day and POS**.

- [ ] The **Business day** card shows the cut-off 08:00 and "Discount without approval" 0.
- [ ] Change the property cut-off to 06:00 and **Save**. Expect a confirmation. The outlets table now shows 06:00 for outlets that use the property default. Set it back to 08:00.
- [ ] Click **Edit** on Cocktail Bar. Tick **Own day cut-off** and set 10:00. Save. The outlets table shows 10:00 for Cocktail Bar only. Edit again, untick **Own day cut-off**, save; it is back to the property's 08:00.
- [ ] In the same dialog, check that **Kitchen tickets go to** is Main kitchen and **Bar tickets go to** is Cocktail Bar. Licensed alcohol hours show 10:00 to 02:00 for each day.
- [ ] Sign in as `k1.waiter` in the back office. The **Business day and POS** menu entry is not shown (the API refuses it too).

A changed cut-off applies from the next trading day, never to a day that is already open.

## 2. Menus and prices (POS-01, POS-02, POS-03, POS-19)

Back office as `k1.manager`, **Menus and prices**.

- [ ] Pick outlet **Cocktail Bar**. The price list shows categories as tabs, prices, a "portions left today" count, availability and favourites. Alcohol items carry an "alcohol" tag.
- [ ] Change Tusker's price at Cocktail Bar to 360 and save the row. Pick **Cowgirl Bar**: Tusker is still 350. Change it back.
- [ ] **Copy from template…**: copy Cocktail Bar to Guinness Bar. Guinness Bar now has the same items, prices and alcohol hours. Copying to another property's outlet works the same way for the owner or a group user, who can see both.

## 3. Take an order and send it (POS-01, POS-04 to POS-07)

Tablet, sign in as `k1.waiter`. Pick **Waiter / bar POS**, then **Cocktail Bar**.

- [ ] The floor shows tables T1 to T8 and a list of open checks. Tap **T1** and enter 2 covers.
- [ ] Search or tap categories. Add **Tusker** twice, then **Spirits → Johnnie Walker Black**: choose **Double** and mixer **Tonic** (+50). Then **Nyama choma & grill → Goat nyama choma**: ½ kg, side Ugali, note "no salt".
  - Expect: the basket lines show in light teal; the total is 350 × 2 + 900 + 1,300 = **2,900.00**, with VAT and levy shown below it.
- [ ] Tap **Send order (4)**. The lines change to "Sent".
- [ ] On a second tablet or window, sign in as `k1.bartender`, pick **Kitchen / bar tickets**, then **Cocktail Bar**. One ticket shows table T1, the server, the time, 2 × Tusker and 1 × Johnnie Walker Black (Double, Tonic).
- [ ] Sign in as `k1.kitchen`, **Main kitchen**: one ticket with Goat nyama choma ½ kg, Ugali and the note "no salt". Tap **Start**, then **Ready**.
- [ ] Back on the waiter's T1, the goat line shows **Ready** and table T1 is highlighted on the floor. Tap the line and **Served**.
- [ ] On the kitchen screen, **Reprint** the ticket with the reason "printer jam". The printout says **REPRINT #2**.

## 4. Corrections (POS-11, AT-10)

On T1 as `k1.waiter`:

- [ ] Add one more Tusker and do **not** send it. Tap it and **Cancel items**: it disappears with no approval and no ticket (pre-production).
- [ ] Select a sent Tusker and **Cancel items** with the reason "guest changed mind". The tablet asks for a manager: enter `k1.manager` and the password. Expect: the line shows Cancelled, and the bar station receives a red **CANCEL** ticket.
- [ ] Order and send a **Klub beef burger** (Medium). In the kitchen tap **Start**. Then cancel it on the waiter's tablet with a manager. Expect: the line is marked **Wasted** (it was being prepared), not just cancelled, and it stays visible on the check history.

## 5. Discounts and comps (POS-03, SEC-02)

- [ ] On T1, **Discount** 10% on the whole check with the reason "regular guest". A manager must approve because the free limit is 0%.
- [ ] As `k1.manager` in the back office, set "Discount without approval" to 10. Now a 5% discount by the waiter goes through with no manager. Set it back to 0.
- [ ] A 100% discount (comp) on a line always needs a manager, whatever the limit.

## 6. Pay immediately (POS-10, AT-02, AT-03)

- [ ] On T1, **Print bill**. The bill shows items, VAT and levy, the total and "eTIMS receipt not yet issued".
- [ ] **PAY**: M-PESA for part of the balance with reference `QPOS1TEST1`, and card for the rest. The check closes and **Print receipt** shows both tenders.
- [ ] Open another check and try M-PESA with the same reference `QPOS1TEST1`. It is refused as a duplicate payment.
- [ ] **AT-02:** in the back office, **SAP postings** shows an A/R invoice and an incoming payment for that check number. The check never appears on any guest folio.

## 7. Cash shift and cash payments (POS-13, AT-13)

Tablet as `k1.cashier`, outlet Cocktail Bar.

- [ ] Try to take **Cash** on a new check: refused, "open a cash shift first".
- [ ] **Cash shift → Open** with a float of 5,000.
- [ ] Sell 2 × Tusker (700) and 2 × Soda 300 ml (300), total 1,000, and pay **Cash 2,000**. The tablet shows 1,000 change.
- [ ] **Cash shift → Paid out (manager)** 300 with the reason "ice". A manager must approve.
- [ ] **Cash shift → Close**: the count is blind (the expected amount is not shown). Enter 5,500 (expected is 5,000 + 1,000 − 300 = 5,700).
- [ ] Back office as `k1.manager`, **Cash shifts**. The shift shows expected 5,700, counted 5,500 and a variance of −200 waiting for review. **Review** it with a note. The review is signed with the manager's name and time.

## 8. Refunds (POS-11, AT-14)

- [ ] Tablet as `k1.waiter`: open a closed check. There is no refund action, and the API refuses one.
- [ ] As `k1.cashier` (with an open shift), refund part of a closed cash check with the reason "wrong drink". A manager must approve. The cash shift's expected amount drops by the refund.

## 9. Charge to room (POS-09, BIL-02, BIL-03, BIL-12, AT-07)

Use Small World, so the K1 test rooms stay free for reception testing.

- [ ] Back office as `sw.reception`: book and check in a guest for tonight (see `docs/how-to-test-reservations.md`), with "Outlets may charge to this room" ticked.
- [ ] Tablet as `sw.waiter`, outlet **Main Kitchen** (SW-KITCHEN). Open a table and add Chicken curry (1,250), Klub beef burger (1,100) and Café latte (320). Total **2,670.00**.
- [ ] **PAY** 1,000 by M-PESA.
- [ ] **Room**: search by room number or surname. The guest shows as eligible with their available credit; no identity number is shown.
- [ ] Ask the "guest" to sign on the screen (or choose "staff verified" and type the name). Confirm.
  - Expect: the check closes with a room-charge reference. The guest's folio has three new itemised lines, each marked "(balance)", totalling **1,670.00**, with the check number as reference.
- [ ] **AT-07:** **SAP postings** shows an A/R invoice for the M-PESA part only (1,000, lines marked "(paid part)"). The room part is invoiced with the folio at checkout, so no shilling is invoiced twice.
- [ ] Try charging to a stay with room charges turned off, or over its credit limit: refused with a clear reason.

## 10. Checkout with an open check (BIL-11, AT-09)

- [ ] Back office as `sw.manager`, **Business day and POS**: edit Main Kitchen and tick **Room service**.
- [ ] Tablet as `sw.waiter`, Main Kitchen: tap **Room service**, pick the in-house guest from above, add an item and **Send order**. Do not settle it.
- [ ] As `sw.reception`, try to check the guest out. Refused: "open POS checks" with the check number. Settle the check (pay or charge to room), then checkout works.

## 11. House accounts (POS-18)

- [ ] As `k1.waiter`, open a counter check at Klub Koffee, add 2 × Kenyan chai and choose **Split, merge and more → House account → STAFF-MEALS**. A manager must approve.
- [ ] The check closes as "house account". In the back office **POS sales** lists it under house accounts, not under revenue. No SAP sale is queued for it.

## 12. Split, move and merge (POS-05, POS-08)

- [ ] On a table with 3 × Tusker, **Split, merge and more → Split bill**: move 1 Tusker to a new check. Both checks add up to the original.
- [ ] **Move table** for the new check to another table.
- [ ] **Merge bills** to put it back into the first check. The total is unchanged.

## 12a. Split evenly (POS-08)

- [ ] On a table with a total of 1,550, open **Split, merge and more → Split evenly**. Enter 3 people and choose M-PESA. The payment dialog opens with **516.66** and M-PESA selected. Take it with a reference.
- [ ] For the second person, **Split evenly** again with 2 people still to pay and Card: 516.67. The last person taps **PAY** for the rest, 516.67, so nothing is lost to rounding.

## 13. Out of stock and alcohol hours (POS-12, POS-17)

- [ ] Back office **Menus and prices**, Cocktail Bar: untick **On sale** for Mojito. On the tablet Mojito is greyed out and cannot be added.
- [ ] Set "portions left today" for Dawa to 1. Add 2 Dawas: the tablet warns (Cocktail Bar's stock policy is "warn"). Set the outlet's policy to "block" in **Business day and POS** and try again: refused.
- [ ] In **Business day and POS → Cocktail Bar**, set today's alcohol hours to end one hour ago. Adding a Tusker is blocked; a manager can override with a reason, and the override is in the check history. Restore 10:00 to 02:00.
- [ ] Happy hour: on a weekday between 17:00 and 19:00, beer at **Shed Bar** shows 20% off; outside those hours it is full price.

## 14. Offline (OPS-05, AT-17)

- [ ] Tablet as `k1.waiter` at Cocktail Bar. In the browser's developer tools set the network to **Offline** (or turn off Wi-Fi).
- [ ] The status bar turns red: "Offline: orders are saved on this tablet and sent later. Payments and room charges wait."
- [ ] Open a table, add items and **Send order**. The order is kept on the tablet and the check shows it as "(waiting)"; the floor shows how many actions are waiting to be sent. **PAY**, **Room** and **Print bill** are disabled.
- [ ] Go back online. Within a few seconds the queued order syncs once: the bar receives exactly one ticket, and the check has the same number of lines as on the tablet.

## 15. Property isolation (AT-18)

- [ ] Tablet as `km.waiter`: only Kahama outlets are listed. The API refuses K1 outlet and check URLs.
- [ ] Back office as `km.manager`: POS pages show Kahama only.

## 16. POS day close and the property business day (BIL-10)

Back office as `k1.manager`, **POS day close**.

- [ ] Each selling outlet shows its cut-off, the open trading day (if any), open checks and open shifts.
- [ ] **Close day…** on an outlet with an open check: refused until the check is settled or voided.
- [ ] Close the day on an outlet with no open checks. The dialog shows the X totals (sales by category, tenders, room charges, house accounts, discounts, voids, refunds) and **Print X report**. Click **Close the day**: the Z report is stored and **Print Z report** prints it. **Z reports** lists it with every earlier one.
- [ ] As `k1.reception`, close the property's business day (front desk). It is refused while any outlet still has an open trading day for that date that has sales; outlets with no sales close themselves.

---

## What is not in this module

See `docs/requirements-traceability.md`, "POS PR", for the full list. In short:

- **eTIMS** (INT-02): receipts say "eTIMS receipt not yet issued"; fiscal submission is a separate piece of work.
- **M-PESA STK push** and card terminals (INT-01, INT-03): the cashier types the M-PESA reference; a pending payment can be confirmed or failed by hand.
- **Network ticket printers** (INT-04): tickets and bills print from the tablet's browser. Kitchen screens refresh every 10 seconds.
- **SAP credit memo for refunds**: a refund is recorded and reduces the cash shift, but no credit memo is queued to SAP yet.
- **SAP till and clearing accounts per property** (SAP-16) are still to be agreed with accounts; the walk-in customer code `C-WALKIN` is a placeholder.
- **Menus, prices, alcohol hours and house-account limits are test data** until the client sends theirs.
