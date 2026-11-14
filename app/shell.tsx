"use client";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/pramaan/client";
import { siteName } from "./site";
export function Shell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ role: string } | null>(null);
  useEffect(() => {
    api<{ user: { role: string } }>("/api/account/session").then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);
  return (
    <>
      <header className="border-b border-line bg-surface">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-5 p-5">
          <Link href="/" className="mr-auto font-semibold">
            {siteName}
          </Link>
          <Link href="/">Menu</Link>
          <Link href="/orders">My orders</Link>
          {(user?.role === "owner" || user?.role === "kitchen") && (
            <Link href="/kitchen">Kitchen</Link>
          )}
          {user?.role === "owner" && (
            <>
              <Link href="/manage">Manage</Link>
              <Link href="/owner">Owner settings</Link>
            </>
          )}
          <Link href="/signin">{user ? "Account" : "Sign in"}</Link>
        </nav>
      </header>
      {children}
    </>
  );
}
