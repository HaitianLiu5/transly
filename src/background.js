import {
  providerSummary,
  readProviderConfig,
  validateProviderConnection,
  validateProviderConfig,
  writeProviderConfig
} from "./provider/provider-config.js";
import { listProviderModels, testProvider } from "./provider/openai-compatible.js";
import { discoverLocalProviders } from "./provider/local-provider-discovery.js";
import { connectLane } from "./provider/lane-native.js";
import { createTranslationService } from "./provider/translation-service.js";

const DEFAULT_SETTINGS = Object.freeze({
  uiLanguage: "auto",
  targetLanguage: "zh-CN",
  selectionTranslationEnabled: true,
  selectionIconEnabled: true,
  selectionShortcutStyle: "dot",
  articleDisplayMode: "bilingual",
  articleBatchChars: 28000,
  articleBatchMaxItems: 28,
  articleContextChars: 36000,
  enableArticleAuditLoop: true,
  articleAuditMaxBlocks: 60,
  articleAuditMaxRepairItems: 20,
  subtitleEnabled: false,
  subtitleDisplayMode: "bilingual",
  subtitleLanguageOrder: "source-first",
  subtitleSourceFontSizePx: 25,
  subtitleTranslationFontSizePx: 30,
  subtitlePositionPercent: 6,
  subtitleBackgroundOpacity: 0.76,
  subtitleBatchChars: 1200,
  subtitleBatchMaxItems: 12
});
const PROVIDER_STATUS_TIMEOUT_MS = 3_000;
const SELECTION_CONTEXT_MENU_ID = "transly-translate-selection";

