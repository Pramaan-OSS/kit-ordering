import { adminData, edit } from "../../../../lib/ordering/admin";
import { exportCsv, importMenu } from "../../../../lib/ordering/csv";
import { checkout, moveOrder, reconcile } from "../../../../lib/ordering/payments";
import { board, menu, orderByLink, orderView, ownOrders } from "../../../../lib/ordering/store";
import { fail, id, text } from "../../../../lib/ordering/validation";
import { handle, readBody, reply } from "../../../../lib/roles/http";
import { accountRuntime, database } from "../../../../lib/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ action: string }> }) {
  return handle(async () => {
    const { action } = await context.params;
    const url = new URL(request.url);
    if (action === "menu") return reply(await menu());
    if (action === "status") {
      const token = url.searchParams.get("token");
      const order = await orderByLink(token);
      return reply(await orderView(order.id));
    }
    const user = await accountRuntime().requireUser(request);
    if (action === "orders") return reply({ orders: await ownOrders(user) });
    if (action === "board") {
      await accountRuntime().requireRole(request, ["owner", "kitchen"]);
      return reply({
        orders: await board(),
        statuses: (await database().query("SELECT * FROM order_statuses ORDER BY position,name"))
          .rows,
      });
    }
    await accountRuntime().requireRole(request, ["owner"]);
    if (action === "admin") return reply(await adminData());
    if (action === "export") {
      const kind = url.searchParams.get("kind") ?? "menu";
      return new Response(await exportCsv(kind), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${kind === "orders" ? "orders" : "menu"}.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    return fail("Page not found.", 404);
  });
}
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  return handle(async () => {
    const input = await readBody(request);
    const { action } = await context.params;
    const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
    if (action === "checkout") {
      let user = null;
      try {
        user = await accountRuntime().requireUser(request);
      } catch (e) {
        if ((e as { status?: number }).status !== 401) throw e;
      }
      if (user && user.role !== "member")
        return fail("Use a customer account or order as a guest.", 403);
      const email = user?.email ?? text(input.email, "your email", 320);
      const key = `order:${email.toLowerCase()}`;
      const n = (
        await database().query(
          `INSERT INTO app_auth_throttle(key,attempts,started_at) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN app_auth_throttle.started_at<now()-interval '1 minute' THEN 1 ELSE app_auth_throttle.attempts+1 END,started_at=CASE WHEN app_auth_throttle.started_at<now()-interval '1 minute' THEN now() ELSE app_auth_throttle.started_at END RETURNING attempts`,
          [key],
        )
      ).rows[0].attempts;
      if (n > 3) return fail("Wait a minute before placing another order.", 429);
      return reply(await checkout(input, user, origin));
    }
    if (action === "reconcile") {
      const o = await reconcile(input.token, origin);
      return reply(await orderView(o.id));
    }
    if (action === "move") {
      await accountRuntime().requireRole(request, ["owner", "kitchen"]);
      return reply(await moveOrder(id(input.orderId), id(input.statusId), origin));
    }
    await accountRuntime().requireRole(request, ["owner"]);
    if (action === "edit") return reply(await edit(input));
    if (action === "import") return reply(await importMenu(text(input.csv, "menu CSV", 12000)));
    return fail("Action not found.", 404);
  });
}
