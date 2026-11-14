// The platform's file storage (docs/contracts/app-modules.md "File storage"): PUT, GET and DELETE /v1/files/<key> on
// the module door. Server only. With file storage off, or outside the running app, nothing is kept, and the caller
// says so plainly.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";

// PRAMAAN_MODULES_DIR exists for tests only.
const dir = () => process.env.PRAMAAN_MODULES_DIR ?? "/pramaan-modules";

export const STORAGE_OFF =
  "File storage isn't switched on for this app yet, so files can't be uploaded or opened.";

export type Stored = { ok: true; body: Buffer } | { ok: false; off: boolean; message: string };

const SAID: Record<string, string> = {
  FILE_TOO_LARGE: "That file is too large to keep.",
  STORAGE_QUOTA_EXCEEDED: "This app's file storage is full. Remove a file before adding more.",
  STORAGE_DISK_LOW: "File storage is full right now. Try again later.",
};

export function storage(
  method: "PUT" | "GET" | "DELETE",
  key: string,
  body?: Buffer,
): Promise<Stored> {
  return new Promise((resolve) => {
    let token: string;
    try {
      token = readFileSync(path.join(dir(), "token"), "utf8").trim();
    } catch {
      resolve({ ok: false, off: true, message: STORAGE_OFF });
      return;
    }
    const headers: Record<string, string | number> = { authorization: `Bearer ${token}` };
    if (body)
      Object.assign(headers, {
        "content-type": "application/octet-stream",
        "content-length": body.byteLength,
      });
    const call = request(
      {
        socketPath: path.join(dir(), "modules.sock"),
        method,
        path: `/v1/files/${encodeURIComponent(key)}`,
        headers,
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const all = Buffer.concat(chunks);
          if (status >= 200 && status < 300) return resolve({ ok: true, body: all });
          let code = "";
          try {
            code = String(JSON.parse(all.toString("utf8")).error ?? "");
          } catch {
            /* no detail */
          }
          resolve({
            ok: false,
            off: code === "MODULE_OFF",
            message:
              code === "MODULE_OFF"
                ? STORAGE_OFF
                : (SAID[code] ?? "File storage couldn't do that. Try again later."),
          });
        });
        response.on("error", () =>
          resolve({ ok: false, off: false, message: "File storage did not answer. Try again." }),
        );
      },
    );
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("error", (error: { code?: string }) =>
      resolve({
        ok: false,
        off: error.code === "ENOENT" || error.code === "ECONNREFUSED",
        message:
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? STORAGE_OFF
            : "File storage did not answer. Try again.",
      }),
    );
    call.end(body);
  });
}
