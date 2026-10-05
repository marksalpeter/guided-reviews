import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "./server.mjs";
import { heartbeat, markDone, leave, openDatabase } from "./store.mjs";

const require = createRequire(import.meta.url);
const logic = require("../extension/logic.js");

test("meeting codes come from the Meet URL", () => {
  assert.equal(
    logic.meetingCodeFromLocation("https://meet.google.com/abc-defg-hij?authuser=0"),
    "abc-defg-hij",
  );
  assert.equal(
    logic.meetingCodeFromLocation("https://meet.google.com/lookup/AbC123xyz"),
    "abc123xyz",
  );
  assert.equal(logic.meetingCodeFromLocation("https://meet.google.com/landing"), null);
  assert.equal(logic.meetingCodeFromLocation("https://example.com/abc-defg-hij"), null);
});

test("not-done people sort ahead of done people", () => {
  const merged = logic.mergeCall(
    {
      people: [
        { id: "g", name: "Grace Hopper", self: false },
        { id: "a", name: "Ada Lovelace", self: true },
        { id: "k", name: "Katherine Johnson", self: false },
        { id: "t", name: "Alan Turing", self: false },
      ],
    },
    ["g", "t"],
  );
  assert.deepEqual(
    merged.people.map((person) => person.name),
    ["Ada Lovelace", "Katherine Johnson", "Alan Turing", "Grace Hopper"],
  );
  assert.equal(merged.doneCount, 2);
  assert.equal(merged.total, 4);
  assert.equal(merged.percent, 50);
  assert.equal(merged.caption, "2 of 4 are done");
  assert.equal(merged.self?.name, "Ada Lovelace");
  assert.equal(merged.self?.done, false);
});

test("done survives leaving and coming back", () => {
  const dir = fsTemp();
  return dir.then(async (folder) => {
    const db = openDatabase(path.join(folder, "rooms.sqlite"));
    const grace = { id: "devices/grace", name: "Grace Hopper", avatarUrl: "" };
    heartbeat(db, "abc-defg-hij", grace);
    markDone(db, "abc-defg-hij", grace);
    leave(db, "abc-defg-hij", grace);
    const again = heartbeat(db, "abc-defg-hij", grace);
    assert.deepEqual(again.doneIds, ["devices/grace"]);
    await rm(folder, { recursive: true, force: true });
  });
});

test("sync server shares one done set for the meeting code", async () => {
  const folder = await fsTemp();
  const started = await startServer({
    dbPath: path.join(folder, "rooms.sqlite"),
    port: 0,
  });
  const base = `http://127.0.0.1:${started.port}/v1/abc-defg-hij`;
  const ada = { id: "devices/ada", name: "Ada Lovelace", avatarUrl: "https://example.com/a.png" };
  const grace = { id: "devices/grace", name: "Grace Hopper", avatarUrl: "https://example.com/g.png" };

  let response = await fetch(`${base}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ada),
  });
  assert.equal(response.status, 200);
  await fetch(`${base}/done`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(grace),
  });
  response = await fetch(base);
  const body = await response.json();
  assert.deepEqual(body.doneIds, ["devices/grace"]);

  response = await fetch(`${base}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ada),
  });
  const after = await response.json();
  assert.deepEqual(after.doneIds, ["devices/grace"]);
  await new Promise((resolve) => started.server.close(resolve));
  await rm(folder, { recursive: true, force: true });
});

function fsTemp() {
  return mkdtemp(path.join(tmpdir(), "ayd-"));
}
