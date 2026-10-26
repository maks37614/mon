import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import type { Store } from "./store";
import type { Exchange } from "./config";

const derive = promisify(scrypt);
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256)
    throw new Error("Пароль повинен містити 12–256 символів");
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function checkPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, salt, digest] = encoded.split(":");
  if (
    algorithm !== "scrypt" ||
    !/^[a-f0-9]{32}$/.test(salt || "") ||
    !/^[a-f0-9]{128}$/.test(digest || "") ||
    password.length > 256
  )
    return false;
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}
export const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const safeEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

export class Vault {
  key: Buffer;
  constructor(
    private store: Store,
    encodedKey: string,
  ) {
    this.key = Buffer.from(encodedKey, "base64");
    if (this.key.length !== 32)
      throw new Error(
        "ENCRYPTION_KEY має бути випадковим 32-байтовим ключем у base64",
      );
  }
  save(exchange: Exchange, apiKey: string, secret: string) {
    if (
      !apiKey ||
      !secret ||
      apiKey.length > 512 ||
      secret.length > 512 ||
      /[\r\n]/.test(apiKey + secret)
    )
      throw new Error("Некоректні API-ключі");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`mon:${exchange}`));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ apiKey, secret })),
      cipher.final(),
    ]);
    this.store.set(`credentials:${exchange}`, {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
      verified: false,
    });
  }
  load(exchange: Exchange): { apiKey: string; secret: string } | null {
    const v = this.store.get<any>(`credentials:${exchange}`, null);
    if (!v) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(v.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`mon:${exchange}`));
    decipher.setAuthTag(Buffer.from(v.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(v.data, "base64")),
        decipher.final(),
      ]).toString(),
    );
  }
  status(exchange: Exchange) {
    const v = this.store.get<any>(`credentials:${exchange}`, null);
    return { configured: !!v, verified: v?.verified === true };
  }
  verify(exchange: Exchange) {
    const v = this.store.get<any>(`credentials:${exchange}`, null);
    if (!v) throw new Error("API-ключі не збережено");
    this.store.set(`credentials:${exchange}`, { ...v, verified: true });
  }
  remove(exchange: Exchange) {
    this.store.delete(`credentials:${exchange}`);
  }
}

export class Auth {
  private attempts = new Map<string, { count: number; until: number }>();
  private activeLogins = 0;
  private totalAttempts = { count: 0, until: 0 };
  constructor(
    private store: Store,
    private origin: string,
    private username: string,
    private initialHash: string,
    private secure: boolean,
  ) {}
  session(req: Request) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("mon_session="))
      ?.slice(12);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return null;
    const session = this.store.db
      .prepare("SELECT csrf,expires FROM sessions WHERE token=? AND expires>?")
      .get(digest(cookie), Date.now()) as
      { csrf: string; expires: number } | undefined;
    return session ? { ...session, tokenHash: digest(cookie) } : null;
  }
  issue(res: Response) {
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    this.store.db
      .prepare("DELETE FROM sessions WHERE expires<=?")
      .run(Date.now());
    this.store.db
      .prepare(
        "DELETE FROM sessions WHERE token IN (SELECT token FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 49)",
      )
      .run();
    this.store.db
      .prepare("INSERT INTO sessions VALUES (?,?,?)")
      .run(digest(token), csrf, Date.now() + 12 * 3600_000);
    res.cookie("mon_session", token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: "strict",
      maxAge: 12 * 3600_000,
      path: "/",
    });
    return csrf;
  }
  originGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers.origin !== this.origin || !req.is("application/json"))
        return res
          .status(403)
          .json({ error: "Запит має надходити з цієї панелі у форматі JSON" });
    }
    next();
  };
  require = (req: Request, res: Response, next: NextFunction) => {
    const session = this.session(req);
    if (!session) return res.status(401).json({ error: "Потрібно увійти" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !safeEqual(String(req.headers["x-csrf-token"] || ""), session.csrf)
    )
      return res
        .status(403)
        .json({ error: "Оновіть сторінку та повторіть запит" });
    next();
  };
  login = async (req: Request, res: Response) => {
    const ip = req.ip || "unknown",
      now = Date.now();
    if (this.totalAttempts.until <= now)
      this.totalAttempts = { count: 0, until: now + 60_000 };
    if (this.activeLogins >= 2 || this.totalAttempts.count >= 30)
      return res
        .status(429)
        .json({ error: "Вхід тимчасово обмежено. Спробуйте пізніше" });
    this.totalAttempts.count++;
    let attempt = this.attempts.get(ip);
    if (!attempt || attempt.until <= now) {
      attempt = { count: 0, until: now + 15 * 60_000 };
      this.attempts.set(ip, attempt);
    }
    if (attempt.count >= 5)
      return res
        .status(429)
        .json({ error: "Забагато спроб входу. Спробуйте через 15 хвилин" });
    attempt.count++;
    if (this.attempts.size > 5000)
      for (const [key, value] of this.attempts)
        if (value.until <= now) this.attempts.delete(key);
    if (this.attempts.size > 5000)
      return res.status(429).json({ error: "Вхід тимчасово обмежено" });
    this.activeLogins++;
    try {
      const { username, password } = req.body || {};
      const hash = this.store.get("passwordHash", this.initialHash);
      if (
        typeof password !== "string" ||
        !safeEqual(String(username || ""), this.username) ||
        !(await checkPassword(password, hash))
      )
        return res.status(401).json({ error: "Неправильний логін або пароль" });
      this.attempts.delete(ip);
      res.json({ csrf: this.issue(res), username: this.username });
    } finally {
      this.activeLogins--;
    }
  };
  logout = (req: Request, res: Response) => {
    const session = this.session(req);
    if (session)
      this.store.db
        .prepare("DELETE FROM sessions WHERE token=?")
        .run(session.tokenHash);
    res.clearCookie("mon_session", {
      path: "/",
      secure: this.secure,
      sameSite: "strict",
      httpOnly: true,
    });
    res.json({ ok: true });
  };
  changePassword = async (req: Request, res: Response) => {
    if (
      typeof req.body.currentPassword !== "string" ||
      !(await checkPassword(
        req.body.currentPassword,
        this.store.get("passwordHash", this.initialHash),
      ))
    )
      return res.status(400).json({ error: "Поточний пароль неправильний" });
    const hash = await hashPassword(String(req.body.newPassword || ""));
    this.store.transaction(() => {
      this.store.set("passwordHash", hash);
      this.store.db.exec("DELETE FROM sessions");
    });
    res.json({ csrf: this.issue(res) });
  };
}
