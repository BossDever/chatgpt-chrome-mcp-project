import * as z from "zod/v4";

export function registerUiaTools(server, deps) {
  const {
    getCodeBlocks,
    getLastResponse,
    getState,
    hasErrorText,
    readChat,
    resolveMessageInput,
    runBridge,
    sha256,
    verifyDownloadedFiles,
    verifyLocalUploadFile,
    waitForState,
    withMeta,
  } = deps;

  server.registerTool(
    "chatgpt_read",
    {
      title: "Read visible ChatGPT text",
      description:
        "Reads visible conversation text from an already-open Chrome window running ChatGPT.",
      inputSchema: {
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
        maxItems: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe("Maximum number of trailing text items to return."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const result = await readChat(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_send",
    {
      title: "Send a message to ChatGPT in Chrome",
      description:
        "Writes a message into the ChatGPT prompt in Chrome and submits it unless submit=false.",
      inputSchema: {
        message: z.string().optional().describe("Message to send to ChatGPT."),
        messageBase64: z
          .string()
          .optional()
          .describe("UTF-8 base64 encoded message. Prefer this for shell-driven Thai/special text."),
        submit: z
          .boolean()
          .optional()
          .describe("When false, fills the prompt but does not press Enter."),
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
        allowMismatch: z
          .boolean()
          .optional()
          .describe(
            "When true, submits even if the prompt text verification fails. Defaults to false.",
          ),
        allowSuspiciousText: z
          .boolean()
          .optional()
          .describe("When true, allows text that looks like encoding loss, such as many '?' chars."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate message and state, but do not write into ChatGPT or submit."),
        force: z
          .boolean()
          .optional()
          .describe("When true, allows sending while ChatGPT appears to be generating."),
        allowAttachments: z
          .boolean()
          .optional()
          .describe("When true, allows submitting while composer attachments are pending."),
        requestId: z.string().optional(),
      },
    },
    async ({
      message,
      messageBase64,
      submit = true,
      windowTitleContains,
      allowMismatch = false,
      allowSuspiciousText = false,
      dryRun = false,
      force = false,
      allowAttachments = false,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      const messageText = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      const state = await getState({ windowTitleContains });
      if (state.isGenerating && !force) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "BUSY_GENERATING",
            message: "Refusing to send while ChatGPT appears to be generating.",
            state,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      if (submit && state.attachmentCount > 0 && !allowAttachments) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "PENDING_ATTACHMENTS",
            message:
              "Refusing to submit while ChatGPT has pending attachments. Remove them or set allowAttachments=true.",
            state,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      if (dryRun) {
        const result = withMeta(
          {
            ok: true,
            dryRun: true,
            wouldSubmit: submit,
            messageHash: sha256(messageText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")),
            state,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
  
      const result = await runBridge("send", {
        message: messageText,
        windowTitleContains,
        noSubmit: !submit,
        allowMismatch,
      });
      const withTiming = withMeta({ ...result, stateBeforeSend: state }, { requestId, startedAt });
      return {
        content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
        structuredContent: withTiming,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_list_downloads",
    {
      title: "List ChatGPT download buttons",
      description:
        "Lists visible downloadable file buttons or links in the open ChatGPT conversation.",
      inputSchema: {
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ windowTitleContains }) => {
      const result = await runBridge("downloads", { windowTitleContains });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_list_attachments",
    {
      title: "List pending ChatGPT attachments",
      description:
        "Lists files currently attached in the ChatGPT composer before a message is sent.",
      inputSchema: {
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ windowTitleContains }) => {
      const result = await runBridge("attachments", { windowTitleContains });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_upload_file",
    {
      title: "Attach a local file to ChatGPT",
      description:
        "Attaches a local file to the open ChatGPT composer through ChatGPT's file picker. It does not submit the message.",
      inputSchema: {
        filePath: z.string().describe("Path to a local file to attach."),
        allowedExtensions: z
          .array(z.string())
          .optional()
          .describe("Allowed file extensions. Defaults to common document/image/text formats."),
        maxBytes: z.number().int().min(1).optional().describe("Maximum file size. Defaults to 50 MiB."),
        waitForUploadSeconds: z.number().int().min(1).max(180).optional(),
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate file and ChatGPT state, but do not open the picker or attach."),
        force: z
          .boolean()
          .optional()
          .describe("When true, allows attaching while ChatGPT appears to be generating."),
        requestId: z.string().optional(),
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
    },
    async ({
      filePath,
      allowedExtensions,
      maxBytes,
      waitForUploadSeconds = 30,
      dryRun = false,
      force = false,
      requestId,
      windowTitleContains,
    }) => {
      const startedAt = new Date().toISOString();
      const validation = await verifyLocalUploadFile(filePath, { allowedExtensions, maxBytes });
      const state = await getState({ windowTitleContains });
  
      if (!validation.safeForUpload) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "UPLOAD_FILE_BLOCKED",
            message: "Refusing to upload because the file failed extension or size checks.",
            validation,
            state,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      if (state.isGenerating && !force) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "BUSY_GENERATING",
            message: "Refusing to attach a file while ChatGPT appears to be generating.",
            validation,
            state,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      if (dryRun) {
        const result = withMeta(
          {
            ok: true,
            dryRun: true,
            wouldUpload: true,
            validation,
            state,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
  
      const upload = await runBridge(
        "upload",
        {
          filePath: validation.fullName,
          waitForUploadSeconds,
          windowTitleContains,
        },
        (waitForUploadSeconds + 20) * 1000,
      );
      const result = withMeta(
        {
          ok: upload.ok,
          validation,
          upload,
        },
        { requestId, startedAt },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: !upload.uploaded,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_remove_attachments",
    {
      title: "Remove pending ChatGPT attachments",
      description:
        "Removes files currently attached in the ChatGPT composer, useful after tests or before sending a text-only message.",
      inputSchema: {
        attachmentNameContains: z
          .string()
          .optional()
          .describe("Only remove attachments whose displayed name contains this text."),
        removeAll: z.boolean().optional().describe("Required when attachmentNameContains is omitted."),
        maxAttachments: z.number().int().min(1).max(20).optional(),
        requestId: z.string().optional(),
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
    },
    async ({
      attachmentNameContains,
      removeAll = false,
      maxAttachments = 10,
      requestId,
      windowTitleContains,
    }) => {
      const startedAt = new Date().toISOString();
      if (!attachmentNameContains && !removeAll) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "ATTACHMENT_FILTER_REQUIRED",
            message: "Provide attachmentNameContains or set removeAll=true.",
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      const result = await runBridge("removeattachments", {
        attachmentNameContains: attachmentNameContains ?? "",
        maxAttachments,
        windowTitleContains,
      });
      const withTiming = withMeta(result, { requestId, startedAt });
      return {
        content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
        structuredContent: withTiming,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_get_state",
    {
      title: "Get ChatGPT Chrome state",
      description:
        "Returns prompt availability, visible text hash, code block count, download count, and generation state.",
      inputSchema: {
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ windowTitleContains }) => {
      const result = await runBridge("state", { windowTitleContains });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_wait_state",
    {
      title: "Wait for ChatGPT state",
      description:
        "Waits for ChatGPT to become idle, start generating, expose a download, or show likely error text.",
      inputSchema: {
        target: z.enum(["idle", "generating", "download_available", "error"]).optional(),
        previousHash: z.string().optional(),
        previousDownloadButtonCount: z.number().int().min(0).optional(),
        timeoutMs: z.number().int().min(1000).max(180000).optional(),
        intervalMs: z.number().int().min(250).max(10000).optional(),
        stableMs: z.number().int().min(0).max(15000).optional(),
        requestId: z.string().optional(),
        windowTitleContains: z.string().optional(),
      },
    },
    async ({
      target = "idle",
      previousHash,
      previousDownloadButtonCount,
      timeoutMs = 60000,
      intervalMs = 1000,
      stableMs = 1500,
      requestId,
      windowTitleContains,
    }) => {
      const startedAt = new Date().toISOString();
      const result = await waitForState({
        target,
        previousHash,
        previousDownloadButtonCount,
        timeoutMs,
        intervalMs,
        stableMs,
        windowTitleContains,
      });
      const withTiming = withMeta(result, { requestId, startedAt });
      return {
        content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
        structuredContent: withTiming,
        isError: !result.ok,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_get_code_blocks",
    {
      title: "Copy ChatGPT code blocks",
      description:
        "Copies recent ChatGPT code blocks using the code block copy buttons and returns exact clipboard text.",
      inputSchema: {
        maxCodeBlocks: z.number().int().min(1).max(20).optional(),
        codeBlockOffsetFromLatest: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe("0 means newest code block, 1 skips the newest, etc."),
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ maxCodeBlocks = 5, codeBlockOffsetFromLatest = 0, windowTitleContains }) => {
      const result = await runBridge("codeblocks", {
        maxCodeBlocks,
        codeBlockOffsetFromLatest,
        windowTitleContains,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_get_last_response",
    {
      title: "Get latest ChatGPT assistant response",
      description:
        "Returns the latest assistant response detected in the ChatGPT conversation, optionally with state and recent code blocks.",
      inputSchema: {
        includeState: z.boolean().optional(),
        includeCodeBlocks: z.boolean().optional(),
        maxCodeBlocks: z.number().int().min(1).max(20).optional(),
        requestId: z.string().optional(),
        windowTitleContains: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({
      includeState = true,
      includeCodeBlocks = false,
      maxCodeBlocks = 5,
      requestId,
      windowTitleContains,
    }) => {
      const startedAt = new Date().toISOString();
      const response = await getLastResponse({ windowTitleContains });
      const result = {
        ok: true,
        response,
        state: includeState ? await getState({ windowTitleContains }) : null,
        codeBlocks: includeCodeBlocks
          ? await getCodeBlocks({ maxCodeBlocks, windowTitleContains })
          : null,
      };
      const withTiming = withMeta(result, { requestId, startedAt });
      return {
        content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
        structuredContent: withTiming,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_stop_generation",
    {
      title: "Stop ChatGPT generation",
      description: "Clicks a visible Stop/หยุด generation button in ChatGPT if one exists.",
      inputSchema: {
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
    },
    async ({ windowTitleContains }) => {
      const result = await runBridge("stop", { windowTitleContains });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_download_files",
    {
      title: "Download files created by ChatGPT",
      description:
        "Clicks visible ChatGPT download buttons or links and reports files created in the Downloads folder.",
      inputSchema: {
        downloadNameContains: z
          .string()
          .optional()
          .describe("Optional substring to match a specific download button name."),
        maxDownloads: z.number().int().min(1).max(10).optional(),
        waitForDownloadSeconds: z.number().int().min(1).max(180).optional(),
        downloadDirectory: z
          .string()
          .optional()
          .describe("Directory to monitor. Defaults to the user's Downloads folder."),
        allowedExtensions: z.array(z.string()).optional(),
        maxBytes: z.number().int().min(1).optional(),
        windowTitleContains: z
          .string()
          .optional()
          .describe("Optional substring to select a specific Chrome window title."),
      },
    },
    async ({
      downloadNameContains,
      maxDownloads = 1,
      waitForDownloadSeconds = 30,
      downloadDirectory,
      allowedExtensions,
      maxBytes,
      windowTitleContains,
    }) => {
      const result = await runBridge(
        "download",
        {
          downloadNameContains,
          maxDownloads,
          waitForDownloadSeconds,
          downloadDirectory,
          windowTitleContains,
        },
        (waitForDownloadSeconds + 15) * 1000,
      );
      const verified = await verifyDownloadedFiles(result, { allowedExtensions, maxBytes });
      return {
        content: [{ type: "text", text: JSON.stringify(verified, null, 2) }],
        structuredContent: verified,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_wait_for_update",
    {
      title: "Wait for visible ChatGPT text to change",
      description:
        "Polls the open ChatGPT window until visible text hash changes or the timeout is reached.",
      inputSchema: {
        previousHash: z
          .string()
          .optional()
          .describe("Hash returned by chatgpt_read. If omitted, the next read is returned."),
        timeoutMs: z.number().int().min(1000).max(180000).optional(),
        intervalMs: z.number().int().min(250).max(10000).optional(),
        stableMs: z
          .number()
          .int()
          .min(0)
          .max(15000)
          .optional()
          .describe("Require the changed hash to stay unchanged for this many milliseconds."),
        windowTitleContains: z.string().optional(),
        maxItems: z.number().int().min(1).max(300).optional(),
      },
    },
    async ({
      previousHash,
      timeoutMs = 60000,
      intervalMs = 1000,
      stableMs = 1500,
      windowTitleContains,
      maxItems = 120,
    }) => {
      const start = Date.now();
      let candidate = null;
      let candidateSince = 0;
      let last = null;
  
      while (Date.now() - start < timeoutMs) {
        last = await readChat({ windowTitleContains, maxItems });
  
        if (!previousHash || last.hash !== previousHash) {
          if (stableMs === 0) {
            return {
              content: [{ type: "text", text: JSON.stringify(last, null, 2) }],
              structuredContent: last,
            };
          }
  
          if (!candidate || candidate.hash !== last.hash) {
            candidate = last;
            candidateSince = Date.now();
          } else if (Date.now() - candidateSince >= stableMs) {
            return {
              content: [{ type: "text", text: JSON.stringify(candidate, null, 2) }],
              structuredContent: candidate,
            };
          }
        }
  
        await sleep(intervalMs);
      }
  
      const result = {
        ok: false,
        timeout: true,
        message: "Timed out waiting for ChatGPT visible text to change.",
        last,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: true,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_send_and_wait",
    {
      title: "Send a ChatGPT message and wait for a reply",
      description:
        "Reads the current ChatGPT text, sends a message, then waits until additional visible text appears and stabilizes.",
      inputSchema: {
        message: z.string().optional().describe("Message to send to ChatGPT."),
        messageBase64: z
          .string()
          .optional()
          .describe("UTF-8 base64 encoded message. Prefer this for shell-driven Thai/special text."),
        timeoutMs: z.number().int().min(5000).max(180000).optional(),
        intervalMs: z.number().int().min(250).max(10000).optional(),
        stableMs: z.number().int().min(500).max(15000).optional(),
        allowSuspiciousText: z
          .boolean()
          .optional()
          .describe("When true, allows text that looks like encoding loss, such as many '?' chars."),
        autoDownload: z
          .boolean()
          .optional()
          .describe("When true, downloads visible files created by the reply after it stabilizes."),
        downloadNameContains: z
          .string()
          .optional()
          .describe("Optional substring used when autoDownload=true."),
        maxDownloads: z.number().int().min(1).max(10).optional(),
        waitForDownloadSeconds: z.number().int().min(1).max(180).optional(),
        downloadDirectory: z.string().optional(),
        allowedExtensions: z.array(z.string()).optional(),
        maxBytes: z.number().int().min(1).optional(),
        includeCodeBlocks: z.boolean().optional(),
        maxCodeBlocks: z.number().int().min(1).max(20).optional(),
        force: z
          .boolean()
          .optional()
          .describe("When true, allows sending while ChatGPT appears to be generating."),
        allowAttachments: z
          .boolean()
          .optional()
          .describe("When true, allows submitting while composer attachments are pending."),
        requestId: z.string().optional(),
        windowTitleContains: z.string().optional(),
        maxItems: z.number().int().min(1).max(300).optional(),
      },
    },
    async ({
      message,
      messageBase64,
      timeoutMs = 90000,
      intervalMs = 1000,
      stableMs = 2500,
      allowSuspiciousText = false,
      autoDownload = false,
      downloadNameContains,
      maxDownloads = 1,
      waitForDownloadSeconds = 30,
      downloadDirectory,
      allowedExtensions,
      maxBytes,
      includeCodeBlocks = false,
      maxCodeBlocks = 5,
      force = false,
      allowAttachments = false,
      requestId,
      windowTitleContains,
      maxItems = 160,
    }) => {
      const startedAt = new Date().toISOString();
      const messageText = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      const before = await readChat({ windowTitleContains, maxItems });
      const stateBeforeSend = await getState({ windowTitleContains });
      if (stateBeforeSend.isGenerating && !force) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "BUSY_GENERATING",
            message: "Refusing to send while ChatGPT appears to be generating.",
            before,
            stateBeforeSend,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      if (stateBeforeSend.attachmentCount > 0 && !allowAttachments) {
        const result = withMeta(
          {
            ok: false,
            errorCode: "PENDING_ATTACHMENTS",
            message:
              "Refusing to submit while ChatGPT has pending attachments. Remove them or set allowAttachments=true.",
            before,
            stateBeforeSend,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      const sent = await runBridge("send", { message: messageText, windowTitleContains });
      const wait = await waitForState({
        target: "idle",
        previousHash: before.hash,
        timeoutMs,
        intervalMs,
        stableMs,
        windowTitleContains,
      });
  
      if (!wait.ok) {
        const result = withMeta({ ...wait, sent, before, stateBeforeSend }, { requestId, startedAt });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
  
      const after = await readChat({ windowTitleContains, maxItems });
      const lastResponse = await getLastResponse({ windowTitleContains });
      let codeBlocks = null;
      if (includeCodeBlocks) {
        codeBlocks = await getCodeBlocks({ maxCodeBlocks, windowTitleContains });
      }
  
      let downloads = null;
      if (autoDownload && wait.state?.downloadButtonCount > 0) {
        downloads = await runBridge(
          "download",
          {
            downloadNameContains,
            maxDownloads,
            waitForDownloadSeconds,
            downloadDirectory,
            windowTitleContains,
          },
          (waitForDownloadSeconds + 15) * 1000,
        );
        downloads = await verifyDownloadedFiles(downloads, { allowedExtensions, maxBytes });
      }
  
      const result = withMeta(
        {
          ok: true,
          sent,
          before,
          after,
          stateBeforeSend,
          wait,
          state: wait.state,
          lastResponse,
          codeBlocks,
          downloads,
          warnings: [],
        },
        { requestId, startedAt },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
}
