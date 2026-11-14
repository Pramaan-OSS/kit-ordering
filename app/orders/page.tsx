"use client";
import { useEffect } from "react";
import { useResource } from "../../lib/pramaan/client";
import { Alert, Card } from "../ui";
export default function Orders() {
  const { data, error, reload } = useResource<{
    orders: {
      id: string;
      number: number;
      status: string;
      payment_state: string;
      starts_at: string;
      total_cents: number;
    }[];
  }>("/api/ordering/orders");
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-6 py-12">
      <h1 className="text-3xl font-semibold">My orders</h1>
      {error && (
        <>
          <Alert tone="error" title={error.message} />
          <a className="underline" href="/signin">
            Sign in to see your orders
          </a>
        </>
      )}
      {data?.orders.length === 0 && <p>You haven’t placed any orders with this account yet.</p>}
      {data?.orders.map((o) => (
        <Card className="space-y-2 p-5" key={o.id}>
          <h2 className="font-semibold">
            Order {o.number} · {o.payment_state === "paid" ? o.status : "Awaiting payment"}
          </h2>
          <p>
            {new Date(o.starts_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC · £
            {(o.total_cents / 100).toFixed(2)}
          </p>
        </Card>
      ))}
    </main>
  );
}
