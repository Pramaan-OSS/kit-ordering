import { randomUUID } from "node:crypto";
import { database } from "../runtime";
import { transaction } from "./store";
import { fail, integer, text } from "./validation";
export function parseCsv(source: string) {
  if (source.length > 12000) return fail("Import at most 12,000 characters at a time.");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        if (!quoted && cell !== "") return fail("Check the CSV quotes.");
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" && !quoted) {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) return fail("Close every CSV quote.");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some(Boolean));
}
export function csv(rows: unknown[][]) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          let s = String(cell ?? "");
          if (typeof cell === "string" && /^[\s]*[=+@-]/.test(s)) s = `'${s}`;
          return `"${s.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
export async function importMenu(source: string) {
  const rows = parseCsv(source);
  const header = [
    "category",
    "item",
    "description",
    "price_cents",
    "sold_out",
    "option",
    "required",
    "choice",
    "delta_cents",
  ];
  if (rows[0]?.join(",") !== header.join(","))
    return fail(`Use these CSV columns: ${header.join(", ")}.`);
  const data = rows.slice(1);
  if (data.length < 1 || data.length > 100) return fail("Import between 1 and 100 rows.");
  await transaction(async (c) => {
    for (const row of data) {
      if (row.length !== 9) return fail("Each CSV row needs nine columns.");
      const [
        category = "",
        name = "",
        description = "",
        price = "",
        soldOut = "",
        option = "",
        required = "",
        choice = "",
        delta = "",
      ] = row;
      if (!["true", "false"].includes(soldOut) || !["true", "false", ""].includes(required))
        return fail("Use true or false for flags.");
      const cat = (
        await c.query(
          "INSERT INTO menu_categories(id,name) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id",
          [randomUUID(), text(category, "a category")],
        )
      ).rows[0].id;
      const item = (
        await c.query(
          `INSERT INTO menu_items(id,category_id,name,description,price_cents,sold_out) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(name) DO UPDATE SET category_id=$2,description=$4,price_cents=$5,sold_out=$6 RETURNING id`,
          [
            randomUUID(),
            cat,
            text(name, "an item"),
            description.slice(0, 500),
            integer(price, 1),
            soldOut === "true",
          ],
        )
      ).rows[0].id;
      if (option) {
        const opt = (
          await c.query(
            "INSERT INTO menu_options(id,item_id,name,required) VALUES($1,$2,$3,$4) ON CONFLICT(item_id,name) DO UPDATE SET required=$4 RETURNING id",
            [randomUUID(), item, text(option, "an option"), required === "true"],
          )
        ).rows[0].id;
        if (choice)
          await c.query(
            "INSERT INTO menu_choices(id,option_id,name,delta_cents) VALUES($1,$2,$3,$4) ON CONFLICT(option_id,name) DO UPDATE SET delta_cents=$4",
            [randomUUID(), opt, text(choice, "a choice"), integer(delta, -1000000)],
          );
      } else if (choice) return fail("A choice needs an option.");
    }
  });
  return { message: `Imported ${data.length} menu rows.` };
}
export async function exportCsv(kind: string) {
  if (kind === "menu") {
    const r = await database().query(
      `SELECT c.name AS category,i.name AS item,i.description,i.price_cents,i.sold_out,op.name AS option,op.required,ch.name AS choice,ch.delta_cents FROM menu_items i JOIN menu_categories c ON c.id=i.category_id LEFT JOIN menu_options op ON op.item_id=i.id LEFT JOIN menu_choices ch ON ch.option_id=op.id ORDER BY c.position,i.name,op.name,ch.name`,
    );
    const keys = [
      "category",
      "item",
      "description",
      "price_cents",
      "sold_out",
      "option",
      "required",
      "choice",
      "delta_cents",
    ];
    return csv([keys, ...r.rows.map((r) => keys.map((k) => r[k]))]);
  }
  if (kind !== "orders") return fail("Choose menu or orders.");
  const r = await database().query(
    `SELECT o.number,o.email,p.starts_at,s.name AS status,o.payment_state,o.total_cents,l.description,l.quantity,l.unit_cents FROM orders o JOIN pickup_slots p ON p.id=o.slot_id JOIN order_statuses s ON s.id=o.status_id JOIN order_lines l ON l.order_id=o.id ORDER BY o.number,l.description`,
  );
  const keys = [
    "number",
    "email",
    "starts_at",
    "status",
    "payment_state",
    "total_cents",
    "description",
    "quantity",
    "unit_cents",
  ];
  return csv([
    keys,
    ...r.rows.map((r) => keys.map((k) => (r[k] instanceof Date ? r[k].toISOString() : r[k]))),
  ]);
}
