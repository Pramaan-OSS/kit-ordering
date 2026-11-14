// A stand-in for the platform's module door, for tests and the local walk only: email, file storage and the two
// payment capabilities, over a Unix socket with a token, as the running app sees the real one. With a port it also
// serves a marked test payment page and the sent mail. Never part of the app.
// Usage: node scripts/fake-door.mjs <dir> <port>
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const read = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
const send = (res, status, value, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};

export async function startFakeDoor({ dir, port } = {}) {
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(16).toString("hex");
  writeFileSync(path.join(dir, "token"), token);
  const sock = path.join(dir, "modules.sock");
  rmSync(sock, { force: true });
  const door = {
    mail: [],
    files: new Map(),
    checkouts: new Map(),
    emailOn: true,
    filesOn: true,
    paymentsOn: true,
    dropNextCheckout: false,
  };
  const page = (ref) => `http://127.0.0.1:${port ?? 3501}/pay/${ref}`;
  const socket = createServer(async (req, res) => {
    const body = await read(req);
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(res, 401, { error: "MODULE_TOKEN_INVALID" });
    const url = new URL(req.url, "http://door");
    if (url.pathname === "/v1/email" && req.method === "POST") {
      if (!door.emailOn) return send(res, 404, { error: "MODULE_OFF" });
      door.mail.push({ ...JSON.parse(body.toString("utf8")), key: req.headers["idempotency-key"] });
      return send(res, 202, { accepted: true });
    }
    if (url.pathname.startsWith("/v1/files/")) {
      if (!door.filesOn) return send(res, 404, { error: "MODULE_OFF" });
      const key = decodeURIComponent(url.pathname.slice("/v1/files/".length));
      if (req.method === "PUT") {
        door.files.set(key, body);
        return send(res, 201, { key, size: body.length });
      }
      if (req.method === "GET") {
        if (!door.files.has(key)) return send(res, 404, { error: "FILE_NOT_FOUND" });
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(door.files.get(key));
      }
      if (req.method === "DELETE") {
        door.files.delete(key);
        return send(res, 200, { deleted: true });
      }
    }
    if (url.pathname.startsWith("/v1/capabilities/") && req.method === "POST") {
      if (!door.paymentsOn) return send(res, 404, { error: "MODULE_OFF" });
      const input = JSON.parse(body.toString("utf8"));
      if (url.pathname.endsWith("/payments.checkout.create")) {
        if (!req.headers["idempotency-key"])
          return send(res, 400, {
            error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A key is needed." },
          });
        const ref = `ref_${randomBytes(8).toString("hex")}`;
        const total = input.lineItems.reduce((s, i) => s + i.amount * i.quantity, 0);
        door.checkouts.set(ref, { ...input, total, status: "unpaid", payments: [] });
        if (door.dropNextCheckout) {
          door.dropNextCheckout = false;
          res.destroy();
          return;
        }
        return send(res, 200, { ref, checkoutUrl: page(ref) });
      }
      if (url.pathname.endsWith("/payments.checkout.get")) {
        const c = door.checkouts.get(input.ref);
        if (!c)
          return send(res, 404, {
            error: { code: "not_found", message: "The checkout was not found." },
          });
        return send(res, 200, { status: c.status, payments: c.payments });
      }
    }
    send(res, 404, { error: "NOT_FOUND" });
  });
  await new Promise((resolve) => socket.listen(sock, resolve));
  /** Marks a checkout paid as the real service would: one captured payment for its whole amount. */
  door.pay = (ref, amount, currency) => {
    const c = door.checkouts.get(ref);
    c.status = "paid";
    c.payments = [
      {
        ref: `pay_${ref}`,
        status: "captured",
        amount: {
          amount: amount ?? c.total,
          currency: currency ?? c.lineItems[0].currency.toUpperCase(),
        },
      },
    ];
  };
  let web;
  if (port) {
    web = createServer(async (req, res) => {
      const url = new URL(req.url, "http://page");
      if (url.pathname === "/mailbox") return send(res, 200, door.mail);
      const ref = url.pathname.startsWith("/pay/") ? url.pathname.slice(5) : "";
      const c = door.checkouts.get(ref);
      if (!c) return send(res, 404, { error: "not found" });
      if (req.method === "POST") {
        await read(req);
        door.pay(ref);
        res.writeHead(303, { location: c.successUrl });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><title>Test payment page</title><h1>Test payment page</h1><p>Test mode: no money moves.</p><p>Amount due: ${(c.total / 100).toFixed(2)} ${c.lineItems[0].currency.toUpperCase()}</p><form method="post"><button>Pay in test mode</button></form><p><a href="${c.cancelUrl}">Cancel</a></p>`,
      );
    });
    await new Promise((resolve) => web.listen(port, "127.0.0.1", resolve));
  }
  door.close = async () => {
    await new Promise((resolve) => socket.close(resolve));
    if (web) await new Promise((resolve) => web.close(resolve));
  };
  return door;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, port] = process.argv.slice(2);
  await startFakeDoor({ dir: path.resolve(dir), port: Number(port) });
  console.log(`fake door on ${dir}, test payment page on ${port}`);
}
