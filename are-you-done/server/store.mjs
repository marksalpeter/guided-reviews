import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PRESENCE_TTL_MS = 8000;

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 4000;
    CREATE TABLE IF NOT EXISTS meetings (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (code, user_id)
    );
    CREATE TABLE IF NOT EXISTS presence (
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (code, user_id)
    );
  `);
  return db;
}

export function cleanAvatar(url) {
  if (typeof url !== "string") return "";
  const value = url.trim();
  if (!value || value.length > 2048) return "";
  if (/^(https?:|data:image\/|blob:)/i.test(value)) return value;
  return "";
}

export function cleanPerson(input) {
  const id = typeof input?.id === "string" ? input.id.trim() : "";
  const name = typeof input?.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!id || id.length > 300 || !name || name.length > 80) return null;
  return { id, name: name.slice(0, 80), avatarUrl: cleanAvatar(input?.avatarUrl) };
}

function ensureMeeting(db, code, now) {
  db.prepare("INSERT INTO meetings (code, created_at) VALUES (?, ?) ON CONFLICT(code) DO NOTHING").run(
    code,
    now,
  );
}

export function doneIds(db, code) {
  return db
    .prepare("SELECT user_id FROM members WHERE code = ? AND done = 1 ORDER BY user_id")
    .all(code)
    .map((row) => String(row.user_id));
}

export function heartbeat(db, code, person, now = Date.now()) {
  ensureMeeting(db, code, now);
  db.prepare(
    `INSERT INTO members (code, user_id, name, avatar_url, done)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(code, user_id) DO UPDATE SET
       name = excluded.name,
       avatar_url = excluded.avatar_url`,
  ).run(code, person.id, person.name, person.avatarUrl);
  db.prepare(
    `INSERT INTO presence (code, user_id, last_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(code, user_id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(code, person.id, now);
  db.prepare("DELETE FROM presence WHERE code = ? AND last_seen < ?").run(code, now - PRESENCE_TTL_MS);
  return { doneIds: doneIds(db, code) };
}

export function markDone(db, code, person, now = Date.now()) {
  heartbeat(db, code, person, now);
  db.prepare("UPDATE members SET done = 1 WHERE code = ? AND user_id = ?").run(code, person.id);
  return { doneIds: doneIds(db, code) };
}

export function leave(db, code, person) {
  db.prepare("DELETE FROM presence WHERE code = ? AND user_id = ?").run(code, person.id);
  return { doneIds: doneIds(db, code) };
}

export function snapshot(db, code) {
  return { doneIds: doneIds(db, code) };
}
