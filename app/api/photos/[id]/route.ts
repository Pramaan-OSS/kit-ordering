import { randomUUID } from "node:crypto";
import { storage } from "../../../../lib/ordering/storage";
import { fail, id } from "../../../../lib/ordering/validation";
import { handle, reply } from "../../../../lib/roles/http";
import { accountRuntime, database } from "../../../../lib/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_r: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const item = (
      await database().query("SELECT photo_key FROM menu_items WHERE id=$1", [
        id((await ctx.params).id),
      ])
    ).rows[0];
    if (!item?.photo_key) return fail("Photo not found.", 404);
    const result = await storage("GET", item.photo_key);
    if (!result.ok) return reply({ error: result.message }, 503);
    return new Response(new Uint8Array(result.body), {
      headers: {
        "content-type": item.photo_key.endsWith(".png") ? "image/png" : "image/jpeg",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
}
export async function POST(r: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await accountRuntime().requireRole(r, ["owner"]);
    if (r.headers.get("origin") !== (process.env.APP_ORIGIN ?? new URL(r.url).origin))
      return fail("Refresh and try again.", 403);
    const itemId = id((await ctx.params).id);
    if (!(await database().query("SELECT id FROM menu_items WHERE id=$1", [itemId])).rowCount)
      return fail("Item not found.", 404);
    const reader = r.body?.getReader();
    if (!reader) return fail("Choose a photo.");
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const v = await reader.read();
        if (v.done) break;
        bytes += v.value.length;
        if (bytes > 2000000) {
          await reader.cancel();
          return fail("Use a photo under 2 MB.", 413);
        }
        parts.push(v.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(parts);
    const png = body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = body[0] === 255 && body[1] === 216 && body[2] === 255;
    if (!png && !jpg) return fail("Choose a PNG or JPEG photo.");
    const key = `menu/${itemId}/${randomUUID()}.${png ? "png" : "jpg"}`;
    const stored = await storage("PUT", key, body);
    if (!stored.ok) return reply({ error: stored.message }, 503);
    await database().query("UPDATE menu_items SET photo_key=$2 WHERE id=$1", [itemId, key]);
    return reply({ message: "Photo saved." });
  });
}
