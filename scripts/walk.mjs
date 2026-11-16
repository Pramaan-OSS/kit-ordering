// Headless local acceptance walk. Fake modules only; never calls a real payment account.
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The kit carries the starter's package.json, which has no browser tools: point WALK_BROWSER_MODULE at an installed
// @playwright/test (its index.mjs) to run this walk.
const browserModule = process.env.WALK_BROWSER_MODULE;
const { chromium, expect } = await import(
  browserModule ? pathToFileURL(browserModule).href : "@playwright/test"
);

import { Pool } from "pg";
import { startFakeDoor } from "./fake-door.mjs";

const origin = "http://127.0.0.1:3500";
const secret = randomBytes(32).toString("hex");
const project = "ordering-walk";
if (!process.env.DATABASE_URL) throw Error("Use a migrated disposable database in DATABASE_URL.");
mkdirSync(".evidence", { recursive: true });
const dir = path.resolve(".evidence/door");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let server;
let sampler;
let peak = 0;
let browser;
let door;
const checks = [];
const errors = [];
function pass(change = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b = Buffer.from(
    JSON.stringify({
      v: 1,
      role: "owner",
      project,
      iat: now,
      exp: now + 60,
      nonce: randomBytes(18).toString("base64url"),
      ...change,
    }),
  ).toString("base64url");
  return `${b}.${createHmac("sha256", secret).update(`pramaan-owner-pass.v1.${b}`).digest("base64url")}`;
}
async function serve(on) {
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", "3500", "-H", "127.0.0.1"],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        SESSION_SECRET: secret,
        PRAMAAN_PROJECT_ID: project,
        APP_ORIGIN: origin,
        APP_COOKIE_SECURE: "false",
        PRAMAAN_PAYMENTS_MODE: "test",
        PRAMAAN_MODULES_DIR: on ? dir : path.resolve(".evidence/no-door"),
      },
    },
  );
  sampler = setInterval(() => {
    try {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number));
      const tree = new Set([server.pid]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const [pid, ppid] of rows)
          if (tree.has(ppid) && !tree.has(pid)) {
            tree.add(pid);
            changed = true;
          }
      }
      peak = Math.max(
        peak,
        rows.filter(([pid]) => tree.has(pid)).reduce((n, [, , rss]) => n + rss, 0) / 1024,
      );
    } catch {}
  }, 100);
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("App did not start.");
}
async function stop() {
  clearInterval(sampler);
  if (server && server.exitCode === null) {
    const ended = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await ended;
  }
}
async function post(page, action, input) {
  return page.evaluate(
    async ({ action, input }) => {
      const r = await fetch(`/api/ordering/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return { status: r.status, body: await r.json() };
    },
    { action, input },
  );
}
function watch(page) {
  page.on("pageerror", (e) => errors.push(e.message));
}
try {
  await db.query("UPDATE menu_items SET photo_key=NULL");
  await db.query("DELETE FROM order_line_choices");
  await db.query("DELETE FROM order_mail");
  await db.query("DELETE FROM order_lines");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM pickup_slots");
  await db.query("DELETE FROM app_auth_throttle");
  browser = await chromium.launch({ headless: true });
  await serve(false);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  watch(owner);
  const token = pass();
  await owner.goto(`${origin}/api/account/owner-pass?token=${token}`);
  await expect(owner.getByRole("heading", { name: "Owner area" })).toBeVisible();
  expect((await owner.request.get(`${origin}/api/account/owner-pass?token=${token}`)).ok()).toBe(
    false,
  );
  for (const invalid of [
    pass({ exp: Math.floor(Date.now() / 1000) - 1 }),
    pass({ project: "another-app" }),
    `${pass().slice(0, -4)}oops`,
  ])
    expect(
      (await owner.request.get(`${origin}/api/account/owner-pass?token=${invalid}`)).ok(),
    ).toBe(false);
  checks.push("owner pass accepts once; rejects replay, expiry, foreign project and forgery");
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile("pramaan.kit.json", "utf8"),
  );
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  watch(visitor);
  for (const journey of manifest.journeys.filter((j) => j.status === "ships-working")) {
    const file = JSON.parse(
      await (await import("node:fs/promises")).readFile(journey.checklist, "utf8"),
    );
    const page = journey.role === "owner" ? owner : visitor;
    for (const step of file.items.flatMap((i) => i.steps)) {
      if (step.goto) await page.goto(origin + step.goto);
      if (step.expectHeading)
        await expect(
          page.getByRole("heading", { name: step.expectHeading, exact: true }),
        ).toBeVisible();
    }
    checks.push(`checklist:${journey.id}`);
  }
  await owner.goto(`${origin}/owner`);
  await owner.getByLabel("Owner email").fill(`owner-${randomUUID()}@example.test`);
  await owner.getByLabel("Password", { exact: true }).fill("owner-password-123");
  await owner.getByRole("button", { name: "Save sign-in" }).click();
  await expect(owner.getByRole("status")).toContainText("Saved.");
  checks.push("owner saves direct sign-in");
  await owner.goto(`${origin}/manage`);
  const slots = owner.getByRole("heading", { name: "Pickup slots (UTC)" }).locator("..");
  await slots
    .getByLabel("Pickup time (UTC)", { exact: true })
    .first()
    .fill(new Date(Date.now() + 172800000).toISOString().slice(0, 16));
  await slots.getByLabel("Order capacity").first().fill("4");
  await slots.getByRole("button", { name: "Add slot", exact: true }).click();
  await expect(owner.getByRole("status")).toContainText("Saved.");
  const staff = owner.getByRole("heading", { name: "Kitchen staff", exact: true }).locator("..");
  const staffEmail = `kitchen-${randomUUID()}@example.test`;
  await staff.getByLabel("Staff email").fill(staffEmail);
  await staff.getByLabel("Temporary password (12+ characters)").fill("kitchen-password-123");
  await staff.getByRole("button", { name: "Add staff" }).click();
  await expect(staff.getByText(staffEmail)).toBeVisible();
  checks.push("owner creates pickup slot and kitchen staff in the UI");
  const statuses = owner
    .getByRole("heading", { name: "Order statuses", exact: true })
    .locator("..");
  await statuses.getByLabel("Status name", { exact: true }).first().fill("Paused");
  await statuses.getByLabel("Display order").first().fill("5");
  await statuses.getByRole("button", { name: "Add status", exact: true }).click();
  await expect(statuses.locator("summary").filter({ hasText: "Paused" })).toBeVisible();
  await statuses.locator("summary").filter({ hasText: "Paused" }).click();
  await statuses.getByRole("button", { name: "Remove Paused" }).click();
  await expect(statuses.locator("summary").filter({ hasText: "Paused" })).toHaveCount(0);
  checks.push("owner edits status rows");
  const menuCsv = await owner.request.get(`${origin}/api/ordering/export?kind=menu`);
  expect(menuCsv.ok()).toBe(true);
  expect(await menuCsv.text()).toContain('"delta_cents"');
  const importCard = owner.getByRole("heading", { name: "Import and export" }).locator("..");
  await importCard
    .getByLabel("Menu CSV", { exact: true })
    .fill(
      "category,item,description,price_cents,sold_out,option,required,choice,delta_cents\nBakery,Walk croissant,Flaky pastry,280,false,,,,",
    );
  await importCard.getByRole("button", { name: "Import menu", exact: true }).click();
  await expect(owner.getByRole("status")).toContainText("Imported 1");
  checks.push("menu CSV import and export");
  await visitor.goto(`${origin}/`);
  await visitor.getByRole("button", { name: "Add Breakfast bun" }).click();
  await visitor.getByLabel("Email for your order").fill("off-check@example.test");
  await visitor.getByLabel("Pickup time (UTC)").selectOption({ index: 1 });
  await visitor.getByRole("button", { name: "Continue to test payment" }).click();
  await expect(visitor.getByRole("heading", { name: "Payment unavailable" })).toBeVisible();
  checks.push("module-off checkout does not confirm an order");
  await stop();
  door = await startFakeDoor({ dir, port: 3501 });
  await serve(true);
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  watch(guest);
  await guest.goto(`${origin}/`);
  await guest.getByLabel("Add a little extra").selectOption({ label: "Cheddar (+£1.00)" });
  await guest.getByRole("button", { name: "Add Breakfast bun" }).click();
  await guest.getByLabel("Email for your order").fill(`guest-${randomUUID()}@example.test`);
  await guest.getByLabel("Pickup time (UTC)").selectOption({ index: 1 });
  await guest.screenshot({ path: ".evidence/menu-desktop.png", fullPage: true });
  await guest.getByRole("button", { name: "Continue to test payment" }).click();
  await expect(guest.getByRole("heading", { name: "Test payment page" })).toBeVisible();
  await expect(guest.getByText("Amount due: 7.50 GBP")).toBeVisible();
  await guest.getByRole("button", { name: "Pay in test mode" }).click();
  await expect(guest.getByRole("heading", { name: "New", exact: true })).toBeVisible();
  const statusUrl = guest.url();
  checks.push("guest orders with an option, pays in test mode, confirmed only by server capture");
  const kitchenContext = await browser.newContext();
  const kitchen = await kitchenContext.newPage();
  watch(kitchen);
  await kitchen.goto(`${origin}/signin`);
  await kitchen.getByLabel("Email", { exact: true }).fill(staffEmail);
  await kitchen.getByLabel("Password", { exact: true }).fill("kitchen-password-123");
  await kitchen.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(kitchen.getByRole("heading", { name: "Kitchen board" })).toBeVisible();
  const boardSelect = kitchen.getByLabel(/Status for order/).first();
  await expect(boardSelect).toBeVisible();
  await boardSelect.selectOption({ label: "Ready" });
  await expect(guest.getByRole("heading", { name: "Ready", exact: true })).toBeVisible({
    timeout: 15000,
  });
  expect(guest.url()).toBe(statusUrl);
  expect(door.mail.some((m) => m.subject === "Your order is ready for pickup")).toBe(true);
  await kitchen.screenshot({ path: ".evidence/kitchen-desktop.png", fullPage: true });
  checks.push(
    "kitchen signs in, moves order to Ready; guest updates without reload; both emails sent",
  );
  expect((await kitchen.request.get(`${origin}/api/ordering/admin`)).status()).toBe(403);
  expect((await kitchen.request.get(`${origin}/api/ordering/export?kind=orders`)).status()).toBe(
    403,
  );
  expect((await guest.request.get(`${origin}/api/ordering/orders`)).status()).toBe(401);
  checks.push("kitchen restricted and guest order list protected");
  const item = "20000000-0000-4000-8000-000000000001";
  const choice = "40000000-0000-4000-8000-000000000001";
  const all = await (await owner.request.get(`${origin}/api/ordering/menu`)).json();
  const slot = all.slots.find((s) => s.remaining > 0).id;
  const tampered = await post(guest, "checkout", {
    requestKey: randomUUID(),
    email: "tampered@example.test",
    slotId: slot,
    lines: [{ itemId: item, quantity: 1, choices: [choice], price: 1 }],
    total_cents: 1,
    paid: true,
  });
  expect(tampered.status).toBe(200);
  const stored = (
    await db.query("SELECT total_cents,payment_state FROM orders WHERE email=$1", [
      "tampered@example.test",
    ])
  ).rows[0];
  expect(stored.total_cents).toBe(750);
  expect(stored.payment_state).toBe("pending");
  checks.push("browser price and paid-state tampering ignored");
  const last = randomUUID();
  await db.query("INSERT INTO pickup_slots VALUES($1,now()+interval '3 days',1)", [last]);
  const races = await Promise.all(
    ["a", "b"].map((x) =>
      post(guest, "checkout", {
        requestKey: randomUUID(),
        email: `last-${x}@example.test`,
        slotId: last,
        lines: [{ itemId: item, quantity: 1, choices: [] }],
      }),
    ),
  );
  expect(races.map((r) => r.status).sort()).toEqual([200, 409]);
  checks.push("simultaneous HTTP orders cannot take the same last pickup place");
  for (const n of [1, 2]) {
    const context = await browser.newContext();
    const p = await context.newPage();
    watch(p);
    await p.goto(`${origin}/signin`);
    await p.getByLabel("Email", { exact: true }).fill(`customer-${n}-${randomUUID()}@example.test`);
    await p.getByLabel("Password", { exact: true }).fill("customer-password-123");
    await p.getByRole("button", { name: "Create customer account" }).click();
    await expect(p.getByRole("heading", { name: "My orders" })).toBeVisible();
    if (n === 1) {
      await p.goto(`${origin}/`);
      await p.getByRole("button", { name: "Add Flat white" }).click();
      await p.getByLabel("Email for your order").fill("ignored@example.test");
      await p.getByLabel("Pickup time (UTC)").selectOption({ index: 1 });
      await p.getByRole("button", { name: "Continue to test payment" }).click();
      await p.getByRole("button", { name: "Pay in test mode" }).click();
      await expect(p.getByRole("heading", { name: "New", exact: true })).toBeVisible();
      await p.goto(`${origin}/orders`);
      await expect(p.getByText(/Order \d/)).toBeVisible();
    } else {
      const r = await p.request.get(`${origin}/api/ordering/orders`);
      expect((await r.json()).orders).toHaveLength(0);
      await expect(
        p.getByText("You haven’t placed any orders with this account yet."),
      ).toBeVisible();
    }
    await context.close();
  }
  checks.push("two public customer signups; only the ordering customer sees their order");
  expect((await owner.request.get(`${origin}/api/ordering/export?kind=orders`)).ok()).toBe(true);
  for (const route of ["/", `/status?${new URL(statusUrl).searchParams.toString()}`, "/signin"]) {
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.goto(origin + route);
    await guest.waitForTimeout(500);
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await guest.goto(`${origin}/`);
  await expect(guest.getByRole("heading", { name: "Good food. Your time." })).toBeVisible();
  await guest.screenshot({ path: ".evidence/menu-mobile.png", fullPage: true });
  checks.push("390px layouts have no horizontal overflow");
  expect(errors).toEqual([]);
  checks.push("no browser page errors");
  console.log(JSON.stringify({ checks: checks.length, appPeakMiB: Math.ceil(peak) }, null, 2));
  writeFileSync(
    ".evidence/walk.json",
    JSON.stringify({ ok: true, checks, appPeakMiB: Math.ceil(peak), pageErrors: errors }, null, 2),
  );
} catch (error) {
  writeFileSync(
    ".evidence/walk-failure.json",
    JSON.stringify({ message: error.message, checks }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await stop();
  await door?.close();
  await db.end();
}
