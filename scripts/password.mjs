import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

async function passwordInput() {
  if (!process.stdin.isTTY || process.argv.includes("--stdin")) {
    let value = "";
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/[\r\n]+$/, "");
  }
  process.stderr.write(
    "Новий пароль входу (12–256 символів, введення приховане): ",
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
    };
    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Скасовано"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " " && value.length < 256) value += character;
      }
    }
    process.stdin.on("data", onData);
  });
}
try {
  const password = await passwordInput();
  if (password.length < 12 || password.length > 256)
    throw new Error("Пароль повинен містити 12–256 символів");
  const salt = randomBytes(16).toString("hex"),
    key = await promisify(scrypt)(password, salt, 64);
  process.stdout.write(`scrypt:${salt}:${key.toString("hex")}\n`);
} catch (e) {
  process.stderr.write(e.message + "\n");
  process.exitCode = 1;
}
