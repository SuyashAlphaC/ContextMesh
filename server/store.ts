import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { State, AuditEvent } from "../shared/types.js";

export function seed(): State {
  return {
    projects: [
      {
        id: "greencart",
        name: "GreenCart redesign",
        client: "GreenCart Studio",
        amountCents: 200000,
        currency: "USD",
        status: "unpaid",
      },
      {
        id: "northstar",
        name: "Northstar brand system",
        client: "Northstar Co.",
        amountCents: 350000,
        currency: "USD",
        status: "unpaid",
      },
      {
        id: "fieldnotes",
        name: "Fieldnotes website",
        client: "Fieldnotes",
        amountCents: 120000,
        currency: "USD",
        status: "unpaid",
      },
    ],
    recipients: [
      {
        id: "maya",
        name: "Maya Chen",
        role: "Product designer",
        email: process.env.PAYPAL_MAYA_EMAIL || "maya@example.com",
        trusted: true,
        accountVersion: 1,
      },
      {
        id: "arjun",
        name: "Arjun Rao",
        role: "Developer",
        email: process.env.PAYPAL_ARJUN_EMAIL || "arjun@example.com",
        trusted: true,
        accountVersion: 1,
      },
    ],
    plans: [],
    webhookIds: [],
    graphRevision: 1,
    events: [
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: "workspace",
        title: "Your financial workspace is ready",
        detail:
          "Three projects and two collaborators. Every decision starts with context.",
      },
    ],
  };
}
export class Store {
  db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    if (!this.db.prepare("SELECT id FROM workspace WHERE id=1").get())
      this.save(seed());
  }
  read(): State {
    const row = this.db
      .prepare("SELECT json FROM workspace WHERE id=1")
      .get() as { json: string };
    return JSON.parse(row.json);
  }
  save(state: State) {
    this.db
      .prepare(
        "INSERT INTO workspace(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(JSON.stringify(state));
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
  close() {
    this.db.close();
  }
}
export function audit(state: State, event: Omit<AuditEvent, "id" | "at">) {
  state.events.unshift({
    ...event,
    id: randomUUID(),
    at: new Date().toISOString(),
  });
  state.graphRevision++;
}
