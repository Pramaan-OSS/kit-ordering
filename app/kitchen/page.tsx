"use client";
import { useEffect, useState } from "react";
import { api, useResource } from "../../lib/pramaan/client";
import { Alert, Card, Select } from "../ui";
export default function Kitchen() {
  const { data, error, reload } = useResource<{
    orders: {
      id: string;
      number: number;
      status_id: string;
      starts_at: string;
      lines: { description: string; quantity: number }[];
    }[];
    statuses: { id: string; name: string }[];
  }>("/api/ordering/board");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [reload]);
  async function move(orderId: string, statusId: string) {
    try {
      await api("/api/ordering/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, statusId }),
      });
      setNotice("");
      reload();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-12">
      <h1 className="text-3xl font-semibold">Kitchen board</h1>
      <p className="text-muted">Paid orders only · updates every three seconds · times in UTC</p>
      {(error || notice) && <Alert title={notice || error?.message || ""} tone="error" />}
      {data?.orders.length === 0 && <p>No confirmed orders yet.</p>}
      <div className="grid gap-5 md:grid-cols-3">
        {data?.orders.map((o) => (
          <Card key={o.id} className="space-y-4 p-5">
            <h2 className="text-xl font-semibold">Order {o.number}</h2>
            <p>{new Date(o.starts_at).toLocaleString("en-GB", { timeZone: "UTC" })}</p>
            {o.lines.map((l) => (
              <p key={l.description}>
                {l.quantity} × {l.description}
              </p>
            ))}
            <Select
              id={`status-${o.id}`}
              label={`Status for order ${o.number}`}
              value={o.status_id}
              onChange={(e) => void move(o.id, e.target.value)}
            >
              {data.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Card>
        ))}
      </div>
    </main>
  );
}
