import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../accounts";
import { database } from "../runtime";
import { nonce, readLink, signedLink } from "./links";
import { fail, id, integer, text } from "./validation";

/** Orders that use a pickup place: paid, or awaiting payment for at most 30 minutes, so abandoned checkouts free it. */
export const HOLDING =
  "(o.payment_state='paid' OR (o.payment_state='pending' AND o.created_at>now()-interval '30 minutes'))";
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await database().connect();
  try {
    await c.query("BEGIN");
    const v = await work(c);
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function menu() {
  const db = database();
  const [categories, items, options, choices, hours, slots] = await Promise.all([
    db.query("SELECT * FROM menu_categories ORDER BY position,name"),
    db.query(
      "SELECT id,category_id,name,description,price_cents,sold_out,photo_key IS NOT NULL AS has_photo FROM menu_items ORDER BY name",
    ),
    db.query("SELECT * FROM menu_options ORDER BY name"),
    db.query("SELECT * FROM menu_choices ORDER BY name"),
    db.query("SELECT * FROM opening_hours ORDER BY day"),
    db.query(
      `SELECT s.id,s.starts_at,s.capacity-count(o.id)::int AS remaining FROM pickup_slots s LEFT JOIN orders o ON o.slot_id=s.id AND ${HOLDING} WHERE s.starts_at>now() GROUP BY s.id ORDER BY s.starts_at LIMIT 200`,
    ),
  ]);
  return {
    categories: categories.rows,
    items: items.rows,
    options: options.rows,
    choices: choices.rows,
    hours: hours.rows,
    slots: slots.rows,
  };
}
export type CartLine = { itemId: unknown; quantity: unknown; choices?: unknown };
export async function reserve(input: Record<string, unknown>, user: User | null) {
  const email = user?.email ?? text(input.email, "your email", 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
  const slot = id(input.slotId);
  // One key per cart: a double submit or retry returns the order the first request made.
  const requestKey = id(input.requestKey);
  const raw = input.lines;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20)
    return fail("Add between 1 and 20 items.");
  return transaction(async (c) => {
    const locked = await c.query(
      `SELECT s.*, extract(dow FROM starts_at AT TIME ZONE 'UTC')::int AS day, (starts_at AT TIME ZONE 'UTC')::time AS time FROM pickup_slots s WHERE id=$1 AND starts_at>now() FOR UPDATE`,
      [slot],
    );
    const s = locked.rows[0];
    if (!s) return fail("Choose a future pickup slot.");
    const open = await c.query(
      "SELECT day FROM opening_hours WHERE day=$1 AND NOT closed AND opens<=$2 AND closes>$2",
      [s.day, s.time],
    );
    if (!open.rowCount) return fail("The kitchen is closed at this time.");
    const prior = (await c.query("SELECT * FROM orders WHERE request_key=$1", [requestKey]))
      .rows[0];
    if (prior) {
      if (
        prior.slot_id !== slot ||
        prior.email !== email ||
        prior.customer_id !== (user?.id ?? null)
      )
        return fail("Your order changed. Start the checkout again.", 409);
      return { ...prior, lines: [], token: signedLink(prior), existing: true };
    }
    const count = await c.query(
      `SELECT count(*)::int AS n FROM orders o WHERE o.slot_id=$1 AND ${HOLDING}`,
      [slot],
    );
    if (count.rows[0].n >= s.capacity)
      return fail("That pickup slot is full. Choose another.", 409);
    const lines = [];
    let total = 0;
    for (const value of raw) {
      if (!value || typeof value !== "object") return fail("Check your cart.");
      const line = value as CartLine;
      const itemId = id(line.itemId);
      const quantity = integer(line.quantity, 1, 20);
      const item = (await c.query("SELECT * FROM menu_items WHERE id=$1 FOR SHARE", [itemId]))
        .rows[0];
      if (!item || item.sold_out) return fail("An item is sold out. Refresh the menu.", 409);
      const options = (
        await c.query("SELECT * FROM menu_options WHERE item_id=$1 FOR SHARE", [itemId])
      ).rows;
      const choices = (
        await c.query(
          "SELECT ch.* FROM menu_choices ch JOIN menu_options op ON op.id=ch.option_id WHERE op.item_id=$1 FOR SHARE OF ch",
          [itemId],
        )
      ).rows;
      if (line.choices !== undefined && !Array.isArray(line.choices))
        return fail("Choose valid options.");
      const selected = (line.choices ?? []) as unknown[];
      if (selected.length > options.length || new Set(selected).size !== selected.length)
        return fail("Choose one choice per option.");
      let unit = item.price_cents;
      const names = [item.name];
      const used = new Set<string>();
      for (const ch of selected) {
        const choice = choices.find((x) => x.id === ch);
        if (!choice || used.has(choice.option_id))
          return fail("Choose one valid choice per option.");
        used.add(choice.option_id);
        unit += choice.delta_cents;
        names.push(choice.name);
      }
      if (options.some((o) => o.required && !used.has(o.id)))
        return fail("Choose all required options.");
      if (unit < 1) return fail("This combination is unavailable.");
      total += unit * quantity;
      lines.push({
        choices: selected as string[],
        itemId,
        quantity,
        unit,
        description: names.join(" · "),
      });
    }
    if (total > 100000000) return fail("Your order is too large.");
    const status = (
      await c.query("SELECT id FROM order_statuses ORDER BY position,name LIMIT 1 FOR SHARE")
    ).rows[0];
    if (!status) return fail("The kitchen has no order statuses.", 503);
    const orderId = randomUUID();
    const order = (
      await c.query(
        `INSERT INTO orders(id,customer_id,email,slot_id,status_id,total_cents,checkout_key,link_nonce,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          orderId,
          user?.id ?? null,
          email,
          slot,
          status.id,
          total,
          randomUUID(),
          nonce(),
          requestKey,
        ],
      )
    ).rows[0];
    for (const l of lines) {
      const lineId = randomUUID();
      await c.query(
        "INSERT INTO order_lines(id,order_id,item_id,description,quantity,unit_cents) VALUES($1,$2,$3,$4,$5,$6)",
        [lineId, orderId, l.itemId, l.description, l.quantity, l.unit],
      );
      for (const choiceId of l.choices)
        await c.query("INSERT INTO order_line_choices VALUES($1,$2)", [lineId, choiceId]);
    }
    return { ...order, lines, token: signedLink(order), existing: false };
  });
}
export async function orderByLink(token: unknown) {
  const link = readLink(token);
  const result = await database().query(
    "SELECT * FROM orders WHERE id=$1 AND link_nonce=$2 AND link_expires_at>now()",
    [link.id, link.nonce],
  );
  if (!result.rows[0]) return fail("This order link is invalid or has expired.", 404);
  return result.rows[0];
}
export async function orderView(orderId: string) {
  const order = (
    await database().query(
      `SELECT o.number,o.payment_state,o.total_cents,s.name AS status,p.starts_at,(SELECT delivery FROM order_mail WHERE order_id=o.id AND kind='confirmed') AS confirmation_email,(SELECT delivery FROM order_mail WHERE order_id=o.id AND kind='ready') AS ready_email FROM orders o JOIN order_statuses s ON s.id=o.status_id JOIN pickup_slots p ON p.id=o.slot_id WHERE o.id=$1`,
      [orderId],
    )
  ).rows[0];
  const lines = (
    await database().query(
      "SELECT description,quantity,unit_cents FROM order_lines WHERE order_id=$1 ORDER BY description",
      [orderId],
    )
  ).rows;
  return { ...order, lines };
}
export async function ownOrders(user: User) {
  return (
    await database().query(
      `SELECT o.id,o.number,s.name AS status,o.payment_state,o.total_cents,p.starts_at FROM orders o JOIN order_statuses s ON s.id=o.status_id JOIN pickup_slots p ON p.id=o.slot_id WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [user.id],
    )
  ).rows;
}
export async function board() {
  return (
    await database().query(
      `SELECT o.id,o.number,s.name AS status,o.status_id,p.starts_at,coalesce(json_agg(json_build_object('description',l.description,'quantity',l.quantity)),'[]') AS lines FROM orders o JOIN order_statuses s ON s.id=o.status_id JOIN pickup_slots p ON p.id=o.slot_id JOIN order_lines l ON l.order_id=o.id WHERE o.payment_state='paid' GROUP BY o.id,s.name,p.starts_at ORDER BY p.starts_at,o.number LIMIT 200`,
    )
  ).rows;
}
