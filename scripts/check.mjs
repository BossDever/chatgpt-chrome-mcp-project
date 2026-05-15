#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "tests"].filter((root) => {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
});

function collectMjsFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMjsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(fullPath);
    }
  }
  return files;
}

function run(command, args) {
  console.log(`> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const files = roots.flatMap(collectMjsFiles).sort();
for (const file of files) {
  run("node", ["--check", file]);
}

run("node", ["--test"]);
