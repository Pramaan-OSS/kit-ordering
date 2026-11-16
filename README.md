# Pickup kitchen

An MIT online ordering kit for cafes, bakeries and restaurants. Public menu, options, guest or account checkout, capacity-controlled pickup slots, paid-order kitchen board, private status links, editable lists and CSV.

Use Node 24.18.0 and pnpm 11.15.1. Run `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Configure DATABASE_URL, SESSION_SECRET (at least 32 characters), APP_ORIGIN and PRAMAAN_PROJECT_ID in your local environment. Never commit them. Then `node scripts/migrate.mjs`, `pnpm dev --port 3500`. For production checks run `pnpm build` then `pnpm start --port 3500`.

The owner enters with the platform's one-time `/api/account/owner-pass` link, then sets their own sign-in details at `/owner`. At `/manage`, add future pickup slots, edit the menu and add kitchen staff. Customers sign up at `/signin`; guests need no account. All times use UTC and prices use GBP pence. One order consumes one pickup place, irrespective of item count.

Payments use only `payments.checkout.create` and `payments.checkout.get` through the platform's module door. The platform must connect a test payment account; set PRAMAAN_PAYMENTS_MODE=test only for that account. This setting is a guard, not a switch that turns a real account into a test account. The module holds all credentials. A local app without the door reports payments unavailable. Email and photos likewise require platform modules.

For a complete local fake-payment demo: migrate a disposable database, run `node scripts/fake-door.mjs .scratch/door 3501`, then set PRAMAAN_MODULES_DIR to that directory's absolute path, PRAMAAN_PAYMENTS_MODE=test and APP_COOKIE_SECURE=false, and start on 3500. The clearly marked payment page moves no money. Never mount the fake door in a live deployment.

Checks: `pnpm typecheck`, `pnpm lint` (clean archive), `pnpm test` against a migrated disposable database, `pnpm build`, `node scripts/check-contract.mjs`, `node scripts/check-blocks.mjs` and `node scripts/walk.mjs`. The walk starts its own production server on 3500 and fake payment service on 3501. Keep both free. Evidence is excluded from git.

Unpaid checkouts conservatively hold capacity. Do not delete or release pending orders based on a browser cancellation or elapsed time: the payment might still settle. No refunds, delivery, taxes or stock counts. See KIT.md for extension points and GAPS.md for platform dependencies.

The kit carries no browser tools. To run `node scripts/walk.mjs`, install `@playwright/test` 1.64.1 outside the kit and set `WALK_BROWSER_MODULE` to its `index.mjs`.