export function registerBackground(chromeApi, dependencies = {}) {
  const service = dependencies.service || createTranslationService();
  const checkProvider = dependencies.testProvider || testProvider;
  const listModels = dependencies.listProviderModels || listProviderModels;
  const discoverProviders = dependencies.discoverLocalProviders || discoverLocalProviders;
  const connectLaneProvider = dependencies.connectLane || (() => connectLane(chromeApi));
  const activeTranslationRuns = new Map();
  let diagnosticWrite = Promise.resolve();

  registerSelectionContextMenu(chromeApi);

  Promise.resolve(chromeApi.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })).catch(() => {
    // Chrome 105+ supports this. Request handling still validates every caller.
  });

  chromeApi.runtime.onInstalled?.addListener((details) => {
    registerSelectionContextMenu(chromeApi);
    if (details.reason === "install") chromeApi.runtime.openOptionsPage();
  });

  chromeApi.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== SELECTION_CONTEXT_MENU_ID || !Number.isInteger(tab?.id)) return;
    const message = {
      type: "TRANSLY_TRANSLATE_SELECTION",
      selectionText: String(info.selectionText || ""),
      source: "context-menu"
    };
    const callback = () => void chromeApi.runtime.lastError;
    if (Number.isInteger(info.frameId)) {
      chromeApi.tabs.sendMessage(tab.id, message, { frameId: info.frameId }, callback);
    } else {
      chromeApi.tabs.sendMessage(tab.id, message, callback);
    }
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chromeApi.runtime.id) return false;

    if (message?.type === "TRANSLY_PROVIDER_STATUS") {
      readProviderConfig(chromeApi.storage.local)
        .then(async (config) => {
          if (!providerSummary(config).configured) {
            try {
              const lane = await connectLaneProvider();
              config = await writeProviderConfig(chromeApi.storage.local, lane.config);
            } catch {
              return providerSummary(config);
            }
          }
          const summary = providerSummary(config);
          try {
            await checkProvider(validateProviderConfig(config), {
              timeoutMs: PROVIDER_STATUS_TIMEOUT_MS
            });
            return { ...summary, available: true };
          } catch (error) {
            return { ...summary, available: false, error: formatError(error) };
          }
        })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_GET_PROVIDER_SETTINGS") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      readProviderConfig(chromeApi.storage.local)
        .then((config) => sendResponse({ ok: true, data: config }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_SAVE_PROVIDER_SETTINGS") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      writeProviderConfig(chromeApi.storage.local, message.payload)
        .then((config) => sendResponse({ ok: true, data: providerSummary(config) }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_TEST_PROVIDER") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      Promise.resolve()
        .then(() => validateProviderConfig(message.payload))
        .then((config) => checkProvider(config))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_LIST_PROVIDER_MODELS") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      Promise.resolve()
        .then(() => validateProviderConnection(message.payload))
        .then((config) => listModels(config))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_LIST_CONFIGURED_MODELS") {
      if (!isExtensionPage(chromeApi, sender)) return false;
      readProviderConfig(chromeApi.storage.local)
        .then(async (config) => {
          const validConfig = validateProviderConfig(config);
          const data = await listModels(validConfig);
          return {
            models: data.models || [],
            currentModel: validConfig.model,
            summary: providerSummary(validConfig)
          };
        })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_SELECT_PROVIDER_MODEL") {
      if (!isExtensionPage(chromeApi, sender)) return false;
      const nextModel = String(message.model || "").trim();
      if (!nextModel) {
        sendResponse({ ok: false, error: "Model name is required." });
        return false;
      }
      readProviderConfig(chromeApi.storage.local)
        .then((config) => writeProviderConfig(chromeApi.storage.local, {
          ...config,
          model: nextModel
        }))
        .then((config) => sendResponse({ ok: true, data: providerSummary(config) }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_DISCOVER_LOCAL_PROVIDERS") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      Promise.resolve(discoverProviders())
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_CONNECT_LANE") {
      if (!isExtensionPage(chromeApi, sender)) return false;
      Promise.resolve()
        .then(() => connectLaneProvider())
        .then(async (lane) => {
          const config = await writeProviderConfig(chromeApi.storage.local, lane.config);
          return {
            config,
            models: lane.models,
            summary: providerSummary(config)
          };
        })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_TRANSLATE") {
      const operation = message.payload?.mode === "article"
        ? trackTranslationOperation(activeTranslationRuns, sender, message.payload)
        : idleTranslationOperation();
      withProviderConfig(chromeApi, (config) => service.translate(message.payload, {
        config,
        signal: operation.signal,
        sessionId: translationSessionId(message.payload),
        onProgress(data) {
          relayTranslationProgress(chromeApi, sender, data);
        }
      }))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }))
        .finally(operation.release);
      return true;
    }

    if (message?.type === "TRANSLY_AUDIT_ARTICLE") {
      const operation = trackTranslationOperation(activeTranslationRuns, sender, message.payload);
      withProviderConfig(chromeApi, (config) => service.audit(message.payload, {
        config,
        signal: operation.signal,
        sessionId: translationSessionId(message.payload)
      }))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }))
        .finally(operation.release);
      return true;
    }

    if (message?.type === "TRANSLY_CANCEL_TRANSLATION") {
      const clientRequestId = String(message.payload?.clientRequestId || "").trim();
      const cancelled = cancelTranslationOperation(activeTranslationRuns, sender, clientRequestId);
      sendResponse({ ok: true, data: { cancelled } });
      return false;
    }

    if (message?.type === "TRANSLY_GET_SETTINGS") {
      chromeApi.storage.sync.get(null, (storedSettings) => {
        const error = chromeApi.runtime.lastError;
        const settings = normalizeSettings(storedSettings);
        const migratedFontSizes = {};
        if (storedSettings?.subtitleSourceFontSizePx === undefined && storedSettings?.subtitleSourceFontScale !== undefined) {
          migratedFontSizes.subtitleSourceFontSizePx = settings.subtitleSourceFontSizePx;
        }
        if (
          storedSettings?.subtitleTranslationFontSizePx === undefined
          && storedSettings?.subtitleTranslationFontScale !== undefined
        ) {
          migratedFontSizes.subtitleTranslationFontSizePx = settings.subtitleTranslationFontSizePx;
        }
        if (!error && Object.keys(migratedFontSizes).length) chromeApi.storage.sync.set(migratedFontSizes);
        sendResponse(error
          ? { ok: false, error: error.message }
          : { ok: true, data: settings });
      });
      return true;
    }

    if (message?.type === "TRANSLY_SAVE_SETTINGS") {
      chromeApi.storage.sync.set(message.payload || {}, () => {
        const error = chromeApi.runtime.lastError;
        if (!error && (
          Object.hasOwn(message.payload || {}, "uiLanguage")
          || Object.hasOwn(message.payload || {}, "selectionTranslationEnabled")
        )) registerSelectionContextMenu(chromeApi);
        sendResponse(error ? { ok: false, error: error.message } : { ok: true });
      });
      return true;
    }

    if (message?.type === "TRANSLY_RECORD_DIAGNOSTIC") {
      if (!Number.isInteger(sender.tab?.id)) return false;
      diagnosticWrite = diagnosticWrite
        .then(() => appendDiagnosticEvent(chromeApi, sanitizeDiagnostic(message.payload, sender)))
        .catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "TRANSLY_GET_DIAGNOSTICS") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      diagnosticWrite
        .then(() => readDiagnosticEvents(chromeApi))
        .then((events) => sendResponse({ ok: true, data: { events } }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message?.type === "TRANSLY_CLEAR_DIAGNOSTICS") {
      if (!isOptionsPage(chromeApi, sender)) return false;
      diagnosticWrite = diagnosticWrite.then(() => writeDiagnosticEvents(chromeApi, []));
      diagnosticWrite
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    return false;
  });
}

