"use client";
import Image from "next/image";
import { useRef, useState } from "react";
import { api, useResource } from "../lib/pramaan/client";
import { Alert, Button, Card, Field, Select } from "./ui";

type Menu = {
  categories: { id: string; name: string }[];
  items: {
    id: string;
    category_id: string;
    name: string;
    description: string;
    price_cents: number;
    sold_out: boolean;
    has_photo: boolean;
  }[];
  options: { id: string; item_id: string; name: string; required: boolean }[];
  choices: { id: string; option_id: string; name: string; delta_cents: number }[];
  slots: { id: string; starts_at: string; remaining: number }[];
  hours: { day: number; opens: string; closes: string; closed: boolean }[];
};
const money = (n: number) => `£${(n / 100).toFixed(2)}`;
export default function MenuPage() {
  const { data, error, reload } = useResource<Menu>("/api/ordering/menu");
  const [photoErrors, setPhotoErrors] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<
    {
      key: string;
      itemId: string;
      quantity: number;
      choices: string[];
      label: string;
      unit: number;
    }[]
  >([]);
  const [email, setEmail] = useState("");
  const [slot, setSlot] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // One retry key per cart, slot and email, so a double click reuses the same order.
  const attempt = useRef({ cart: "", key: "" });
  async function pay() {
    const current = JSON.stringify([cart, slot, email]);
    if (attempt.current.cart !== current)
      attempt.current = { cart: current, key: crypto.randomUUID() };
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ checkoutUrl?: string; token: string; message?: string }>(
        "/api/ordering/checkout",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            slotId: slot,
            requestKey: attempt.current.key,
            lines: cart.map(({ itemId, quantity, choices }) => ({ itemId, quantity, choices })),
          }),
        },
      );
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else window.location.assign(`/status?token=${encodeURIComponent(result.token)}`);
    } catch (e) {
      setNotice((e as Error).message);
      reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-10">
        <p className="text-sm text-muted">FRESHLY MADE · READY WHEN YOU ARE</p>
        <h1 className="mt-3 text-4xl font-semibold">Good food. Your time.</h1>
        <p className="mt-3 text-muted">
          Choose your favourites, pick a collection time and we’ll take care of the rest.
        </p>
        <p className="mt-2 text-sm text-muted">
          Test ordering · no real money moves. Pickup times are shown in UTC.
        </p>
      </div>
      {error && <Alert tone="error" title={error.message} />}{" "}
      {!data && !error && <p>Loading menu…</p>}
      {data && (
        <div className="grid items-start gap-8 lg:grid-cols-[1fr_22rem]">
          <section aria-label="Menu" className="space-y-8">
            {data.categories.map((cat) => (
              <div key={cat.id}>
                <h2 className="mb-4 text-2xl font-semibold">{cat.name}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {data.items
                    .filter((i) => i.category_id === cat.id)
                    .map((item) => (
                      <Card key={item.id} className="space-y-3 p-5">
                        {item.has_photo && !photoErrors[item.id] && (
                          <Image
                            onError={() => setPhotoErrors((v) => ({ ...v, [item.id]: true }))}
                            unoptimized
                            src={`/api/photos/${item.id}`}
                            alt={item.name}
                            className="h-36 w-full rounded-lg object-cover"
                            width={320}
                            height={144}
                          />
                        )}
                        {photoErrors[item.id] && (
                          <p className="text-sm text-muted">Photo unavailable.</p>
                        )}
                        <div className="flex justify-between gap-3">
                          <h3 className="font-semibold">{item.name}</h3>
                          <span>{money(item.price_cents)}</span>
                        </div>
                        <p className="text-sm text-muted">{item.description}</p>
                        {data.options
                          .filter((o) => o.item_id === item.id)
                          .map((op) => (
                            <Select
                              key={op.id}
                              id={`op-${op.id}`}
                              label={`${op.name}${op.required ? " (required)" : ""}`}
                              value={selected[op.id] ?? ""}
                              onChange={(e) =>
                                setSelected({ ...selected, [op.id]: e.target.value })
                              }
                            >
                              <option value="">
                                Choose {op.required ? "an option" : "or skip"}
                              </option>
                              {data.choices
                                .filter((c) => c.option_id === op.id)
                                .map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name} ({c.delta_cents >= 0 ? "+" : ""}
                                    {money(c.delta_cents)})
                                  </option>
                                ))}
                            </Select>
                          ))}
                        <Button
                          disabled={item.sold_out}
                          onClick={() => {
                            const options = data.options.filter((o) => o.item_id === item.id);
                            if (options.some((o) => o.required && !selected[o.id])) {
                              setNotice("Choose all required options.");
                              return;
                            }
                            const choices = options
                              .map((o) => selected[o.id])
                              .filter((v): v is string => !!v);
                            const extras = data.choices.filter((c) => choices.includes(c.id));
                            setCart([
                              ...cart,
                              {
                                key: crypto.randomUUID(),
                                itemId: item.id,
                                quantity: 1,
                                choices,
                                label: [item.name, ...extras.map((c) => c.name)].join(" · "),
                                unit:
                                  item.price_cents + extras.reduce((n, c) => n + c.delta_cents, 0),
                              },
                            ]);
                            setNotice("");
                          }}
                        >
                          {item.sold_out ? "Sold out" : `Add ${item.name}`}
                        </Button>
                      </Card>
                    ))}
                </div>
              </div>
            ))}
            <details className="text-sm">
              <summary>Opening hours (UTC)</summary>
              {data.hours.map((h) => (
                <p key={h.day}>
                  {
                    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
                      h.day
                    ]
                  }
                  : {h.closed ? "Closed" : `${h.opens.slice(0, 5)}–${h.closes.slice(0, 5)}`}
                </p>
              ))}
            </details>
          </section>
          <Card className="space-y-5 p-6 lg:sticky lg:top-6">
            <h2 className="text-xl font-semibold">Your pickup order</h2>
            {cart.length === 0 ? (
              <p className="text-muted">Your basket is waiting for something good.</p>
            ) : (
              cart.map((line, i) => (
                <div className="flex items-center gap-2" key={line.key}>
                  <p className="flex-1 text-sm">
                    {line.label} · {money(line.unit)}
                  </p>
                  <Button
                    aria-label={`Remove ${line.label}`}
                    onClick={() => setCart(cart.filter((_, n) => n !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))
            )}
            <p className="font-semibold">
              Estimated total {money(cart.reduce((n, l) => n + l.unit * l.quantity, 0))}
            </p>
            <p className="text-xs text-muted">
              The kitchen checks prices and availability at checkout.
            </p>
            <Field
              id="email"
              label="Email for your order"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select
              id="slot"
              label="Pickup time (UTC)"
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
            >
              <option value="">Choose a time</option>
              {data.slots
                .filter((s) => s.remaining > 0)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {new Date(s.starts_at).toLocaleString("en-GB", { timeZone: "UTC" })} ·{" "}
                    {s.remaining} places
                  </option>
                ))}
            </Select>
            {!data.slots.some((s) => s.remaining > 0) && (
              <p>No pickup times available. Please check back soon.</p>
            )}
            <Button
              variant="primary"
              disabled={busy || !cart.length || !slot || !email}
              onClick={() => void pay()}
            >
              {busy ? "Opening checkout…" : "Continue to test payment"}
            </Button>
            <p className="text-xs text-muted">
              Order as a guest, or{" "}
              <a className="underline" href="/signin">
                sign in
              </a>{" "}
              to keep your orders together.
            </p>
            {notice && <Alert title={notice} tone="error" />}
          </Card>
        </div>
      )}
    </main>
  );
}
