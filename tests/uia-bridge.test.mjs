import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createUiaBridge,
  hasErrorText,
  waitForStateWithDeps,
} from "../src/uia-bridge.mjs";

function fakeChild({
  stdout = "{}",
  stderr = "",
  code = 0,
  delayMs = 0,
  close = true,
  onSpawn,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    child.killed = true;
  };
  onSpawn?.(child);
  if (close) {
    setTimeout(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code);
    }, delayMs);
  }
  return child;
}

test("hasErrorText detects common ChatGPT error text", () => {
  assert.equal(hasErrorText({ tailText: "Network error, please try again" }), true);
  assert.equal(hasErrorText({ tailText: "เกิดข้อผิดพลาด ลองอีกครั้ง" }), true);
  assert.equal(hasErrorText({ tailText: "Normal assistant response" }), false);
});

test("waitForStateWithDeps returns stable idle state", async () => {
  const states = [
    { isGenerating: false, visibleTextHash: "a", downloadButtonCount: 0 },
    { isGenerating: false, visibleTextHash: "a", downloadButtonCount: 0 },
  ];
  const result = await waitForStateWithDeps({
    getState: async () => states.shift() ?? { isGenerating: false, visibleTextHash: "a" },
    readChat: async () => ({ tailText: "" }),
    sleepFn: async () => {},
    target: "idle",
    timeoutMs: 50,
    intervalMs: 1,
    stableMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, "idle");
});

test("waitForStateWithDeps detects error state through readChat", async () => {
  const result = await waitForStateWithDeps({
    getState: async () => ({ isGenerating: false, visibleTextHash: "a", downloadButtonCount: 0 }),
    readChat: async () => ({ tailText: "something went wrong" }),
    sleepFn: async () => {},
    target: "error",
    timeoutMs: 50,
    intervalMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.read.tailText, "something went wrong");
});

test("createUiaBridge serializes bridge calls and encodes message/file path", async () => {
  const spawnStarts = [];
  const spawnArgs = [];
  let active = 0;
  let maxActive = 0;
  const bridge = createUiaBridge({
    bridgeScript: "bridge.ps1",
    powershell: () => "pwsh",
    spawnProcess: (command, args) => {
      spawnStarts.push(command);
      spawnArgs.push(args);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return fakeChild({
        stdout: JSON.stringify({ ok: true, action: args.at(args.indexOf("-Action") + 1) }),
        delayMs: 5,
        onSpawn: (child) => {
          child.on("close", () => {
            active -= 1;
          });
        },
      });
    },
  });

  const first = bridge.runBridge("send", { message: "ทดสอบ", filePath: "C:/tmp/a.txt" });
  const second = bridge.runBridge("state");
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map((result) => result.action), ["send", "state"]);
  assert.equal(maxActive, 1);
  assert.equal(spawnStarts.every((command) => command === "pwsh"), true);
  assert.equal(spawnArgs[0].includes("-EncodedMessage"), true);
  assert.equal(spawnArgs[0].includes("-EncodedFilePath"), true);
});

test("createUiaBridge rejects non-json bridge output", async () => {
  const bridge = createUiaBridge({
    bridgeScript: "bridge.ps1",
    spawnProcess: () => fakeChild({ stdout: "not json" }),
  });

  await assert.rejects(() => bridge.runBridge("state"), /non-JSON/);
});

test("createUiaBridge kills timed-out bridge calls and keeps queue usable", async () => {
  let spawnCount = 0;
  let timedOutChild;
  const bridge = createUiaBridge({
    bridgeScript: "bridge.ps1",
    spawnProcess: (_command, args) => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return fakeChild({
          close: false,
          onSpawn: (child) => {
            timedOutChild = child;
          },
        });
      }

      return fakeChild({
        stdout: JSON.stringify({ ok: true, action: args.at(args.indexOf("-Action") + 1) }),
      });
    },
  });

  await assert.rejects(() => bridge.runBridge("read", {}, 5), /Timed out/);
  assert.equal(timedOutChild.killed, true);

  const state = await bridge.runBridge("state", {}, 50);
  assert.equal(state.action, "state");
  assert.equal(spawnCount, 2);
});
