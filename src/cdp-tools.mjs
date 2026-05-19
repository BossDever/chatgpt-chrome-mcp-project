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
    listCdpArtifacts,
    listCdpTabs,
    normalizeSessionName,
    openCdpTab,
    readBoundCdpTarget,
    readCdpPage,
    removeCdpAttachments,
    resolveBoundCdpTarget,
    resolveMessageInput,
    saveCdpGeneratedImage,
    sendCdpMessage,
    sendCdpMessageAndWait,
    sha256,
    uploadCdpFile,
    verifyLocalUploadFile,
    withMeta,
    writeBoundCdpTarget,
  } = deps;

  async function inspectCandidateTab({ baseUrl, tab, maxChars = 1000 }) {
    try {
      const state = await getCdpState({ baseUrl, tabId: tab.id, maxChars });
      return {
        tab,
        ok: Boolean(state?.ok),
        ready: Boolean(state?.state?.hasPrompt),
        loginLikelyRequired: !state?.state?.hasPrompt,
        state: {
          hasPrompt: Boolean(state?.state?.hasPrompt),
          isGenerating: Boolean(state?.state?.isGenerating),
          attachmentCount: state?.state?.attachmentCount ?? 0,
        },
      };
    } catch (error) {
      return {
        tab,
        ok: false,
        ready: false,
        loginLikelyRequired: true,
        errorCode: "CHATGPT_TAB_INSPECTION_FAILED",
        error: error.message,
      };
    }
  }

  async function bindPreparedTab({ baseUrl, sessionName, tab }) {
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
    return bound;
  }

  async function prepareChatGptSession({
    baseUrl = defaultCdpBaseUrl(),
    sessionName = "default",
    launchIfUnavailable = true,
    openIfNoTab = true,
    port = 9222,
    userDataDir = defaultChromeUserDataDir(),
    chromePath,
    waitForReadyMs = 0,
    pollMs = 1000,
  } = {}) {
    const normalizedSessionName = normalizeSessionName(sessionName);
    let status = await cdpStatus({ baseUrl });

    if (!status.ok) {
      if (!launchIfUnavailable) {
        return {
          ok: false,
          ready: false,
          state: "cdp_unavailable",
          errorCode: "CDP_UNAVAILABLE",
          baseUrl,
          sessionName: normalizedSessionName,
          status,
          nextStep: "Launch the dedicated Chrome CDP profile, then run chatgpt_cdp_prepare_session again.",
        };
      }

      const launched = await launchCdpChrome({
        port,
        userDataDir,
        chromePath,
        url: "https://chatgpt.com/",
        waitForReadyMs,
        pollMs,
      });
      const launchedBaseUrl = launched.baseUrl ?? `http://127.0.0.1:${port}`;
      if (launched.ready?.ready && launched.ready?.tab) {
        const bound = await bindPreparedTab({
          baseUrl: launchedBaseUrl,
          sessionName: normalizedSessionName,
          tab: launched.ready.tab,
        });
        return {
          ok: true,
          ready: true,
          state: "ready",
          baseUrl: launchedBaseUrl,
          sessionName: normalizedSessionName,
          bound,
          launched,
          nextStep: "ready",
        };
      }
      return {
        ok: true,
        ready: false,
        state: "login_required",
        actionRequired: "USER_LOGIN",
        errorCode: "CHROME_LAUNCHED_LOGIN_REQUIRED",
        baseUrl: launchedBaseUrl,
        sessionName: normalizedSessionName,
        launched,
        nextStep: "Sign in to ChatGPT in the Chrome window that opened, then run chatgpt_cdp_prepare_session again.",
      };
    }

    let binding = null;
    let bindingWarnings = [];
    try {
      const target = await resolveBoundCdpTarget({
        baseUrl,
        sessionName: normalizedSessionName,
        useBoundTab: true,
        strictBinding: false,
      });
      binding = target.binding;
      bindingWarnings = target.bindingWarnings ?? [];
      const blockingWarnings = bindingWarnings.filter((warning) =>
        ["CDP_BINDING_BASE_URL_OVERRIDDEN", "CDP_BINDING_TAB_ID_MISSING", "CDP_BOUND_TAB_NOT_FOUND", "CDP_BOUND_TAB_NOT_CHATGPT"].includes(warning?.code),
      );
      if (binding && blockingWarnings.length === 0) {
        const state = await getCdpState({ baseUrl: target.baseUrl, tabId: target.tabId, maxChars: 1000 });
        if (state?.state?.hasPrompt) {
          return {
            ok: true,
            ready: true,
            state: "ready",
            baseUrl: target.baseUrl,
            sessionName: normalizedSessionName,
            bound: binding,
            bindingWarnings,
            tab: state.tab,
            nextStep: "ready",
          };
        }
      }
    } catch {
      binding = null;
      bindingWarnings = [];
    }

    const tabs = await listCdpTabs({ baseUrl });
    let candidates = tabs.filter((tab) => isChatGptUrl(tab.url));

    if (candidates.length === 0 && openIfNoTab) {
      const tab = await openCdpTab({ baseUrl, url: "https://chatgpt.com/" });
      candidates = [tab];
    }

    if (candidates.length === 0) {
      return {
        ok: true,
        ready: false,
        state: "no_tab",
        errorCode: "NO_CHATGPT_TAB",
        baseUrl,
        sessionName: normalizedSessionName,
        status,
        nextStep: "Open https://chatgpt.com/ in the dedicated Chrome profile, sign in if needed, then run chatgpt_cdp_prepare_session again.",
      };
    }

    const inspected = await Promise.all(candidates.map((tab) => inspectCandidateTab({ baseUrl, tab })));
    const readyCandidates = inspected.filter((candidate) => candidate.ready);

    if (readyCandidates.length === 1) {
      const bound = await bindPreparedTab({
        baseUrl,
        sessionName: normalizedSessionName,
        tab: readyCandidates[0].tab,
      });
      return {
        ok: true,
        ready: true,
        state: "ready",
        baseUrl,
        sessionName: normalizedSessionName,
        bound,
        tab: readyCandidates[0].tab,
        bindingWarnings,
        nextStep: "ready",
      };
    }

    if (readyCandidates.length > 1) {
      return {
        ok: true,
        ready: false,
        state: "ambiguous_tab",
        errorCode: "AMBIGUOUS_CHATGPT_TAB",
        baseUrl,
        sessionName: normalizedSessionName,
        candidates: readyCandidates.map(({ tab }) => ({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
        })),
        nextStep: "Bind the intended ChatGPT tab by tabId, or close extra ChatGPT tabs and run chatgpt_cdp_prepare_session again.",
      };
    }

    return {
      ok: true,
      ready: false,
      state: "login_required",
      actionRequired: "USER_LOGIN",
      errorCode: "CHATGPT_LOGIN_REQUIRED",
      baseUrl,
      sessionName: normalizedSessionName,
      candidates: inspected.map(({ tab, errorCode, error, state }) => ({
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        errorCode,
        error,
        state,
      })),
      nextStep: "Sign in to ChatGPT in the dedicated Chrome window, then run chatgpt_cdp_prepare_session again.",
    };
  }

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
        waitForReadyMs: z.number().int().min(0).max(900000).optional(),
        pollMs: z.number().int().min(250).max(10000).optional(),
        bindSessionName: z.string().optional(),
        requestId: z.string().optional(),
      },
    },
    async ({
      port = 9222,
      userDataDir = defaultChromeUserDataDir(),
      chromePath,
      url = "https://chatgpt.com/",
      waitForReadyMs = 0,
      pollMs = 1000,
      bindSessionName,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const result = await launchCdpChrome({ port, userDataDir, chromePath, url, waitForReadyMs, pollMs });
        let bound = null;
        if (bindSessionName && result.ready?.ready && result.ready?.tab?.id) {
          const normalizedSessionName = normalizeSessionName(bindSessionName);
          bound = {
            sessionName: normalizedSessionName,
            baseUrl: result.baseUrl,
            tabId: result.ready.tab.id,
            title: result.ready.tab.title,
            url: result.ready.tab.url,
            boundAt: new Date().toISOString(),
          };
          await writeBoundCdpTarget(normalizedSessionName, bound);
        }
        const nextStep = result.ready?.ready
          ? (bound ? `Ready and bound to session '${bound.sessionName}'.` : "Ready. Bind the ChatGPT tab before using CDP tools.")
          : "Log in to ChatGPT in the opened Chrome window, then tell the agent you are done so it can bind/check the tab.";
        const withTiming = withMeta({ ...result, bound, nextStep }, { requestId, startedAt });
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
    "chatgpt_cdp_prepare_session",
    {
      title: "Prepare ChatGPT CDP session",
      description:
        "Guided first-run workflow for ChatGPT CDP: checks/launches Chrome, detects login requirements, binds a ready tab, and returns the next user/agent step.",
      inputSchema: {
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        launchIfUnavailable: z.boolean().optional(),
        openIfNoTab: z.boolean().optional(),
        port: z.number().int().min(1024).max(65535).optional(),
        userDataDir: z.string().optional(),
        chromePath: z.string().optional(),
        waitForReadyMs: z.number().int().min(0).max(900000).optional(),
        pollMs: z.number().int().min(250).max(10000).optional(),
        requestId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({
      baseUrl = defaultCdpBaseUrl(),
      sessionName = "default",
      launchIfUnavailable = true,
      openIfNoTab = true,
      port = 9222,
      userDataDir = defaultChromeUserDataDir(),
      chromePath,
      waitForReadyMs = 0,
      pollMs = 1000,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const prepared = await prepareChatGptSession({
          baseUrl,
          sessionName,
          launchIfUnavailable,
          openIfNoTab,
          port,
          userDataDir,
          chromePath,
          waitForReadyMs,
          pollMs,
        });
        const result = withMeta(prepared, { requestId, startedAt });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !result.ok,
        };
      } catch (error) {
        const result = withMeta(
          {
            ok: false,
            ready: false,
            state: "failed",
            errorCode: "CHATGPT_PREPARE_SESSION_FAILED",
            error: error.message,
            nextStep: "Check Chrome CDP status and rerun chatgpt_cdp_prepare_session.",
          },
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
    "chatgpt_cdp_list_artifacts",
    {
      title: "List visible ChatGPT image/download artifacts",
      description:
        "Read-only CDP diagnostic for visible images, likely generated images, image placeholders, and download-like controls.",
      inputSchema: {
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        maxItems: z.number().int().min(1).max(200).optional(),
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
      maxItems = 50,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        const artifacts = await listCdpArtifacts({ baseUrl: target.baseUrl, tabId: target.tabId, maxItems });
        const result = withMeta(
          {
            ...artifacts,
            sessionName: target.sessionName,
            binding: target.binding,
            bindingWarnings: target.bindingWarnings,
          },
          { requestId, startedAt },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_LIST_ARTIFACTS_FAILED", error: error.message },
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
    "chatgpt_cdp_save_generated_image",
    {
      title: "Save visible ChatGPT generated image",
      description:
        "Saves a visible generated image from a bound or explicit ChatGPT CDP tab. It prefers original source bytes when safe, then falls back to canvas PNG with warnings.",
      inputSchema: {
        baseUrl: z.string().optional(),
        sessionName: z.string().optional(),
        tabId: z.string().optional(),
        useBoundTab: z.boolean().optional(),
        strictBinding: z.boolean().optional(),
        outputDir: z.string().optional(),
        fileNamePrefix: z.string().optional(),
        which: z.enum(["newest", "largest", "index"]).optional(),
        index: z.number().int().min(0).max(200).optional(),
        prefer: z.enum(["auto", "source", "canvas"]).optional(),
        maxPixels: z.number().int().min(1).max(100000000).optional(),
        waitForImageMs: z.number().int().min(1000).max(300000).optional(),
        dryRun: z.boolean().optional(),
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
      baseUrl,
      sessionName = "default",
      tabId,
      useBoundTab = true,
      strictBinding = false,
      outputDir,
      fileNamePrefix = "chatgpt-generated-image",
      which = "newest",
      index = 0,
      prefer = "auto",
      maxPixels = 4096 * 4096,
      waitForImageMs = 30000,
      dryRun = false,
      lockTimeoutMs = 120000,
      requestId,
    }) => {
      const startedAt = new Date().toISOString();
      const auditContext = { sessionName, baseUrl, tabId };
      try {
        const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
        Object.assign(auditContext, {
          sessionName: target.sessionName,
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          binding: target.binding,
          bindingWarnings: target.bindingWarnings,
        });
        const saved = await saveCdpGeneratedImage({
          baseUrl: target.baseUrl,
          tabId: target.tabId,
          outputDir,
          fileNamePrefix,
          which,
          index,
          prefer,
          maxPixels,
          waitForImageMs,
          dryRun,
          lockTimeoutMs,
        });
        const result = withMeta(
          { ...saved, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_save_generated_image", result, auditContext);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !saved.ok,
        };
      } catch (error) {
        const result = withMeta(
          { ok: false, errorCode: "CDP_SAVE_GENERATED_IMAGE_FAILED", error: error.message },
          { requestId, startedAt },
        );
        await auditCdpWrite("chatgpt_cdp_save_generated_image", result, auditContext);
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
