import * as z from "zod/v4";

export function registerCdpTools(server, deps) {
  const {
    auditCdpWrite,
    cdpStatus,
    defaultCdpBaseUrl,
    defaultChromeUserDataDir,
    findCdpTab,
    getCdpState,
    isChatGptUrl,
    launchCdpChrome,
    listCdpTabs,
    normalizeSessionName,
    openCdpTab,
    readBoundCdpTarget,
    readCdpPage,
    removeCdpAttachments,
    resolveBoundCdpTarget,
    resolveMessageInput,
    sendCdpMessage,
    sendCdpMessageAndWait,
    sha256,
    uploadCdpFile,
    verifyLocalUploadFile,
    withMeta,
    writeBoundCdpTarget,
  } = deps;

  server.registerTool(
    "chrome_cdp_status",
    {
      title: "Check Chrome DevTools Protocol status",
      description:
        "Checks whether a Chrome instance with remote debugging is available for stable tabId-based control.",
      inputSchema: {
        baseUrl: z.string().optional().describe("CDP base URL. Defaults to CHATGPT_CHROME_MCP_CDP_URL or http://127.0.0.1:9222."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ baseUrl = defaultCdpBaseUrl() }) => {
      const result = await cdpStatus({ baseUrl });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: !result.ok,
      };
    },
  );
  
  server.registerTool(
    "chrome_cdp_launch",
    {
      title: "Launch dedicated CDP Chrome",
      description:
        "Launches a dedicated Chrome profile with remote debugging on 127.0.0.1 for tabId-based automation. The user may need to log in to ChatGPT in this profile.",
      inputSchema: {
        port: z.number().int().min(1024).max(65535).optional(),
        userDataDir: z.string().optional(),
        chromePath: z.string().optional(),
        url: z.string().optional(),
        requestId: z.string().optional(),
      },
    },
    async ({
      port = 9222,
      userDataDir = defaultChromeUserDataDir(),
      chromePath,
      url = "https://chatgpt.com/",
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const result = await launchCdpChrome({ port, userDataDir, chromePath, url });
        const withTiming = withMeta(result, { requestId, startedAt });
        return {
          content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
          structuredContent: withTiming,
          isError: !result.ok,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_CHROME_LAUNCH_FAILED", error: error.message },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chrome_cdp_list_tabs",
    {
      title: "List CDP Chrome tabs",
      description:
        "Lists tabs from the CDP-enabled Chrome instance with stable tabId/targetId values.",
      inputSchema: {
        baseUrl: z.string().optional(),
        includeNonPages: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ baseUrl = defaultCdpBaseUrl(), includeNonPages = false }) => {
      try {
        const tabs = await listCdpTabs({ baseUrl, includeNonPages });
        const result = { ok: true, baseUrl, tabCount: tabs.length, tabs };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = { ok: false, errorCode: "CDP_LIST_TABS_FAILED", error: error.message };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chrome_cdp_open_tab",
    {
      title: "Open a CDP Chrome tab",
      description: "Opens a new tab in the CDP-enabled Chrome instance and returns its tabId.",
      inputSchema: {
        baseUrl: z.string().optional(),
        url: z.string().optional(),
        requestId: z.string().optional(),
      },
    },
    async ({ baseUrl = defaultCdpBaseUrl(), url = "https://chatgpt.com/", requestId }) => {
      const startedAt = new Date().toISOString();
      try {
        const tab = await openCdpTab({ baseUrl, url });
        const result = withMeta({ ok: true, baseUrl, tab }, { requestId, startedAt });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_OPEN_TAB_FAILED", error: error.message },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_bind_tab",
    {
      title: "Bind ChatGPT CDP tab",
      description:
        "Stores a stable CDP tabId for future ChatGPT CDP tools. This avoids guessing between multiple ChatGPT tabs.",
      inputSchema: {
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        titleContains: z.string().optional(),
        urlContains: z.string().optional(),
        requestId: z.string().optional(),
      },
    },
    async ({
      baseUrl = defaultCdpBaseUrl(),
      sessionName = "default",
      tabId,
      titleContains,
      urlContains = "chatgpt.com",
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const tab = await findCdpTab({ baseUrl, tabId, titleContains, urlContains });
        if (!isChatGptUrl(tab.url)) {
          throw new Error(`CDP_TAB_NOT_CHATGPT: ${tab.url}`);
        }
        const normalizedSessionName = normalizeSessionName(sessionName);
        const bound = {
          sessionName: normalizedSessionName,
          baseUrl,
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          boundAt: new Date().toISOString(),
        };
        await writeBoundCdpTarget(normalizedSessionName, bound);
        const result = withMeta({ ok: true, bound }, { requestId, startedAt });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_BIND_TAB_FAILED", error: error.message },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_get_bound_tab",
    {
      title: "Get bound ChatGPT CDP tab",
      description: "Returns the currently bound CDP ChatGPT tab for a sessionName, if any.",
      inputSchema: {
        sessionName: z.string().optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ sessionName = "default", requestId }) => {
      const startedAt = new Date().toISOString();
      const normalizedSessionName = normalizeSessionName(sessionName);
      const bound = await readBoundCdpTarget(normalizedSessionName);
      const result = withMeta({ ok: true, sessionName: normalizedSessionName, bound }, { requestId, startedAt });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_get_state",
    {
      title: "Get ChatGPT CDP state",
      description:
        "Returns structured state for a bound or explicit ChatGPT CDP tab, including prompt, attachments, generation state, and latest assistant text.",
      inputSchema: {
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        maxChars: z.number().int().min(100).max(200000).optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      maxChars = 20000,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        const state = await getCdpState({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          maxChars,
        });
        const result = withMeta({ ...state, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, {
          requestId,
          startedAt,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_GET_STATE_FAILED", error: error.message },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_read",
    {
      title: "Read ChatGPT tab through CDP",
      description:
        "Reads text from a bound or explicit ChatGPT CDP tab. Works even when the tab is not active.",
      inputSchema: {
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        maxChars: z.number().int().min(100).max(200000).optional(),
        mode: z.enum(["raw", "structured", "combined"]).optional(),
        maxTurns: z.number().int().min(1).max(200).optional(),
        maxCharsPerTurn: z.number().int().min(100).max(100000).optional(),
        includeRawFallback: z.boolean().optional(),
        includeText: z.boolean().optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      maxChars = 20000,
      mode = "raw",
      maxTurns = 6,
      maxCharsPerTurn = 6000,
      includeRawFallback = false,
      includeText = true,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        const read = await readCdpPage({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          maxChars,
          mode,
          maxTurns,
          maxCharsPerTurn,
          includeRawFallback,
          includeText,
        });
        const result = withMeta(
          { ...read, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_READ_FAILED", error: error.message },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_send",
    {
      title: "Send ChatGPT message through CDP",
      description:
        "Writes and optionally submits a message in a bound or explicit ChatGPT CDP tab without using mouse focus.",
      inputSchema: {
        message: z.string().optional(),
        messageBase64: z.string().optional(),
        submit: z.boolean().optional(),
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        allowSuspiciousText: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
        allowAttachments: z.boolean().optional(),
        replaceDraft: z.boolean().optional(),
        waitForSendReadyMs: z.number().int().min(1000).max(120000).optional(),
        ownTurnWaitMs: z.number().int().min(1000).max(120000).optional(),
        lockTimeoutMs: z.number().int().min(5000).max(600000).optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      message,
      messageBase64,
      submit = true,
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      allowSuspiciousText = false,
      dryRun = false,
      force = false,
      allowAttachments = false,
      replaceDraft = false,
      waitForSendReadyMs = 30000,
      ownTurnWaitMs = 10000,
      lockTimeoutMs = 120000,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      const auditContext = { sessionName, baseUrl, tabId, submit };
      try {
        const messageText = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
        const messageHash = sha256(messageText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        auditContext.messageHash = messageHash;
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        Object.assign(auditContext, {
          sessionName: target.sessionName,
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          binding: target.binding,
          bindingWarnings: target.bindingWarnings,
        });
        if (dryRun) {
          const state = await getCdpState({ baseUrl: target.baseUrl, tabId: target.tabId });
          const result = withMeta(
            {
              ok: true,
              dryRun: true,
              wouldSubmit: submit,
              baseUrl: target.baseUrl,
              tabId: target.tabId ?? null,
              sessionName: target.sessionName,
              binding: target.binding,
              bindingWarnings: target.bindingWarnings,
              messageHash,
              state,
            },
            { requestId, startedAt },
          );
          await auditCdpWrite("chatgpt_cdp_send", result, auditContext);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }
  
        const sent = await sendCdpMessage({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          message: messageText,
          submit,
          force,
          allowAttachments,
          replaceDraft,
          waitForSendReadyMs,
          ownTurnWaitMs,
          lockTimeoutMs,
        });
        const result = withMeta(
          { ...sent, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_send", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !sent.ok,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_SEND_FAILED", error: error.message },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_send", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_send_and_wait",
    {
      title: "Send ChatGPT message through CDP and wait",
      description:
        "Submits a message through a bound or explicit ChatGPT CDP tab, verifies the user turn, then waits for a stable assistant reply.",
      inputSchema: {
        message: z.string().optional(),
        messageBase64: z.string().optional(),
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        allowSuspiciousText: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
        allowAttachments: z.boolean().optional(),
        replaceDraft: z.boolean().optional(),
        waitForSendReadyMs: z.number().int().min(1000).max(120000).optional(),
        ownTurnWaitMs: z.number().int().min(1000).max(120000).optional(),
        timeoutMs: z.number().int().min(5000).max(300000).optional(),
        pollMs: z.number().int().min(250).max(10000).optional(),
        stableMs: z.number().int().min(500).max(15000).optional(),
        lockTimeoutMs: z.number().int().min(5000).max(600000).optional(),
        requireOwnTurn: z.boolean().optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      message,
      messageBase64,
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      allowSuspiciousText = false,
      dryRun = false,
      force = false,
      allowAttachments = false,
      replaceDraft = false,
      waitForSendReadyMs = 30000,
      ownTurnWaitMs = 10000,
      timeoutMs = 120000,
      pollMs = 750,
      stableMs = 2000,
      lockTimeoutMs,
      requireOwnTurn = true,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      const auditContext = { sessionName, baseUrl, tabId, submit: true };
      try {
        const messageText = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
        const messageHash = sha256(messageText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        auditContext.messageHash = messageHash;
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        Object.assign(auditContext, {
          sessionName: target.sessionName,
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          binding: target.binding,
          bindingWarnings: target.bindingWarnings,
        });
        if (dryRun) {
          const state = await getCdpState({ baseUrl: target.baseUrl, tabId: target.tabId });
          const result = withMeta(
            {
              ok: true,
              dryRun: true,
              wouldSubmit: true,
              wouldWait: true,
              baseUrl: target.baseUrl,
              tabId: target.tabId ?? null,
              sessionName: target.sessionName,
              binding: target.binding,
              bindingWarnings: target.bindingWarnings,
              messageHash,
              state,
            },
            { requestId, startedAt },
          );
          await auditCdpWrite("chatgpt_cdp_send_and_wait", result, auditContext);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }
  
        const result = await sendCdpMessageAndWait({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          message: messageText,
          force,
          allowAttachments,
          replaceDraft,
          waitForSendReadyMs,
          ownTurnWaitMs,
          timeoutMs,
          pollMs,
          stableMs,
          lockTimeoutMs,
          requireOwnTurn,
        });
        const withTiming = withMeta(
          { ...result, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_send_and_wait", withTiming, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
          structuredContent: withTiming,
          isError: !result.ok,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_SEND_AND_WAIT_FAILED", error: error.message },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_send_and_wait", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_upload_file",
    {
      title: "Upload file to ChatGPT through CDP",
      description:
        "Attempts to attach a local file to a bound or explicit ChatGPT CDP tab without opening the Windows file picker.",
      inputSchema: {
        filePath: z.string(),
        allowedExtensions: z.array(z.string()).optional(),
        maxBytes: z.number().int().min(1).optional(),
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        waitForUploadMs: z.number().int().min(1000).max(120000).optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
        lockTimeoutMs: z.number().int().min(5000).max(600000).optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      filePath,
      allowedExtensions,
      maxBytes,
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      waitForUploadMs = 15000,
      dryRun = false,
      force = false,
      lockTimeoutMs = 120000,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      const auditContext = { sessionName, baseUrl, tabId };
      try {
        const validation = await verifyLocalUploadFile(filePath, { allowedExtensions, maxBytes });
        Object.assign(auditContext, {
          fileSha256: validation.sha256,
          fileExtension: validation.extension,
          fileLength: validation.length,
        });
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        Object.assign(auditContext, {
          sessionName: target.sessionName,
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          binding: target.binding,
          bindingWarnings: target.bindingWarnings,
        });
        if (!validation.safeForUpload) {
          const result = withMeta(
            {
              ok: false,
              errorCode: "UPLOAD_FILE_BLOCKED",
              message: "Refusing to upload because the file failed extension or size checks.",
              validation,
            },
            { requestId, startedAt },
          );
          await auditCdpWrite("chatgpt_cdp_upload_file", result, auditContext);
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
              baseUrl: target.baseUrl,
              tabId: target.tabId ?? null,
              sessionName: target.sessionName,
              binding: target.binding,
              bindingWarnings: target.bindingWarnings,
              validation,
            },
            { requestId, startedAt },
          );
          await auditCdpWrite("chatgpt_cdp_upload_file", result, auditContext);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }
  
        const upload = await uploadCdpFile({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          filePath: validation.fullName,
          waitForUploadMs,
          force,
          lockTimeoutMs,
        });
        const result = withMeta(
          { ...upload, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings, validation },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_upload_file", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !upload.ok,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_UPLOAD_FAILED", error: error.message },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_upload_file", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
  
  server.registerTool(
    "chatgpt_cdp_remove_attachments",
    {
      title: "Remove ChatGPT CDP attachments",
      description:
        "Removes pending composer attachments from a bound or explicit ChatGPT CDP tab without using UIA.",
      inputSchema: {
        attachmentNameContains: z.string().optional(),
        removeAll: z.boolean().optional(),
        maxAttachments: z.number().int().min(1).max(20).optional(),
        waitMs: z.number().int().min(1000).max(60000).optional(),
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        lockTimeoutMs: z.number().int().min(5000).max(600000).optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      attachmentNameContains,
      removeAll = false,
      maxAttachments = 10,
      waitMs = 10000,
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      lockTimeoutMs = 120000,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      const auditContext = {
        sessionName,
        baseUrl,
        tabId,
        attachmentNameContains,
        removeAll,
        maxAttachments,
      };
      try {
        if (!attachmentNameContains && !removeAll) {
          const result = withMeta(
            {
              ok: false,
              errorCode: "ATTACHMENT_FILTER_REQUIRED",
              message: "Provide attachmentNameContains or set removeAll=true.",
            },
            { requestId, startedAt },
          );
          await auditCdpWrite("chatgpt_cdp_remove_attachments", result, auditContext);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: true,
          };
        }
  
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        Object.assign(auditContext, {
          sessionName: target.sessionName,
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          binding: target.binding,
          bindingWarnings: target.bindingWarnings,
        });
        const removed = await removeCdpAttachments({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          attachmentNameContains,
          removeAll,
          maxAttachments,
          waitMs,
          lockTimeoutMs,
        });
        const result = withMeta(
          { ...removed, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_remove_attachments", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !removed.ok,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_REMOVE_ATTACHMENTS_FAILED", error: error.message },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_remove_attachments", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }
    },
  );
}
