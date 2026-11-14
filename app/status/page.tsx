"use client";
import { useEffect, useState } from "react";
import { api } from "../../lib/pramaan/client";
import { Alert, Card } from "../ui";

type Order = {
  number: number;
  payment_state: string;
  status: string;
  starts_at: string;
  total_cents: number;
  confirmation_email: string | null;
  ready_email: string | null;
  lines: { description: string; quantity: number; unit_cents: number }[];
};
export default function Status() {
  const [data, setData] = useState<Order>();
  const [error, setError] = useState("");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setError("Open the full order link from your checkout or email.");
      return;
    }
    let active = true;
    async function load() {
      try {
        const r = await api<Order>("/api/ordering/reconcile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (active) {
          setData(r);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <main className="mx-auto max-w-xl space-y-6 px-6 py-12">
      <h1 className="text-3xl font-semibold">Your order</h1>
      {error && <Alert tone="error" title={error} />}{" "}
      {!data && !error && <p>Checking your order…</p>}
      {data && (
        <Card className="space-y-4 p-6">
          <p className="text-muted">Order {data.number}</p>
          <h2 className="text-2xl font-semibold">
            {data.payment_state === "paid"
              ? data.status
              : data.payment_state === "failed"
                ? "Payment unavailable"
                : "Awaiting payment confirmation"}
          </h2>
          <p>
            {data.payment_state === "paid"
              ? "Your order is confirmed. This page updates automatically."
              : "Your order is not confirmed. If payment has not answered, contact the kitchen before placing another order."}
          </p>
          <p>Pickup: {new Date(data.starts_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</p>
          {data.lines.map((l) => (
            <p key={l.description}>
              {l.quantity} × {l.description}
            </p>
          ))}
          <p className="font-semibold">Total £{(data.total_cents / 100).toFixed(2)}</p>
          {data.confirmation_email === "not-sent" && (
            <p>Email is not enabled or could not be sent. Keep this order link.</p>
          )}
          {data.ready_email === "not-sent" && (
            <p>The pickup email could not be sent. Your status above is current.</p>
          )}
          <p className="text-xs text-muted">
            Keep this private link to follow your order. It expires after seven days.
          </p>
        </Card>
      )}
    </main>
  );
}
