import { spawn } from "node:child_process";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function powershellCommand() {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

export function hasErrorText(readResult) {
  const text = `${readResult?.tailText ?? ""}`.toLowerCase();
  return /network error|regenerate|try again|something went wrong|เกิดข้อผิดพลาด|ลองอีกครั้ง|ไม่สามารถ|ขัดข้อง/.test(
    text,
  );
}

export async function waitForStateWithDeps({
  getState,
  readChat,
  hasErrorTextFn = hasErrorText,
  sleepFn = sleep,
  target = "idle",
  previousHash,
  previousDownloadButtonCount,
  timeoutMs = 60000,
  intervalMs = 1000,
  stableMs = 1500,
  windowTitleContains,
}) {
  const start = Date.now();
  let candidate = null;
  let candidateSince = 0;
  let last = null;
  let lastRead = null;

  while (Date.now() - start < timeoutMs) {
    last = await getState({ windowTitleContains });

    let matches = false;
    if (target === "idle") {
      const changedEnough = !previousHash || last.visibleTextHash !== previousHash;
      matches = !last.isGenerating && changedEnough;
    } else if (target === "generating") {
      matches = last.isGenerating;
    } else if (target === "download_available") {
      const baseline = Number.isInteger(previousDownloadButtonCount)
        ? previousDownloadButtonCount
        : 0;
      matches = last.downloadButtonCount > baseline;
    } else if (target === "error") {
      lastRead = await readChat({ windowTitleContains, maxItems: 80 });
      matches = hasErrorTextFn(lastRead);
    }

    if (matches) {
      if (stableMs === 0 || target === "generating" || target === "error") {
        return { ok: true, target, state: last, read: lastRead };
      }

      if (!candidate || candidate.visibleTextHash !== last.visibleTextHash) {
        candidate = last;
        candidateSince = Date.now();
      } else if (Date.now() - candidateSince >= stableMs) {
        return { ok: true, target, state: candidate, read: lastRead };
      }
    } else {
      candidate = null;
      candidateSince = 0;
    }

    await sleepFn(intervalMs);
  }

  return {
    ok: false,
    timeout: true,
    target,
    message: `Timed out waiting for ChatGPT state '${target}'.`,
    state: last,
    read: lastRead,
  };
}

export function createUiaBridge({
  bridgeScript,
  spawnProcess = spawn,
  powershell = powershellCommand,
  sleepFn = sleep,
} = {}) {
  if (!bridgeScript) throw new Error("bridgeScript is required.");
  let bridgeQueue = Promise.resolve();

  function runBridge(action, options = {}, timeoutMs = 60000) {
    const run = () => new Promise((resolve, reject) => {
      const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        bridgeScript,
        "-Action",
        action,
      ];

      if (options.windowTitleContains) {
        args.push("-WindowTitleContains", options.windowTitleContains);
      }

      if (Number.isInteger(options.maxItems)) {
        args.push("-MaxItems", String(options.maxItems));
      }

      if (options.downloadNameContains) {
        args.push("-DownloadNameContains", options.downloadNameContains);
      }

      if (options.attachmentNameContains) {
        args.push("-AttachmentNameContains", options.attachmentNameContains);
      }

      if (options.downloadDirectory) {
        args.push("-DownloadDirectory", options.downloadDirectory);
      }

      if (Number.isInteger(options.waitForDownloadSeconds)) {
        args.push("-WaitForDownloadSeconds", String(options.waitForDownloadSeconds));
      }

      if (Number.isInteger(options.waitForUploadSeconds)) {
        args.push("-WaitForUploadSeconds", String(options.waitForUploadSeconds));
      }

      if (Number.isInteger(options.maxDownloads)) {
        args.push("-MaxDownloads", String(options.maxDownloads));
      }

      if (Number.isInteger(options.maxAttachments)) {
        args.push("-MaxAttachments", String(options.maxAttachments));
      }

      if (Number.isInteger(options.maxCodeBlocks)) {
        args.push("-MaxCodeBlocks", String(options.maxCodeBlocks));
      }

      if (Number.isInteger(options.codeBlockOffsetFromLatest)) {
        args.push("-CodeBlockOffsetFromLatest", String(options.codeBlockOffsetFromLatest));
      }

      if (typeof options.message === "string") {
        const encoded = Buffer.from(options.message, "utf8").toString("base64");
        args.push("-EncodedMessage", encoded);
      }

      if (typeof options.filePath === "string") {
        const encoded = Buffer.from(options.filePath, "utf8").toString("base64");
        args.push("-EncodedFilePath", encoded);
      }

      if (options.noSubmit) {
        args.push("-NoSubmit");
      }

      if (options.allowMismatch) {
        args.push("-AllowMismatch");
      }

      const child = spawnProcess(powershell(), args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out running UI Automation bridge after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = stdout.trim();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          reject(new Error(`Bridge returned non-JSON output: ${text || stderr || error.message}`));
          return;
        }

        if (code !== 0 || parsed.ok === false) {
          reject(new Error(parsed.error || stderr || `Bridge exited with code ${code}`));
          return;
        }

        resolve(parsed);
      });
    });

    const queued = bridgeQueue.then(run, run);
    bridgeQueue = queued.catch(() => {});
    return queued;
  }

  async function retryBridge(action, options = {}, timeoutMs = 60000, attempts = 4) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await runBridge(action, options, timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await sleepFn(350 * attempt);
        }
      }
    }

    throw lastError;
  }

  async function readChat(args = {}) {
    const attempts = args.attempts ?? 4;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await runBridge("read", {
          windowTitleContains: args.windowTitleContains,
          maxItems: args.maxItems ?? 80,
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await sleepFn(350 * attempt);
        }
      }
    }

    throw lastError;
  }

  async function getState(args = {}) {
    return retryBridge("state", {
      windowTitleContains: args.windowTitleContains,
    });
  }

  async function getLastResponse(args = {}) {
    return retryBridge("lastresponse", {
      windowTitleContains: args.windowTitleContains,
    });
  }

  async function getCodeBlocks(args = {}) {
    return retryBridge("codeblocks", {
      maxCodeBlocks: args.maxCodeBlocks ?? 5,
      codeBlockOffsetFromLatest: args.codeBlockOffsetFromLatest ?? 0,
      windowTitleContains: args.windowTitleContains,
    });
  }

  async function waitForState(args = {}) {
    return waitForStateWithDeps({
      ...args,
      getState,
      readChat,
      sleepFn,
      hasErrorTextFn: hasErrorText,
    });
  }

  return {
    getCodeBlocks,
    getLastResponse,
    getState,
    readChat,
    retryBridge,
    runBridge,
    waitForState,
  };
}
