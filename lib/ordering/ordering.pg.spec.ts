import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Use a migrated disposable Postgres database in DATABASE_URL.");
const secret = "test-only-secret-".repeat(3);
const origin = "http://localhost";
const dir = mkdtempSync(path.join(tmpdir(), "ordering-door-"));
Object.assign(process.env, {
  DATABASE_URL: url,
  SESSION_SECRET: secret,
  APP_ORIGIN: origin,
  APP_COOKIE_SECURE: "false",
  PRAMAAN_MODULES_DIR: dir,
  PRAMAAN_PAYMENTS_MODE: "test",
  PRAMAAN_PROJECT_ID: "ordering-test",
});
const { startFakeDoor } = await import(
  new URL("../../scripts/fake-door.mjs", import.meta.url).href
);
const route = await import("../../app/api/ordering/[action]/route");
const photo = await import("../../app/api/photos/[id]/route");
const { accountRuntime, database } = await import("../runtime");
const { orderByLink, reserve } = await import("./store");
const { signedLink } = await import("./links");
const { parseCsv, csv } = await import("./csv");
const db = new Pool({ connectionString: url, max: 2 });
// biome-ignore lint/suspicious/noExplicitAny: test stand-in module is plain JavaScript.
let door: any;
let owner = "";
let kitchen = "";
let customer = "";
let other = "";
let customerId = "";
const item = "20000000-0000-4000-8000-000000000001";
const choice = "40000000-0000-4000-8000-000000000001";
const ready = "50000000-0000-4000-8000-000000000003";
async function person(role: string) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,email,role) VALUES($1,$2,$3)", [
    id,
    role === "owner" ? null : `${id}@example.test`,
    role,
  ]);
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [createHmac("sha256", secret).update(token).digest("hex"), id],
  );
  return { id, cookie: `app_session=${token}` };
}
// Midday UTC two days out, one second apart: always inside the seeded opening hours (which close at 23:59) and
// never a duplicate start time, whatever the clock says when the suite runs.
let slots = 0;
async function slot(capacity = 10) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO pickup_slots VALUES($1,date_trunc('day',now(),'UTC')+interval '2 days 12 hours'+$2*interval '1 second',$3)",
    [id, ++slots, capacity],
  );
  return id;
}
const lines = [{ itemId: item, quantity: 1, choices: [choice], unit_cents: 1, price: 1 }];
const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
const post = (action: string, body: unknown, cookie = "") =>
  route.POST(
    new Request(`${origin}/api/ordering/${action}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie },
      // Checkouts carry a fresh cart key unless a test supplies one.
      body: JSON.stringify(
        action === "checkout" ? { requestKey: randomUUID(), ...(body as object) } : body,
      ),
    }),
    ctx(action),
  );
const get = (action: string, cookie = "", query = "") =>
  route.GET(
    new Request(`${origin}/api/ordering/${action}${query}`, { headers: { cookie } }),
    ctx(action),
  );
async function guest(slotId?: string, cookie = "") {
  return (
    await post(
      "checkout",
      {
        email: `${randomUUID()}@example.test`,
        slotId: slotId ?? (await slot()),
        lines,
        total_cents: 1,
        payment_state: "paid",
      },
      cookie,
    )
  ).json();
}
async function paid() {
  const order = await guest();
  const stored = await orderByLink(order.token);
  door.pay(stored.checkout_ref);
  await post("reconcile", { token: order.token });
  return { order, stored };
}
beforeAll(async () => {
  await db.query(
    "TRUNCATE order_line_choices,order_mail,order_lines,orders,pickup_slots,app_sessions,app_owner_passes,app_auth_throttle,app_users CASCADE",
  );
  // A run stopped half-way can leave the menu sold out or the kitchen closed.
  await db.query("UPDATE menu_items SET sold_out=false");
  await db.query("UPDATE opening_hours SET closed=false");
  door = await startFakeDoor({ dir });
  owner = (await person("owner")).cookie;
  kitchen = (await person("kitchen")).cookie;
  const p = await person("member");
  customer = p.cookie;
  customerId = p.id;
  other = (await person("member")).cookie;
});
afterAll(async () => {
  await door?.close();
  await db.end();
  await database().end();
  rmSync(dir, { recursive: true, force: true });
});
describe("ordering through the server routes", () => {
  it("serves the public menu with options, choices and opening hours", async () => {
    const r = await get("menu");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.hours).toHaveLength(7);
    expect(body.choices.some((x: { id: string }) => x.id === choice)).toBe(true);
  });
  it("ignores browser prices and paid flags, storing the server total including options", async () => {
    const result = await guest();
    const stored = await orderByLink(result.token);
    expect(stored.total_cents).toBe(750);
    expect(stored.payment_state).toBe("pending");
    expect(door.checkouts.get(stored.checkout_ref).total).toBe(750);
    expect((await get("board", kitchen)).status).toBe(200);
    const board = await (await get("board", kitchen)).json();
    expect(board.orders.some((o: { id: string }) => o.id === stored.id)).toBe(false);
  });
  it("allows exactly one competing order to take the last place using real Postgres locks", async () => {
    const sid = await slot(1);
    const results = await Promise.all([
      post("checkout", { email: "race-a@example.test", slotId: sid, lines }),
      post("checkout", { email: "race-b@example.test", slotId: sid, lines }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM orders WHERE slot_id=$1 AND payment_state<>'failed'",
          [sid],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("frees a pickup place held by a checkout left unpaid for over 30 minutes", async () => {
    const sid = await slot(1);
    const first = await guest(sid);
    const another = () =>
      post("checkout", { email: `${randomUUID()}@example.test`, slotId: sid, lines });
    expect((await another()).status).toBe(409);
    const stored = await orderByLink(first.token);
    await db.query("UPDATE orders SET created_at=now()-interval '31 minutes' WHERE id=$1", [
      stored.id,
    ]);
    expect((await another()).status).toBe(200);
  });
  it("a double submit with one cart key makes one order; a changed order with that key is refused", async () => {
    const sid = await slot();
    const cart = {
      email: `${randomUUID()}@example.test`,
      slotId: sid,
      lines,
      requestKey: randomUUID(),
    };
    const both = await Promise.all([post("checkout", cart), post("checkout", cart)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const [a, b] = await Promise.all(both.map((r) => r.json()));
    expect(a.token).toBe(b.token);
    expect(
      (await db.query("SELECT count(*)::int AS n FROM orders WHERE email=$1", [cart.email])).rows[0]
        .n,
    ).toBe(1);
    expect((await post("checkout", { ...cart, slotId: await slot() })).status).toBe(409);
  });
  it("requires captured payments for the exact amount and currency; tampered links cannot mark paid", async () => {
    const result = await guest();
    const stored = await orderByLink(result.token);
    for (const [amount, currency] of [
      [1, "GBP"],
      [750, "USD"],
      [751, "GBP"],
    ] as const) {
      door.pay(stored.checkout_ref, amount, currency);
      const r = await (await post("reconcile", { token: result.token, paid: true })).json();
      expect(r.payment_state).toBe("pending");
    }
    door.pay(stored.checkout_ref);
    expect((await (await post("reconcile", { token: result.token })).json()).payment_state).toBe(
      "paid",
    );
    const emails = door.mail.filter((m: { subject: string }) => m.subject.includes("confirmed"));
    expect(emails.length).toBeGreaterThan(0);
  });
  it("moves a paid order to Ready and sends just one pickup email under concurrent updates", async () => {
    const { order, stored } = await paid();
    const before = door.mail.length;
    const rs = await Promise.all([
      post("move", { orderId: stored.id, statusId: ready }, kitchen),
      post("move", { orderId: stored.id, statusId: ready }, kitchen),
    ]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const status = await (await get("status", "", `?token=${order.token}`)).json();
    expect(status.status).toBe("Ready");
    expect(status.email).toBeUndefined();
    expect(door.mail.length - before).toBe(1);
  });
  it("rejects moving an unpaid order", async () => {
    const order = await guest();
    const stored = await orderByLink(order.token);
    expect((await post("move", { orderId: stored.id, statusId: ready }, kitchen)).status).toBe(404);
  });
  it("rejects invalid signatures, expired links and guessed order ids", async () => {
    const result = await guest();
    expect((await get("status", "", `?token=${result.token.slice(0, -1)}z`)).status).toBe(404);
    expect((await get("status", "", `?token=${randomUUID()}`)).status).toBe(404);
    const stored = await orderByLink(result.token);
    const expired = signedLink({ ...stored, link_expires_at: new Date(Date.now() - 10000) });
    expect((await get("status", "", `?token=${expired}`)).status).toBe(404);
    await db.query("UPDATE orders SET link_nonce='revoked' WHERE id=$1", [stored.id]);
    expect((await get("status", "", `?token=${result.token}`)).status).toBe(404);
  });
  it("scopes signed-in customer orders on the server and ignores requested customer ids", async () => {
    const result = await guest(undefined, customer);
    const stored = await orderByLink(result.token);
    expect(stored.customer_id).toBe(customerId);
    const own = await (await get("orders", customer)).json();
    expect(own.orders.some((o: { id: string }) => o.id === stored.id)).toBe(true);
    const stranger = await (await get("orders", other, `?customerId=${customerId}`)).json();
    expect(stranger.orders.some((o: { id: string }) => o.id === stored.id)).toBe(false);
  });
  it("allows only the owner to manage records and exports; kitchen cannot read customer lists", async () => {
    for (const cookie of ["", customer, kitchen]) {
      expect((await get("admin", cookie)).status).toBe(cookie ? 403 : 401);
      expect((await get("export", cookie, "?kind=orders")).status).toBe(cookie ? 403 : 401);
      expect(
        (await post("edit", { kind: "category", name: "Forbidden", position: 0 }, cookie)).status,
      ).toBe(cookie ? 403 : 401);
    }
    expect((await get("board", customer)).status).toBe(403);
    expect((await get("orders", "")).status).toBe(401);
  });
  it("refuses cross-origin writes", async () => {
    const r = await route.POST(
      new Request(`${origin}/api/ordering/edit`, {
        method: "POST",
        headers: {
          origin: "http://evil.invalid",
          "content-type": "application/json",
          cookie: owner,
        },
        body: JSON.stringify({ kind: "category", name: "Bad", position: 0 }),
      }),
      ctx("edit"),
    );
    expect(r.status).toBe(403);
  });
  it("edits statuses but prevents removing a status used by an order", async () => {
    const { stored } = await paid();
    const status = (await db.query("SELECT status_id FROM orders WHERE id=$1", [stored.id])).rows[0]
      .status_id;
    expect(
      (await post("edit", { kind: "delete", table: "status", id: status }, owner)).status,
    ).toBe(409);
    const id = randomUUID();
    expect(
      (await post("edit", { kind: "status", id, name: "Hold", position: 7, isReady: false }, owner))
        .status,
    ).toBe(200);
    expect(
      (
        await post(
          "edit",
          { kind: "status", id, name: "On hold", position: 8, isReady: false },
          owner,
        )
      ).status,
    ).toBe(200);
    expect((await post("edit", { kind: "delete", table: "status", id }, owner)).status).toBe(200);
  });
  it("does not oversell when an owner shrinks a reserved slot or moves its time", async () => {
    const sid = await slot(2);
    await guest(sid);
    await guest(sid);
    const r = (await db.query("SELECT starts_at FROM pickup_slots WHERE id=$1", [sid])).rows[0];
    expect(
      (
        await post(
          "edit",
          { kind: "slot", id: sid, startsAt: new Date(r.starts_at).toISOString(), capacity: 1 },
          owner,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          "edit",
          {
            kind: "slot",
            id: sid,
            startsAt: new Date(Date.now() + 400000000).toISOString(),
            capacity: 2,
          },
          owner,
        )
      ).status,
    ).toBe(409);
  });
  it("rejects sold-out items, choices from other items and closed hours", async () => {
    const sid = await slot();
    await db.query("UPDATE menu_items SET sold_out=true WHERE id=$1", [item]);
    expect(
      (await post("checkout", { email: "soldout@example.test", slotId: sid, lines })).status,
    ).toBe(409);
    await db.query("UPDATE menu_items SET sold_out=false WHERE id=$1", [item]);
    expect(
      (
        await post("checkout", {
          email: "badchoice@example.test",
          slotId: sid,
          lines: [
            { itemId: "20000000-0000-4000-8000-000000000002", quantity: 1, choices: [choice] },
          ],
        })
      ).status,
    ).toBe(400);
    await db.query("UPDATE opening_hours SET closed=true");
    expect(
      (await post("checkout", { email: "closed@example.test", slotId: sid, lines })).status,
    ).toBe(400);
    await db.query("UPDATE opening_hours SET closed=false");
  });
  it("imports options and price changes, exports CSV and rolls back an invalid batch", async () => {
    const source =
      'category,item,description,price_cents,sold_out,option,required,choice,delta_cents\nBakery,Toast,"Warm, crisp",400,false,Spread,true,Jam,50';
    expect((await post("import", { csv: source }, owner)).status).toBe(200);
    const exported = await (await get("export", owner, "?kind=menu")).text();
    expect(exported).toContain('"Warm, crisp"');
    expect(exported).toContain('"Jam","50"');
    const jam = (await db.query("SELECT id FROM menu_choices WHERE name='Jam' LIMIT 1")).rows[0];
    await db.query("UPDATE menu_choices SET delta_cents=-50 WHERE id=$1", [jam.id]);
    const roundTrip = await (await get("export", owner, "?kind=menu")).text();
    expect(roundTrip).toContain('"Jam","-50"');
    expect((await post("import", { csv: roundTrip }, owner)).status).toBe(200);
    expect(
      (await db.query("SELECT delta_cents FROM menu_choices WHERE id=$1", [jam.id])).rows[0]
        .delta_cents,
    ).toBe(-50);
    const broken = `${source.replace("Toast", "Rolled back")}\nBad`;
    expect((await post("import", { csv: broken }, owner)).status).toBe(400);
    expect((await db.query("SELECT id FROM menu_items WHERE name='Rolled back'")).rowCount).toBe(0);
    const orders = await (await get("export", owner, "?kind=orders")).text();
    expect(orders).toContain('"unit_cents"');
  });
  it("shows email unavailable without losing a confirmed order", async () => {
    door.emailOn = false;
    const { order } = await paid();
    const status = await (await get("status", "", `?token=${order.token}`)).json();
    expect(status.payment_state).toBe("paid");
    expect(status.confirmation_email).toBe("not-sent");
    door.emailOn = true;
  });
  it("releases a definitely refused payment reservation; unknown outcomes keep capacity", async () => {
    door.paymentsOn = false;
    const sid = await slot(1);
    const order = await guest(sid);
    expect(order.unavailable).toBe(true);
    expect((await orderByLink(order.token)).payment_state).toBe("failed");
    door.paymentsOn = true;
    expect(
      (await post("checkout", { email: "retry@example.test", slotId: sid, lines })).status,
    ).toBe(200);
  });
  it("keeps the last slot reserved after the payment result becomes unknown", async () => {
    const sid = await slot(1);
    door.dropNextCheckout = true;
    const result = await guest(sid);
    expect(result.unavailable).toBe(true);
    const order = await orderByLink(result.token);
    expect(order.payment_state).toBe("pending");
    expect(
      (await post("checkout", { email: "unknown-again@example.test", slotId: sid, lines })).status,
    ).toBe(409);
  });
  it("refuses payments without a test-mode guard", async () => {
    delete process.env.PRAMAAN_PAYMENTS_MODE;
    expect(
      (await post("checkout", { email: "mode@example.test", slotId: await slot(), lines })).status,
    ).toBe(503);
    process.env.PRAMAAN_PAYMENTS_MODE = "test";
  });
  it("uploads only owner photos through the files module; file-off is explicit", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const params = { params: Promise.resolve({ id: item }) };
    const req = (cookie: string, body: Buffer) =>
      new Request(`${origin}/api/photos/${item}`, {
        method: "POST",
        headers: { origin, cookie },
        body: new Uint8Array(body),
      });
    expect((await photo.POST(req(kitchen, png), params)).status).toBe(403);
    expect((await photo.POST(req(owner, Buffer.from("<svg/>")), params)).status).toBe(400);
    expect((await photo.POST(req(owner, png), params)).status).toBe(200);
    expect((await photo.GET(new Request(`${origin}/api/photos/${item}`), params)).status).toBe(200);
    door.filesOn = false;
    expect((await photo.POST(req(owner, png), params)).status).toBe(503);
    door.filesOn = true;
  });
  it("makes kitchen staff through owner-only creation, then accepts their password sign-in", async () => {
    const email = `staff-${randomUUID()}@example.test`;
    expect(
      (await post("edit", { kind: "staff", email, password: "staff-password-123" }, owner)).status,
    ).toBe(200);
    const r = await accountRuntime().handle(
      new Request(`${origin}/api/account/signin`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password: "staff-password-123" }),
      }),
      "signin",
    );
    expect(r.status).toBe(200);
    expect((await r.json()).user.role).toBe("kitchen");
  });
  it("does not permit guest order claims by supplying a customer id", async () => {
    const sid = await slot();
    const o = await reserve(
      {
        email: "guest-claim@example.test",
        customer_id: customerId,
        slotId: sid,
        lines,
        requestKey: randomUUID(),
      },
      null,
    );
    expect(o.customer_id).toBeNull();
  });
});
describe("CSV format", () => {
  it("escapes formulas and handles quoted newlines", () => {
    expect(csv([["=1+1", 'hi"there']])).toBe('"\'=1+1","hi""there"');
    expect(parseCsv('"a\nb",c\n')).toEqual([["a\nb", "c"]]);
    expect(() => parseCsv('"bad')).toThrow();
  });
});
