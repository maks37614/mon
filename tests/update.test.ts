import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const updateScript = path.resolve("deploy/update-docker.sh");
const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const updateTest = (name: string, fn: (t: TestContext) => void) => test(name,
  { skip: gitAvailable ? false : "Deployment update fixtures require Git; the application build image does not need it" }, fn);
const branch = "codex/ovh-trading-terminal-20261025";
const initial = "const version = 1;\nconst heading = 'EVGEN';\nconst footer = 'EVGEN';\n";
const incoming = initial.replace("version = 1", "version = 2");

function fixture(t: any) {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-update-"));
  const origin = path.join(directory, "origin.git"), repo = path.join(directory, "repo"), temp = path.join(directory, "tmp");
  mkdirSync(repo); mkdirSync(temp);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Update fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Update fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }
  git("init", "--bare", origin);
  git("init", "-b", branch);
  mkdirSync(path.join(repo, "src")); mkdirSync(path.join(repo, "deploy"));
  writeFileSync(path.join(repo, "src/App.tsx"), initial);
  writeFileSync(path.join(repo, "src/Header.tsx"), "original header\n");
  writeFileSync(path.join(repo, "deploy/install-docker.sh"), "#!/bin/bash\ntouch installer-was-executed\nexit 99\n");
  git("add", "."); git("commit", "-m", "initial");
  const base = git("rev-parse", "HEAD");
  git("remote", "add", "origin", origin);
  writeFileSync(path.join(repo, "src/App.tsx"), incoming);
  git("add", "."); git("commit", "-m", "upstream fix");
  const target = git("rev-parse", "HEAD");
  git("push", "origin", branch);
  git("reset", "--hard", base);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const read = (file: string) => readFileSync(path.join(repo, file), "utf8");
  const write = (file: string, content: string) => writeFileSync(path.join(repo, file), content);
  const run = () => spawnSync("bash", [updateScript, repo, "--prepare-only"], { cwd: repo,
    env: { ...env, TMPDIR: temp }, encoding: "utf8" });
  return { repo, directory, git, base, target, read, write, run };
}

updateTest("VPS update preserves staged App, other local files and untracked configuration, and is repeatable", t => {
  const f = fixture(t);
  f.write("src/App.tsx", initial.replace("footer = 'EVGEN'", "footer = 'h00k'"));
  f.git("add", "src/App.tsx");
  f.write("src/Header.tsx", "custom header\n");
  f.write(".env", "FIXTURE_CONFIGURATION=keep\n");
  f.write("local-notes.txt", "keep my notes\n");
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git("rev-parse", "HEAD"), f.target);
    assert.equal(f.read("src/App.tsx"), incoming.replace("footer = 'EVGEN'", "footer = 'h00k'"));
    assert.equal(f.read("src/Header.tsx"), "custom header\n");
    assert.equal(f.read(".env"), "FIXTURE_CONFIGURATION=keep\n");
    assert.equal(f.read("local-notes.txt"), "keep my notes\n");
    assert.equal(existsSync(path.join(f.repo, "installer-was-executed")), false);
    const backup = result.stdout.match(/Резервна копія локальних правок: (.+)/)![1];
    assert.ok(existsSync(path.join(backup, "App.before.tsx")));
    assert.ok(f.git("stash", "list").includes("vps-before-update-"));
  }
});

updateTest("VPS update resolves the old App stash conflict and retains later manual edits and original stash", t => {
  const f = fixture(t);
  f.write("src/App.tsx", initial.replace("version = 1", "version = 9").replace("footer = 'EVGEN'", "footer = 'h00k'"));
  f.git("stash", "push", "-m", "original-owner-edit");
  const originalStash = f.git("rev-parse", "refs/stash");
  f.git("merge", "--ff-only", f.target);
  const conflict = spawnSync("git", ["stash", "apply"], { cwd: f.repo, encoding: "utf8" });
  assert.notEqual(conflict.status, 0);
  assert.ok(f.git("diff", "--name-only", "--diff-filter=U").includes("src/App.tsx"));
  f.write("src/App.tsx", f.read("src/App.tsx") + "const manualAfterConflict = true;\n");
  const before = f.read("src/App.tsx");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read("src/App.tsx"), incoming.replace("footer = 'EVGEN'", "footer = 'h00k'") + "const manualAfterConflict = true;\n");
  assert.equal(f.git("diff", "--name-only", "--diff-filter=U"), "");
  assert.ok(f.git("stash", "list", "--format=%H").includes(originalStash));
  const backup = result.stdout.match(/Резервна копія локальних правок: (.+)/)![1];
  assert.equal(readFileSync(path.join(backup, "App.before.tsx"), "utf8"), before);
  assert.ok(existsSync(path.join(backup, "conflict-local.tsx")));
});

updateTest("VPS update refuses a different branch without changing working files", t => {
  const f = fixture(t);
  f.git("switch", "-c", "owner-other-work");
  f.write("src/App.tsx", initial + "// local work\n");
  const before = f.git("status", "--porcelain");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Очікується гілка/);
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(f.git("rev-parse", "HEAD"), f.base);
});

updateTest("VPS update refuses divergent local commits instead of resetting them", t => {
  const f = fixture(t);
  f.write("owner-work.txt", "committed local work\n");
  f.git("add", "."); f.git("commit", "-m", "owner work");
  const before = f.git("rev-parse", "HEAD");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Гілки розійшлися/);
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(f.read("owner-work.txt"), "committed local work\n");
});

updateTest("VPS update refuses unrelated file conflicts without changing them", t => {
  const f = fixture(t);
  f.git("reset", "--hard", f.target);
  f.write("src/Header.tsx", "upstream header\n");
  f.git("add", "."); f.git("commit", "-m", "upstream header change");
  const target = f.git("rev-parse", "HEAD");
  f.git("push", "origin", branch);
  f.git("reset", "--hard", f.base);
  f.write("src/Header.tsx", "owner header\n");
  f.git("stash", "push", "-m", "owner header");
  f.git("merge", "--ff-only", target);
  const conflict = spawnSync("git", ["stash", "apply"], { cwd: f.repo, encoding: "utf8" });
  assert.notEqual(conflict.status, 0);
  const before = f.read("src/Header.tsx"), index = f.git("ls-files", "--unmerged");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Потрібно окремо розв’язати конфлікт: src\/Header.tsx/);
  assert.equal(f.read("src/Header.tsx"), before);
  assert.equal(f.git("ls-files", "--unmerged"), index);
});

updateTest("malformed App conflict markers stop the update and the original file stays backed up", t => {
  const f = fixture(t);
  f.write("src/App.tsx", initial.replace("version = 1", "version = 9"));
  f.git("stash", "push", "-m", "owner edit");
  f.git("merge", "--ff-only", f.target);
  const conflict = spawnSync("git", ["stash", "apply"], { cwd: f.repo, encoding: "utf8" });
  assert.notEqual(conflict.status, 0);
  f.write("src/App.tsx", f.read("src/App.tsx") + "<<<<<<< unfinished edit\n");
  const before = f.read("src/App.tsx"), index = f.git("ls-files", "--unmerged");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Оновлення перервано/);
  assert.equal(f.read("src/App.tsx"), before);
  assert.equal(f.git("ls-files", "--unmerged"), index);
  const backup = result.stdout.match(/Резервна копія локальних правок: (.+)/)![1];
  assert.equal(readFileSync(path.join(backup, "App.before.tsx"), "utf8"), before);
});
