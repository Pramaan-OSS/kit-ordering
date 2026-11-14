# Online ordering kit

## Where things live

- `app/page.tsx`: public menu, options, basket and pickup checkout.
- `app/signin/page.tsx`: sign-in for every account and public customer signup.
- `app/orders/page.tsx`: signed-in customer's own order list, refreshed automatically.
- `app/status/page.tsx`: private signed order status, payment verification and polling.
- `app/status/layout.tsx`: no-index and no-referrer policy for private links.
- `app/kitchen/page.tsx`: paid order board; polls every three seconds.
- `app/manage/page.tsx`: owner menu, options, choices, sold-out flags, hours, slots, statuses, staff and CSV controls.
- `app/owner/page.tsx`: owner email and password settings.
- `app/api/account/[action]/route.ts`: unchanged starter account handler and owner pass.
- `app/api/health/route.ts`: unchanged health check.
- `app/api/ordering/[action]/route.ts`: public menu; signed status; scoped orders; kitchen board and moves; owner administration and CSV.
- `app/api/photos/[id]/route.ts`: owner image uploads through files; public menu image reads.
- `app/layout.tsx`, `app/shell.tsx`, `app/site.ts`, `app/theme.css`, `app/ui.tsx`: shared frame and theme.
- `lib/accounts.ts`: unchanged starter passwords, sessions and owner pass.
- `lib/runtime.ts`: one database pool, session secret and public customer signup.
- `lib/roles/http.ts`: bounded same-origin requests and uncached responses.
- `lib/pramaan.ts`: the one HTTP capability client, through the platform socket; credentials stay in the platform.
- `lib/email.ts`, `lib/ordering/storage.ts`: platform email and files module helpers.
- `lib/ordering/store.ts`: row queries, price calculation, slot locks and order scope.
- `lib/ordering/payments.ts`: hosted checkout, captured-payment verification, kitchen moves and keyed emails.
- `lib/ordering/links.ts`: expiring HMAC-signed status links, with random per-order nonces checked in the database.
- `lib/ordering/admin.ts`: owner edits and staff accounts.
- `lib/ordering/csv.ts`: transactional menu import and safe CSV exports.
- `lib/ordering/validation.ts`: bounded input checks.
- `lib/pramaan/client.ts`: browser request helper.
- `src/db/migrations/0001`–`0004`: unchanged starter migrations.
- `src/db/migrations/0100-ordering.sql`: menu, hours, capacity, orders, lines, statuses and mail delivery records. `0101` adds the per-cart checkout retry key.
- `scripts/migrate.mjs`: additive migration runner; rejects edited migrations.
- `scripts/walk.mjs`: headless journeys, owner-pass checks and fake-module checkout walkthrough.
- `scripts/check-contract.mjs`, `scripts/check-blocks.mjs`: contract, licence, secrets and pinned source checks.

## Add a field

Add a migration numbered after 0100; never edit an applied migration. For example, add an item allergen note, then include it in `menu()` and the owner item query in `admin.ts`, the menu and owner forms, and a database test. Keep order-line snapshots stable when the menu changes. Prices are whole pence, computed on the server from items and choices; browser totals are never trusted.

## Add a page

Add `app/<name>/page.tsx` and a sibling `pramaan.feature.json` with its route. Add a manifest entry point and journey. Each server endpoint must call `requireUser` or `requireRole` before protected queries. Hiding links does not grant or restrict access.

## Add a role

Roles live in `app_users.role`. Public signup always makes `member`, the customer's stored role. Only the owner adds `kitchen` accounts in `admin.ts`; the browser cannot set its signup role. Restrict protected routes with `requireRole`. Customer reads always use the signed-in user id. The owner comes only from a one-time owner pass.

## Journeys that ship working

- `browse-menu`: public menu and opening hours.
- `manage-menu`: owner edits categories, items, options and choices.
- `pickup-capacity`: owner edits hours and capacity.
- `edit-statuses`: owner edits seeded status rows; values in use cannot be deleted.
- `add-kitchen-staff`: owner adds a staff sign-in; staff see the board only.
- `kitchen-board`: paid orders and editable status selection, refreshed without reloading.
- `owner-settings`: one-time owner pass and owner sign-in settings.
- `customer-account`: customer signup, sign-in and own orders only.
- `signed-out`: protected lists refuse signed-out reads.

Payment, email and photo journeys are `needs-capability` when their platform module is off. The headless walk supplies fake modules and exercises the complete guest checkout, payment confirmation, Ready transition and private status page. See README.md and GAPS.md for configuration and limits.