function registerSelectionContextMenu(chromeApi) {
  if (!chromeApi.contextMenus?.removeAll || !chromeApi.contextMenus?.create) return;
  resolveContextMenuConfig(chromeApi).then(({ enabled, title }) => {
    chromeApi.contextMenus.removeAll(() => {
      void chromeApi.runtime.lastError;
      if (!enabled) return;
      chromeApi.contextMenus.create({
        id: SELECTION_CONTEXT_MENU_ID,
        title,
        contexts: ["selection"]
      }, () => void chromeApi.runtime.lastError);
    });
  }).catch(() => {});
}

function resolveContextMenuConfig(chromeApi) {
  return new Promise((resolve) => {
    chromeApi.storage.sync.get(["uiLanguage", "selectionTranslationEnabled"], (stored) => {
      const preference = stored?.uiLanguage;
      const browserLanguage = chromeApi.i18n?.getUILanguage?.() || "en";
      const chinese = preference === "zh-CN"
        || (preference !== "en" && browserLanguage.toLowerCase().startsWith("zh"));
      resolve({
        enabled: stored?.selectionTranslationEnabled !== false,
        title: chinese ? "使用 Transly 翻译所选文本" : "Translate selection with Transly"
      });
    });
  });
}

const DIAGNOSTIC_STORAGE_KEY = "translySubtitleDiagnostics";
const DIAGNOSTIC_EVENT_LIMIT = 30;

async function appendDiagnosticEvent(chromeApi, event) {
  const events = await readDiagnosticEvents(chromeApi);
  events.push(event);
  await writeDiagnosticEvents(chromeApi, events.slice(-DIAGNOSTIC_EVENT_LIMIT));
}

function readDiagnosticEvents(chromeApi) {
  return new Promise((resolve) => {
    if (!chromeApi.storage.session?.get) {
      resolve([]);
      return;
    }
    chromeApi.storage.session.get(DIAGNOSTIC_STORAGE_KEY, (stored) => {
      const events = stored?.[DIAGNOSTIC_STORAGE_KEY];
      resolve(Array.isArray(events) ? events : []);
    });
  });
}

