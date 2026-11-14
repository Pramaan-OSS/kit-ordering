import { randomUUID } from "node:crypto";
import type { User } from "../accounts";
import { emailDoor } from "../email";
import { pramaan } from "../pramaan";
import { database } from "../runtime";
import { signedLink } from "./links";
import { orderByLink, reserve, transaction } from "./store";
import { fail } from "./validation";

export async function sendMail(orderId: string, kind: "confirmed" | "ready", origin: string) {
  const c = database();
  const inserted = await c.query(
    `INSERT INTO order_mail(id,order_id,kind,delivery) VALUES($1,$2,$3,'sending') ON CONFLICT(order_id,kind) DO NOTHING RETURNING id`,
    [randomUUID(), orderId, kind],
  );
  if (!inserted.rowCount) return;
  const order = (await c.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
  const result = await emailDoor.send(
    {
      to: order.email,
      subject:
        kind === "ready" ? "Your order is ready for pickup" : "Your pickup order is confirmed",
      text: `Order ${order.number}: ${kind === "ready" ? "ready for pickup" : "confirmed"}. View your order: ${origin}/status?token=${signedLink(order)}`,
    },
    inserted.rows[0].id,
  );
  await c.query("UPDATE order_mail SET delivery=$2 WHERE id=$1", [
    inserted.rows[0].id,
    result.status,
  ]);
}
export async function checkout(input: Record<string, unknown>, user: User | null, origin: string) {
  // The connected account must be provisioned in test mode by the platform; this kit never enables real charges.
  if (process.env.PRAMAAN_PAYMENTS_MODE !== "test")
    return fail("Test payments are not enabled for this app. No order was placed.", 503);
  const order = await reserve(input, user);
  if (order.existing)
    return order.checkout_url
      ? { token: order.token, checkoutUrl: order.checkout_url }
      : {
          token: order.token,
          message: "This order was already placed. Check its status before trying again.",
          unavailable: true,
        };
  const back = `${origin}/status?token=${order.token}`;
  const answer = await pramaan.call<{ ref?: string; checkoutUrl?: string }>(
    "payments.checkout.create",
    {
      lineItems: order.lines.map((l: { description: string; unit: number; quantity: number }) => ({
        name: l.description,
        amount: l.unit,
        currency: "gbp",
        quantity: l.quantity,
      })),
      mode: "payment",
      customerEmail: order.email,
      successUrl: back,
      cancelUrl: back,
    },
    order.checkout_key,
  );
  if (!answer.ok) {
    // A definite refusal has no charge and frees the capacity. Unknown results stay reserved for reconciliation.
    if (answer.off)
      await database().query("UPDATE orders SET payment_state='failed' WHERE id=$1", [order.id]);
    return {
      token: order.token,
      message: answer.unknown
        ? "Payment has not answered yet. Your pickup place is held; please contact the kitchen before trying again."
        : "Test payments are unavailable. Nothing was confirmed.",
      unavailable: true,
    };
  }
  const { ref, checkoutUrl } = answer.value;
  let safe = false;
  try {
    const u = new URL(checkoutUrl ?? "");
    safe =
      !u.username &&
      !u.password &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)));
  } catch {}
  if (typeof ref !== "string" || !ref || ref.length > 500 || !safe)
    return {
      token: order.token,
      message:
        "The payment page could not be verified. Your pickup place is held; contact the kitchen.",
      unavailable: true,
    };
  await database().query("UPDATE orders SET checkout_ref=$2,checkout_url=$3 WHERE id=$1", [
    order.id,
    ref,
    checkoutUrl,
  ]);
  return { token: order.token, checkoutUrl };
}
type Result = {
  status?: string;
  payments?: { ref?: string; status?: string; amount?: { amount?: number; currency?: string } }[];
};
export async function reconcile(token: unknown, origin: string) {
  const order = await orderByLink(token);
  if (order.payment_state !== "pending" || !order.checkout_ref) return order;
  const answer = await pramaan.call<Result>("payments.checkout.get", { ref: order.checkout_ref });
  if (!answer.ok || answer.value.status !== "paid" || !Array.isArray(answer.value.payments))
    return order;
  const captured = answer.value.payments.filter(
    (p) =>
      p.status === "captured" &&
      p.amount?.currency?.toLowerCase() === "gbp" &&
      Number.isSafeInteger(p.amount?.amount) &&
      (p.amount?.amount ?? 0) > 0,
  );
  const refs = captured.map((p) => p.ref);
  if (
    captured.length === 0 ||
    refs.some((r) => typeof r !== "string" || !r) ||
    new Set(refs).size !== refs.length ||
    captured.reduce((n, p) => n + (p.amount?.amount ?? 0), 0) !== order.total_cents
  )
    return order;
  // ponytail: a payment captured after the 30-minute hold is still honoured, so a slot can exceed capacity by
  // such late payers; add a review state the owner resolves if that happens in practice.
  const changed = await database().query(
    "UPDATE orders SET payment_state='paid',paid_at=now() WHERE id=$1 AND payment_state='pending' RETURNING id",
    [order.id],
  );
  if (changed.rowCount) await sendMail(order.id, "confirmed", origin);
  return { ...order, payment_state: "paid" };
}
export async function moveOrder(orderId: string, statusId: string, origin: string) {
  const ready = await transaction(async (c) => {
    const o = (
      await c.query(
        "SELECT id,status_id FROM orders WHERE id=$1 AND payment_state='paid' FOR UPDATE",
        [orderId],
      )
    ).rows[0];
    if (!o) return fail("Order not found.", 404);
    const s = (
      await c.query("SELECT id,is_ready FROM order_statuses WHERE id=$1 FOR SHARE", [statusId])
    ).rows[0];
    if (!s) return fail("Choose an order status.");
    await c.query("UPDATE orders SET status_id=$2 WHERE id=$1", [orderId, statusId]);
    return s.is_ready;
  });
  if (ready) await sendMail(orderId, "ready", origin);
  return { message: "Order updated." };
}
