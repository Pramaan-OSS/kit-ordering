import { randomUUID } from "node:crypto";
import { hashPassword } from "../accounts";
import { database } from "../runtime";
import { HOLDING, transaction } from "./store";
import { fail, id, integer, text } from "./validation";

export async function adminData() {
  const tables = [
    "menu_categories",
    "menu_items",
    "menu_options",
    "menu_choices",
    "opening_hours",
    "pickup_slots",
    "order_statuses",
  ] as const;
  const results = await Promise.all(
    tables.map((t) => database().query(`SELECT * FROM ${t} ORDER BY 1`)),
  );
  return {
    ...Object.fromEntries(tables.map((t, i) => [t, results[i]?.rows ?? []])),
    staff: (
      await database().query("SELECT id,email FROM app_users WHERE role='kitchen' ORDER BY email")
    ).rows,
  };
}
export async function edit(input: Record<string, unknown>) {
  const db = database();
  const recordId = input.id ? id(input.id) : randomUUID();
  switch (input.kind) {
    case "category":
      await db.query(
        "INSERT INTO menu_categories(id,name,position) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,position=$3",
        [recordId, text(input.name, "a category name"), integer(input.position, 0, 1000)],
      );
      break;
    case "item":
      await db.query(
        "INSERT INTO menu_items(id,category_id,name,description,price_cents,sold_out) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET category_id=$2,name=$3,description=$4,price_cents=$5,sold_out=$6",
        [
          recordId,
          id(input.categoryId),
          text(input.name, "an item name"),
          typeof input.description === "string" ? input.description.slice(0, 500) : "",
          integer(input.priceCents, 1),
          input.soldOut === true,
        ],
      );
      break;
    case "option":
      await db.query(
        "INSERT INTO menu_options(id,item_id,name,required) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$3,required=$4",
        [recordId, id(input.itemId), text(input.name, "an option name"), input.required === true],
      );
      break;
    case "choice":
      await db.query(
        "INSERT INTO menu_choices(id,option_id,name,delta_cents) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$3,delta_cents=$4",
        [
          recordId,
          id(input.optionId),
          text(input.name, "a choice name"),
          integer(input.deltaCents, -1000000),
        ],
      );
      break;
    case "hours":
      await db.query("UPDATE opening_hours SET opens=$2,closes=$3,closed=$4 WHERE day=$1", [
        integer(input.day, 0, 6),
        time(input.opens),
        time(input.closes),
        input.closed === true,
      ]);
      break;
    case "slot": {
      const date = new Date(
        text(input.startsAt, "a pickup date and time").replace(
          /^(\d{4}-\d\d-\d\dT\d\d:\d\d)$/,
          "$1:00Z",
        ),
      );
      if (!Number.isFinite(+date) || +date <= Date.now())
        return fail("Choose a future pickup time.");
      await transaction(async (c) => {
        await c.query("SELECT id FROM pickup_slots WHERE id=$1 FOR UPDATE", [recordId]);
        const n = (
          await c.query(
            `SELECT count(*)::int AS n FROM orders o WHERE o.slot_id=$1 AND ${HOLDING}`,
            [recordId],
          )
        ).rows[0].n;
        const cap = integer(input.capacity, 1, 1000);
        if (n > cap) return fail("Capacity cannot be smaller than existing reservations.", 409);
        if (n > 0) {
          const old = (await c.query("SELECT starts_at FROM pickup_slots WHERE id=$1", [recordId]))
            .rows[0];
          if (+new Date(old.starts_at) !== +date)
            return fail("A reserved pickup time cannot be changed.", 409);
        }
        await c.query(
          "INSERT INTO pickup_slots(id,starts_at,capacity) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET starts_at=$2,capacity=$3",
          [recordId, date, cap],
        );
      });
      break;
    }
    case "status":
      await db.query(
        "INSERT INTO order_statuses(id,name,position,is_ready) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,position=$3,is_ready=$4",
        [
          recordId,
          text(input.name, "a status name"),
          integer(input.position, 0, 1000),
          input.isReady === true,
        ],
      );
      break;
    case "delete": {
      const table = {
        category: "menu_categories",
        item: "menu_items",
        option: "menu_options",
        choice: "menu_choices",
        status: "order_statuses",
        slot: "pickup_slots",
      }[String(input.table) as "category"];
      if (!table) return fail("Choose a valid list.");
      await transaction(async (c) => {
        if (table === "order_statuses") {
          await c.query("LOCK TABLE order_statuses IN SHARE ROW EXCLUSIVE MODE");
          const n = await c.query("SELECT count(*)::int AS n FROM order_statuses");
          if (n.rows[0].n <= 1) return fail("Keep at least one order status.", 409);
        }
        // Choices in historic orders are snapshots, so refuse deletion whenever the item's orders exist.
        if (table === "menu_choices" || table === "menu_options") {
          const q =
            table === "menu_options"
              ? `SELECT l.id FROM order_lines l JOIN menu_options op ON op.item_id=l.item_id WHERE op.id=$1 LIMIT 1`
              : `SELECT l.id FROM order_lines l JOIN menu_options op ON op.item_id=l.item_id JOIN menu_choices ch ON ch.option_id=op.id WHERE ch.id=$1 LIMIT 1`;
          if ((await c.query(q, [recordId])).rowCount)
            return fail("This value is in use. Rename it instead.", 409);
        }
        await c.query(`DELETE FROM ${table} WHERE id=$1`, [recordId]);
      }).catch((e) => {
        if (e.code === "23503") return fail("This value is in use. Rename it instead.", 409);
        throw e;
      });
      break;
    }
    case "staff": {
      const email = text(input.email, "a staff email", 320).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email.");
      const password = text(input.password, "a temporary password", 1024);
      if (password.length < 12) return fail("Use at least 12 characters for the password.");
      await db
        .query("INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,$3,'kitchen')", [
          randomUUID(),
          email,
          await hashPassword(password),
        ])
        .catch((e) => {
          if (e.code === "23505") return fail("That email already has an account.", 409);
          throw e;
        });
      break;
    }
    default:
      return fail("Choose a valid action.");
  }
  return { message: "Saved." };
}
function time(v: unknown) {
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v))
    return fail("Enter a valid time.");
  return v;
}
