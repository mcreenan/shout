import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { ROOT } from "../src/josh.mjs";

test(
  "cancel and quit during stalled Codex initialization settle ownership and reap the process",
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "native-init-test-"));
    const binary = resolve(dir, "codex.cjs"),
      pidPath = resolve(dir, "pid");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nif(process.argv.includes('--version'))console.log('codex-cli 0.153.3');else { require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();setInterval(()=>{},10000); }`,
      { mode: 0o700 },
    );
    const child = spawn(process.execPath, [resolve(ROOT, "src/cli.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CODEX_BIN: binary },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = once(child, "exit");
    let peerPid;
    try {
      child.stdin.write("/live\n");
      for (let i = 0; i < 100; i++) {
        try {
          peerPid = Number(await readFile(pidPath, "utf8"));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      assert.ok(peerPid, "fake protocol peer started");
      const started = Date.now();
      child.stdin.write("/cancel\n/quit\n");
      const [code] = await exited;
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 2500, "shutdown remains bounded");
      assert.throws(() => process.kill(peerPid, 0), { code: "ESRCH" });
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  },
);
