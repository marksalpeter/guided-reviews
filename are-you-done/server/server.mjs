import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanPerson,
  heartbeat,
  leave,
  markDone,
  openDatabase,
  snapshot,
} from "./store.mjs";

const CODE = /^[a-z0-9-]{3,64}$/;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleRequest(db, req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  const match = url.pathname.match(/^\/v1\/([^/]+)(?:\/(heartbeat|done|leave))?$/);
  if (!match) {
    send(res, 404, { error: "not_found" });
    return;
  }

  const code = decodeURIComponent(match[1] || "").toLowerCase();
  const action = match[2] || "state";
  if (!CODE.test(code)) {
    send(res, 400, { error: "bad_meeting" });
    return;
  }

  if (action === "state") {
    if (req.method !== "GET") {
      send(res, 405, { error: "method" });
      return;
    }
    send(res, 200, snapshot(db, code));
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, { error: "method" });
    return;
  }

  let parsed;
  try {
    const text = await readBody(req);
    parsed = text ? JSON.parse(text) : {};
  } catch {
    send(res, 400, { error: "bad_json" });
    return;
  }

  if (action === "leave") {
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (!id || id.length > 300) {
      send(res, 400, { error: "bad_person" });
      return;
    }
    send(res, 200, leave(db, code, { id }));
    return;
  }

  const person = cleanPerson(parsed);
  if (!person) {
    send(res, 400, { error: "bad_person" });
    return;
  }

  if (action === "heartbeat") send(res, 200, heartbeat(db, code, person));
  else send(res, 200, markDone(db, code, person));
}

export function startServer({ dbPath, port = 8787, host = "127.0.0.1" } = {}) {
  const file = dbPath || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "rooms.sqlite");
  const db = openDatabase(file);
  const server = createServer((req, res) => {
    handleRequest(db, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "server_error" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        db,
        port: typeof address === "object" && address ? address.port : port,
      });
    });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  startServer({ port }).then(({ port: listening }) => {
    console.log(`are you done sync listening on http://127.0.0.1:${listening}`);
  });
}
