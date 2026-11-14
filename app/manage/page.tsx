"use client";
import { useState } from "react";
import { api, useResource } from "../../lib/pramaan/client";
import { Alert, Button, Card, Field, Select, Textarea } from "../ui";

type Row = { id: string; name: string; [key: string]: string | number | boolean };
type Data = {
  menu_categories: Row[];
  menu_items: Row[];
  menu_options: Row[];
  menu_choices: Row[];
  order_statuses: Row[];
  pickup_slots: Row[];
  opening_hours: Row[];
  staff: Row[];
};
export default function Manage() {
  const { data, error, reload } = useResource<Data>("/api/ordering/admin");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState("");
  async function save(input: Record<string, unknown>, action = "edit") {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/api/ordering/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      setNotice(r.message);
      reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function form(kind: string, fields: React.ReactNode, row?: Row) {
    return (
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const input: Record<string, unknown> = Object.fromEntries(f);
          for (const b of ["soldOut", "required", "closed", "isReady"])
            input[b] = f.get(b) === "on";
          void save({ ...input, kind, ...(row ? { id: row.id } : {}) });
        }}
      >
        {fields}
        <Button type="submit" disabled={busy} variant="primary">
          {row ? "Save changes" : `Add ${kind}`}
        </Button>
      </form>
    );
  }
  let fieldIndex = 0;
  function input(label: string, name: string, value: unknown = "", type = "text") {
    return (
      <Field
        id={`manage-${fieldIndex++}`}
        label={label}
        name={name}
        type={type}
        defaultValue={String(value)}
        required
      />
    );
  }
  function choose(label: string, name: string, rows: Row[], selected: unknown = "") {
    return (
      <Select
        id={`manage-${fieldIndex++}`}
        label={label}
        name={name}
        defaultValue={String(selected)}
        required
      >
        <option value="">Choose</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name || new Date(String(r.starts_at)).toLocaleString("en-GB", { timeZone: "UTC" })}
          </option>
        ))}
      </Select>
    );
  }
  function flag(label: string, name: string, checked: unknown = false) {
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" name={name} defaultChecked={checked === true} />
        {label}
      </label>
    );
  }
  function remove(table: string, row: Row) {
    return (
      <Button disabled={busy} onClick={() => void save({ kind: "delete", table, id: row.id })}>
        Remove {row.name || "slot"}
      </Button>
    );
  }
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="text-3xl font-semibold">Manage the kitchen</h1>
      {error && <Alert title={error.message} tone="error" />}
      {notice && <Alert title={notice} />} {!data && !error && <p>Loading…</p>}
      {data && (
        <>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Menu categories</h2>
            {form(
              "category",
              <>
                {input("Category name", "name")}
                {input("Display order", "position", 0, "number")}
              </>,
            )}
            {data.menu_categories.map((r) => (
              <details key={r.id}>
                <summary>{r.name}</summary>
                {form(
                  "category",
                  <>
                    {input("Category name", "name", r.name)}
                    {input("Display order", "position", r.position, "number")}
                  </>,
                  r,
                )}
                {remove("category", r)}
              </details>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Menu items</h2>
            {form(
              "item",
              <>
                {choose("Category", "categoryId", data.menu_categories)}
                {input("Item name", "name")}
                {input("Description", "description")}
                {input("Price in pence", "priceCents", 500, "number")}
                {flag("Sold out", "soldOut")}
              </>,
            )}
            {data.menu_items.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.name}
                  {r.sold_out ? " · Sold out" : ""}
                </summary>
                {form(
                  "item",
                  <>
                    {choose("Category", "categoryId", data.menu_categories, r.category_id)}
                    {input("Item name", "name", r.name)}
                    {input("Description", "description", r.description)}
                    {input("Price in pence", "priceCents", r.price_cents, "number")}
                    {flag("Sold out", "soldOut", r.sold_out)}
                  </>,
                  r,
                )}
                <label className="block py-4">
                  Item photo (PNG or JPEG, under 2 MB)
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={busy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setBusy(true);
                      try {
                        await api(`/api/photos/${r.id}`, { method: "POST", body: file });
                        setNotice("Photo saved.");
                        reload();
                      } catch (e) {
                        setNotice((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </label>
                {remove("item", r)}
              </details>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Options and choices</h2>
            {form(
              "option",
              <>
                {choose("Item", "itemId", data.menu_items)}
                {input("Option name", "name")}
                {flag("Required", "required")}
              </>,
            )}
            {data.menu_options.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.name} · {data.menu_items.find((i) => i.id === r.item_id)?.name}
                </summary>
                {form(
                  "option",
                  <>
                    <input type="hidden" name="itemId" value={String(r.item_id)} />
                    {input("Option name", "name", r.name)}
                    {flag("Required", "required", r.required)}
                  </>,
                  r,
                )}
                {remove("option", r)}
              </details>
            ))}
            {form(
              "choice",
              <>
                {choose("Option", "optionId", data.menu_options)}
                {input("Choice name", "name")}
                {input("Price change in pence", "deltaCents", 0, "number")}
              </>,
            )}
            {data.menu_choices.map((r) => (
              <details key={r.id}>
                <summary>{r.name}</summary>
                {form(
                  "choice",
                  <>
                    <input type="hidden" name="optionId" value={String(r.option_id)} />
                    {input("Choice name", "name", r.name)}
                    {input("Price change in pence", "deltaCents", r.delta_cents, "number")}
                  </>,
                  r,
                )}
                {remove("choice", r)}
              </details>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Opening hours (UTC)</h2>
            {data.opening_hours.map((r) => (
              <details key={String(r.day)}>
                <summary>
                  {
                    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
                      Number(r.day)
                    ]
                  }
                </summary>
                {form(
                  "hours",
                  <>
                    <input type="hidden" name="day" value={String(r.day)} />
                    {input("Opens", "opens", String(r.opens).slice(0, 5), "time")}
                    {input("Closes", "closes", String(r.closes).slice(0, 5), "time")}
                    {flag("Closed", "closed", r.closed)}
                  </>,
                )}
              </details>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Pickup slots (UTC)</h2>
            <p>
              One order takes one place. Unconfirmed payments hold their place until reconciled.
            </p>
            {form(
              "slot",
              <>
                {input("Pickup time (UTC)", "startsAt", "", "datetime-local")}
                {input("Order capacity", "capacity", 10, "number")}
              </>,
            )}
            {data.pickup_slots.map((r) => (
              <details key={r.id}>
                <summary>
                  {new Date(String(r.starts_at)).toLocaleString("en-GB", { timeZone: "UTC" })} ·{" "}
                  {r.capacity} places
                </summary>
                {form(
                  "slot",
                  <>
                    {input(
                      "Pickup time (UTC)",
                      "startsAt",
                      new Date(String(r.starts_at)).toISOString().slice(0, 16),
                      "datetime-local",
                    )}
                    {input("Order capacity", "capacity", r.capacity, "number")}
                  </>,
                  r,
                )}
                {remove("slot", r)}
              </details>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Order statuses</h2>
            {form(
              "status",
              <>
                {input("Status name", "name")}
                {input("Display order", "position", 0, "number")}
                {flag("Send ready-for-pickup email", "isReady")}
              </>,
            )}
            {data.order_statuses.map((r) => (
              <details key={r.id}>
                <summary>{r.name}</summary>
                {form(
                  "status",
                  <>
                    {input("Status name", "name", r.name)}
                    {input("Display order", "position", r.position, "number")}
                    {flag("Send ready-for-pickup email", "isReady", r.is_ready)}
                  </>,
                  r,
                )}
                {remove("status", r)}
              </details>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Kitchen staff</h2>
            <p>
              Staff sign in with the email and temporary password you provide. Their access is
              limited to the order board.
            </p>
            {form(
              "staff",
              <>
                {input("Staff email", "email", "", "email")}
                {input("Temporary password (12+ characters)", "password", "", "password")}
              </>,
            )}
            {data.staff.map((s) => (
              <p key={s.id}>{s.email}</p>
            ))}
          </Card>
          <Card className="space-y-4 p-6">
            <h2 className="text-xl font-semibold">Import and export</h2>
            <p>
              <a href="/api/ordering/export?kind=menu" className="underline">
                Export menu CSV
              </a>{" "}
              ·{" "}
              <a href="/api/ordering/export?kind=orders" className="underline">
                Export orders CSV
              </a>
            </p>
            <p>
              Export the menu for the column format. Import updates items by name and includes their
              options and choices.
            </p>
            <label>
              Choose a menu CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 12000) {
                      setNotice("Import at most 12,000 characters at a time.");
                      return;
                    }
                    setCsv(await f.text());
                  }
                }}
              />
            </label>
            <Textarea
              id="csv"
              label="Menu CSV"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
            <Button disabled={busy || !csv} onClick={() => void save({ csv }, "import")}>
              Import menu
            </Button>
          </Card>
        </>
      )}
    </main>
  );
}
