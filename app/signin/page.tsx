"use client";
import { useState } from "react";
import { api, useResource } from "../../lib/pramaan/client";
import { Alert, Button, Field } from "../ui";
export default function SignIn() {
  const { data } = useResource<{ user: { email: string; role: string } }>("/api/account/session");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: string) {
    setBusy(true);
    setNotice("");
    try {
      const r = await api<{ user: { role: string } }>(`/api/account/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      window.location.assign(
        action === "signout"
          ? "/"
          : r.user.role === "kitchen"
            ? "/kitchen"
            : r.user.role === "owner"
              ? "/manage"
              : "/orders",
      );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-16">
      <h1 className="text-3xl font-semibold">{data ? "Your account" : "Sign in"}</h1>
      {data ? (
        <>
          <p>Signed in as {data.user.email || "the owner"}.</p>
          <Button onClick={() => void act("signout")}>Sign out</Button>
        </>
      ) : (
        <>
          <p>
            Customers can create an account. Kitchen staff use the sign-in details their owner
            provides.
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act("signin");
            }}
          >
            <Field
              id="signin-email"
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Field
              id="signin-password"
              label="Password"
              type="password"
              autoComplete="current-password"
              minLength={12}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy}>
              Sign in
            </Button>{" "}
            <Button disabled={busy} onClick={() => void act("signup")}>
              Create customer account
            </Button>
          </form>
        </>
      )}
      {notice && <Alert title={notice} tone="error" />}
    </main>
  );
}
