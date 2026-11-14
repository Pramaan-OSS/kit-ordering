import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "../runtime";
import { fail, id } from "./validation";
export const nonce = () => randomBytes(24).toString("hex");
export function signedLink(order: {
  id: string;
  link_nonce: string;
  link_expires_at: Date | string;
}) {
  const expires = Math.floor(new Date(order.link_expires_at).getTime() / 1000);
  const body = `${order.id}.${expires}.${order.link_nonce}`;
  return `${body}.${createHmac("sha256", sessionSecret()).update(body).digest("hex")}`;
}
export function readLink(token: unknown) {
  if (typeof token !== "string" || token.length > 300)
    return fail("This order link is invalid or has expired.", 404);
  const parts = token.split(".");
  const [orderId = "", expires = "", salt = "", signature = ""] = parts;
  if (
    parts.length !== 4 ||
    !/^\d{10}$/.test(expires) ||
    !/^[a-f0-9]{48}$/.test(salt) ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    Number(expires) <= Date.now() / 1000
  )
    return fail("This order link is invalid or has expired.", 404);
  const expected = createHmac("sha256", sessionSecret())
    .update(parts.slice(0, 3).join("."))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return fail("This order link is invalid or has expired.", 404);
  return { id: id(orderId), nonce: salt };
}