function writeDiagnosticEvents(chromeApi, events) {
  return new Promise((resolve, reject) => {
    if (!chromeApi.storage.session?.set) {
      resolve();
      return;
    }
    chromeApi.storage.session.set({ [DIAGNOSTIC_STORAGE_KEY]: events }, () => {
      const error = chromeApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sanitizeDiagnostic(payload = {}, sender = {}) {
  return {
    recordedAt: Date.now(),
    tabId: sender.tab?.id || null,
    frameId: Number.isInteger(sender.frameId) ? sender.frameId : null,
    pageUrl: String(payload.pageUrl || sender.tab?.url || "").slice(0, 2000),
    pageTitle: String(payload.pageTitle || sender.tab?.title || "").slice(0, 500),
    subtitleEnabled: Boolean(payload.subtitleEnabled),
    subtitleStatus: String(payload.subtitleStatus || "unknown").slice(0, 80),
    subtitleError: String(payload.subtitleError || "").slice(0, 2000),
    subtitleLastError: String(payload.subtitleLastError || "").slice(0, 2000),
    subtitleLastErrorAt: Number(payload.subtitleLastErrorAt) || null,
    subtitleCueCount: Number(payload.subtitleCueCount) || 0,
    subtitleTranslatedCueCount: Number(payload.subtitleTranslatedCueCount) || 0,
    subtitleSourceLanguage: String(payload.subtitleSourceLanguage || "").slice(0, 80),
    subtitleTargetLanguage: String(payload.subtitleTargetLanguage || "").slice(0, 80),
    subtitleSourceType: String(payload.subtitleSourceType || "").slice(0, 80),
    subtitleSourceKey: String(payload.subtitleSourceKey || "").slice(0, 500),
    subtitleSkipReason: String(payload.subtitleSkipReason || "").slice(0, 120),
    subtitleCurrentCueState: String(payload.subtitleCurrentCueState || "none").slice(0, 80)
  };
}

export function normalizeSettings(storedSettings = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  settings.selectionShortcutStyle = storedSettings.selectionShortcutStyle === "icon" ? "icon" : "dot";
  if (storedSettings.subtitleSourceFontSizePx === undefined && storedSettings.subtitleSourceFontScale !== undefined) {
    settings.subtitleSourceFontSizePx = legacySubtitleFontSize(storedSettings.subtitleSourceFontScale);
  }
  if (
    storedSettings.subtitleTranslationFontSizePx === undefined
    && storedSettings.subtitleTranslationFontScale !== undefined
  ) {
    settings.subtitleTranslationFontSizePx = legacySubtitleFontSize(storedSettings.subtitleTranslationFontScale);
  }
  return settings;
}

function legacySubtitleFontSize(scale) {
  const pixelSize = Math.round(Number(scale) * 30);
  return Number.isFinite(pixelSize) ? Math.min(56, Math.max(14, pixelSize)) : 30;
}

async function withProviderConfig(chromeApi, operation) {
  const stored = await readProviderConfig(chromeApi.storage.local);
  const config = validateProviderConfig(stored);
  return operation(config);
}

function relayTranslationProgress(chromeApi, sender, data) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !data || typeof data !== "object") return;
  const message = { type: "TRANSLY_TRANSLATION_PROGRESS", data };
  const callback = () => void chromeApi.runtime.lastError;
  if (Number.isInteger(sender.frameId)) {
    chromeApi.tabs.sendMessage(tabId, message, { frameId: sender.frameId }, callback);
  } else {
    chromeApi.tabs.sendMessage(tabId, message, callback);
  }
}

function trackTranslationOperation(activeRuns, sender, payload = {}) {
  const clientRequestId = String(payload.clientRequestId || "").trim();
  if (!clientRequestId) return { signal: undefined, release() {} };
  const key = translationRunKey(sender, clientRequestId);
  let run = activeRuns.get(key);
  if (!run) {
    run = { controller: new AbortController(), pending: 0 };
    activeRuns.set(key, run);
  }
  run.pending++;
  let released = false;
  return {
    signal: run.controller.signal,
    release() {
      if (released) return;
      released = true;
      run.pending--;
      if (run.pending <= 0 && activeRuns.get(key) === run) activeRuns.delete(key);
    }
  };
}

// An article run's clientRequestId spans the whole run; subtitle batches each
// have their own, so the subtitle runtime sends one sessionId per caption source.
function translationSessionId(payload = {}) {
  const value = String(payload.sessionId || payload.clientRequestId || "").trim();
  return /^[A-Za-z0-9-]{1,80}$/.test(value) ? value : "";
}

function idleTranslationOperation() {
  return { signal: undefined, release() {} };
}

function cancelTranslationOperation(activeRuns, sender, clientRequestId) {
  if (!clientRequestId) return false;
  const run = activeRuns.get(translationRunKey(sender, clientRequestId));
  if (!run) return false;
  run.controller.abort(new Error("Translation stopped."));
  return true;
}

function translationRunKey(sender, clientRequestId) {
  return `${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}:${clientRequestId}`;
}

function isOptionsPage(chromeApi, sender) {
  return sender.url?.startsWith(chromeApi.runtime.getURL("options.html"));
}

function isExtensionPage(chromeApi, sender) {
  return sender.url?.startsWith(chromeApi.runtime.getURL(""));
}

function formatError(error) {
  const code = error?.code ? `[${error.code}] ` : "";
  return `${code}${String(error?.message || error)}`;
}
