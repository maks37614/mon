import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

const filename = process.argv[2] || ".env";
if (existsSync(filename))
  throw new Error("Файл конфігурації вже існує; він не буде перезаписаний");
const hash = process.env.MON_SETUP_PASSWORD_HASH || "";
if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash))
  throw new Error(
    "Передайте MON_SETUP_PASSWORD_HASH, отриманий через npm run password",
  );
const origin = process.env.MON_SETUP_ORIGIN || "https://evgen.h00k.top";
if (!/^https:\/\/[a-z0-9.-]+$/.test(origin))
  throw new Error("Некоректна HTTPS-адреса");
const content = [
  "NODE_ENV=production",
  `APP_ORIGIN=${origin}`,
  "HOST=127.0.0.1",
  "PORT=3010",
  "ADMIN_USERNAME=admin",
  `ADMIN_PASSWORD_HASH=${hash}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  `CRON_SECRET=${randomBytes(32).toString("hex")}`,
  "DATA_DIR=/var/lib/evgen-mon",
  "ENABLE_LIVE_TRADING=false",
  "SCHEDULER_MODE=external",
  "BINANCE_WEIGHT_BUDGET=1000",
  "",
].join("\n");
writeFileSync(filename, content, { flag: "wx", mode: 0o600 });
console.log(`Конфігурацію створено: ${filename}. Реальний режим вимкнено.`);
