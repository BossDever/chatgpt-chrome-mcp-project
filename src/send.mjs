#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bridgeScript = path.join(__dirname, "uia-chatgpt.ps1");

function parseArgs(argv) {
  const options = {
    submit: true,
    allowMismatch: false,
    allowSuspiciousText: false,
    base64: false,
    windowTitleContains: "",
    messageParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-submit") {
      options.submit = false;
    } else if (arg === "--allow-mismatch") {
      options.allowMismatch = true;
    } else if (arg === "--allow-suspicious-text") {
      options.allowSuspiciousText = true;
    } else if (arg === "--base64") {
      options.base64 = true;
    } else if (arg === "--window-title") {
      options.windowTitleContains = argv[++i] ?? "";
    } else {
      options.messageParts.push(arg);
    }
  }

  return options;
}

function looksSuspiciousEncodingLoss(text) {
  if (!text) return false;

  const longQuestionRuns = text.match(/\?{5,}/g) ?? [];
  const questionCount = (text.match(/\?/g) ?? []).length;
  const nonWhitespaceCount = (text.match(/\S/g) ?? []).length;
  const questionRatio = nonWhitespaceCount === 0 ? 0 : questionCount / nonWhitespaceCount;

  return longQuestionRuns.length > 0 || (questionCount >= 8 && questionRatio > 0.18);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stdin = await readStdin();
  let message = options.messageParts.length > 0 ? options.messageParts.join(" ") : stdin.trimEnd();

  if (options.base64) {
    message = Buffer.from(message.trim(), "base64").toString("utf8");
  }

  if (!message) {
    console.error("Usage: npm run chatgpt:send -- \"message\"");
    console.error("       npm run chatgpt:send -- --base64 <utf8-base64-message>");
    console.error("       Get-Content message.txt -Raw | node src/send.mjs");
    process.exit(2);
  }

  if (!options.allowSuspiciousText && looksSuspiciousEncodingLoss(message)) {
    console.error("Refusing to send: message looks like encoding loss with many '?' characters.");
    console.error("Use --base64 for Thai/special text from shell, or --allow-suspicious-text if intentional.");
    process.exit(2);
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    bridgeScript,
    "-Action",
    "send",
    "-EncodedMessage",
    Buffer.from(message, "utf8").toString("base64"),
  ];

  if (!options.submit) args.push("-NoSubmit");
  if (options.allowMismatch) args.push("-AllowMismatch");
  if (options.windowTitleContains) args.push("-WindowTitleContains", options.windowTitleContains);

  const child = spawn(process.platform === "win32" ? "powershell.exe" : "pwsh", args, {
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.on("close", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
