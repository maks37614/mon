import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, "mon.sqlite");
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);",
    );
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : structuredClone(fallback);
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  delete(key: string) {
    this.db.prepare("DELETE FROM kv WHERE key=?").run(key);
  }
  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  log(level: string, message: string) {
    const logs = this.get<any[]>("logs", []);
    logs.unshift({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    this.set("logs", logs.slice(0, 400));
  }
  close() {
    this.db.close();
  }
}

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {});
    return result;
  }
}
