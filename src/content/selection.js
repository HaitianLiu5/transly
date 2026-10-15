(function initializeSelectionTranslation() {
  if (window.__translySelectionTranslationInstalled) return;
  window.__translySelectionTranslationInstalled = true;

  const MAX_SELECTION_CHARS = 5_000;
  const MAX_CONTEXT_CHARS = 1_800;
  const BLOCK_SELECTOR = "p,li,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6,article,main,section,div";
  let snapshot = null;
  let host = null;
  let shadow = null;
  let trigger = null;
  let panel = null;
  let selectionTranslationEnabled = true;
  let selectionIconEnabled = false;
  let selectionShortcutStyle = "dot";
  let uiLanguage = "auto";
  let lastRequest = null;
  let lastTargetLanguage = "";

  document.addEventListener("pointerdown", (event) => {
    if (event.composedPath().includes(host)) return;
    hideTrigger();
  }, true);
  document.addEventListener("pointerup", () => setTimeout(refreshSelection, 0), true);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Shift" || event.shiftKey) setTimeout(refreshSelection, 0);
  }, true);
  window.addEventListener("scroll", hideTrigger, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) panel.hidden = true;
  }, true);

  void loadSelectionIconPreference();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes.uiLanguage) {
      uiLanguage = changes.uiLanguage.newValue || "auto";
      applyLabels();
    }
    if (changes.selectionTranslationEnabled) {
      selectionTranslationEnabled = changes.selectionTranslationEnabled.newValue !== false;
    }
    if (changes.selectionIconEnabled) {
      selectionIconEnabled = changes.selectionIconEnabled.newValue !== false;
    }
    if (changes.selectionShortcutStyle) {
      selectionShortcutStyle = normalizeShortcutStyle(changes.selectionShortcutStyle.newValue);
    }
    if (!changes.selectionTranslationEnabled && !changes.selectionIconEnabled && !changes.selectionShortcutStyle) return;
    if (selectionTranslationEnabled && selectionIconEnabled) refreshSelection();
    else hideSelectionUi();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TRANSLY_GET_SELECTION_STATE") {
      if (!selectionTranslationEnabled) {
        sendResponse({ ok: true, data: { available: false, disabled: true, textChars: 0, preview: "" } });
        return false;
      }
      const current = readSelection();
      if (current) snapshot = current;
      sendResponse({
        ok: true,
        data: {
          available: Boolean(current || snapshot?.text),
          textChars: (current || snapshot)?.text?.length || 0,
          preview: String((current || snapshot)?.text || "").slice(0, 120)
        }
      });
      return false;
    }

    if (message?.type === "TRANSLY_TRANSLATE_SELECTION") {
      if (!selectionTranslationEnabled) {
        sendResponse({ ok: false, error: localizedText("disabled") });
        return false;
      }
      const current = readSelection();
      const suppliedText = normalizeText(message.selectionText);
      const target = current || (snapshot?.text === suppliedText ? snapshot : null) || (suppliedText
        ? { text: suppliedText, context: "", rect: fallbackRect() }
        : snapshot);
      if (!target?.text) {
        sendResponse({ ok: false, error: localizedText("selectFirst") });
        return false;
      }
      if (target.text.length > MAX_SELECTION_CHARS) {
        sendResponse({ ok: false, error: localizedText("tooLong") });
        return false;
      }
      snapshot = target;
      sendResponse({ ok: true, data: { status: "started" } });
      void translateSelection(target, message.targetLanguage).catch((error) => renderError(error, target.rect));
      return false;
    }

    return false;
  });

  function refreshSelection() {
    if (!selectionTranslationEnabled) {
      hideSelectionUi();
      return;
    }
    const current = readSelection();
    if (!current || current.text.length > MAX_SELECTION_CHARS) {
      hideTrigger();
      return;
    }
    snapshot = current;
    if (selectionIconEnabled) showTrigger(current.endpointRect || current.rect);
    else hideTrigger();
  }

  async function loadSelectionIconPreference() {
    const response = await runtimeMessage({ type: "TRANSLY_GET_SETTINGS" });
    selectionTranslationEnabled = response?.ok
      ? response.data?.selectionTranslationEnabled !== false
      : true;
    selectionIconEnabled = response?.ok ? response.data?.selectionIconEnabled !== false : true;
    selectionShortcutStyle = normalizeShortcutStyle(response?.data?.selectionShortcutStyle);
    uiLanguage = response?.data?.uiLanguage || "auto";
    applyLabels();
    if (selectionTranslationEnabled && selectionIconEnabled) refreshSelection();
  }

  function readSelection() {
    const selection = window.getSelection?.();
    const text = normalizeText(selection?.toString());
    if (!selection?.rangeCount || !text) return null;
    const range = selection.getRangeAt(0);
    const rect = normalizeRect(range.getBoundingClientRect());
    const endpointRect = selectionEndpointRect(selection, range);
    const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!(node instanceof Element) || node.closest("[data-transly-selection-ui]")) return null;
    return {
      text,
      context: surroundingContext(node, text),
      rect,
      endpointRect
    };
  }

  function surroundingContext(node, text) {
    let block = node.closest(BLOCK_SELECTOR);
    let context = normalizeText(block?.innerText || block?.textContent);
    if (context.length < Math.min(240, text.length + 80)) {
      block = block?.parentElement?.closest(BLOCK_SELECTOR) || block;
      context = normalizeText(block?.innerText || block?.textContent);
    }
    if (!context) return "";
    if (context.length <= MAX_CONTEXT_CHARS) return context;
    const index = Math.max(0, context.indexOf(text));
    const start = Math.max(0, index - Math.floor((MAX_CONTEXT_CHARS - text.length) / 2));
    return context.slice(start, start + MAX_CONTEXT_CHARS).trim();
  }

  async function translateSelection(target, explicitTargetLanguage) {
    if (!selectionTranslationEnabled) return;
    lastRequest = { target, explicitTargetLanguage };
    hideTrigger();
    renderPanel({ state: "loading", text: localizedText("translating"), rect: target.rect });
    const settingsResponse = await runtimeMessage({ type: "TRANSLY_GET_SETTINGS" });
    if (!settingsResponse?.ok) throw new Error(settingsResponse?.error || localizedText("failed"));
    const targetLanguage = String(explicitTargetLanguage || settingsResponse.data?.targetLanguage || "zh-CN");
    lastTargetLanguage = targetLanguage;
    if (panel?.dataset.state === "loading") panel.querySelector("[data-role='title']").textContent = panelTitle();
    const cacheKey = await selectionCacheKey(target, targetLanguage);
    const response = await runtimeMessage({
      type: "TRANSLY_TRANSLATE",
      payload: {
        mode: "selection",
        targetLanguage,
        context: target.context,
        cacheKey,
        items: [{ id: "selection", text: target.text }]
      }
    });
    if (!selectionTranslationEnabled) return;
    if (!response?.ok) throw new Error(response?.error || localizedText("failed"));
    const translation = String(response.data?.items?.[0]?.translation || "").trim();
    if (!translation) throw new Error(localizedText("failed"));
    renderPanel({ state: "result", text: translation, rect: target.rect });
  }

  function showTrigger(rect) {
    if (!selectionTranslationEnabled || !selectionIconEnabled) {
      hideTrigger();
      return;
    }
    ensureUi();
    panel.hidden = true;
    trigger.dataset.style = selectionShortcutStyle;
    trigger.hidden = false;
    const size = selectionShortcutStyle === "icon" ? 28 : 22;
    const left = clamp(rect.right - size / 2, 3, window.innerWidth - size - 3);
    const top = clamp(rect.bottom - size / 2 + 4, 3, window.innerHeight - size - 3);
    trigger.style.left = `${left}px`;
    trigger.style.top = `${top}px`;
  }

  function hideTrigger() {
    if (trigger) trigger.hidden = true;
  }

  function hideSelectionUi() {
    snapshot = null;
    hideTrigger();
    if (panel) panel.hidden = true;
  }

  function renderPanel({ state, text, detail = "", rect }) {
    ensureUi();
    trigger.hidden = true;
    panel.hidden = false;
    panel.dataset.state = state;
    panel.querySelector("[data-role='title']").textContent = state === "error"
      ? localizedText("errorTitle")
      : panelTitle();
    panel.querySelector("[data-role='body']").textContent = text;
    panel.querySelector("[data-role='detail']").textContent = detail && detail !== text ? detail : "";
    const copyButton = panel.querySelector("[data-role='copy']");
    copyButton.hidden = state !== "result";
    copyButton.dataset.value = state === "result" ? text : "";
    setCopyState(copyButton, false);
    panel.querySelector("[data-role='retry']").hidden = state !== "error" || !lastRequest;
    positionPanel(rect || fallbackRect());
  }

  function renderError(error, rect) {
    const detail = readableError(error);
    renderPanel({ state: "error", text: friendlyError(detail), detail, rect });
  }

  function friendlyError(message) {
    if (/\b(401|403)\b|api key|unauthori[sz]ed|forbidden/i.test(message)) return localizedText("errorKey");
    if (/\b429\b|rate limit|too many requests/i.test(message)) return localizedText("errorRate");
    if (/failed to fetch|networkerror|could not reach|offline|econnrefused|timed out/i.test(message)) return localizedText("errorReach");
    if (/\b5\d\d\b/.test(message)) return localizedText("errorService");
    if (/api url|model name is required|not configured/i.test(message)) return localizedText("errorSetup");
    return message;
  }

  function setCopyState(button, copied) {
    button.dataset.copied = String(copied);
    button.innerHTML = copied ? ICONS.check : ICONS.copy;
    const label = localizedText(copied ? "copied" : "copy");
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function applyLabels() {
    if (!shadow) return;
    const action = localizedText("action");
    trigger.title = action;
    trigger.setAttribute("aria-label", action);
    for (const [role, key] of [["close", "close"], ["retry", "retry"]]) {
      const button = panel.querySelector(`[data-role='${role}']`);
      button.title = localizedText(key);
      button.setAttribute("aria-label", localizedText(key));
    }
    panel.querySelector("[data-role='retry-label']").textContent = localizedText("retry");
    setCopyState(panel.querySelector("[data-role='copy']"), false);
    if (!panel.hidden && panel.dataset.state !== "error") {
      panel.querySelector("[data-role='title']").textContent = panelTitle();
    }
  }

  function panelTitle() {
    const language = TARGET_LANGUAGE_NAMES[lastTargetLanguage];
    return language ? `Transly · ${language}` : "Transly";
  }

  function positionPanel(rect) {
    const width = Math.min(340, window.innerWidth - 16);
    panel.style.width = `${width}px`;
    panel.style.left = `${clamp(rect.left, 8, window.innerWidth - width - 8)}px`;
    panel.style.top = `${clamp(rect.bottom + 10, 8, window.innerHeight - panel.offsetHeight - 8)}px`;
    requestAnimationFrame(() => {
      const below = rect.bottom + 10;
      const top = below + panel.offsetHeight <= window.innerHeight - 8
        ? below
        : rect.top - panel.offsetHeight - 10;
      panel.style.top = `${clamp(top, 8, window.innerHeight - panel.offsetHeight - 8)}px`;
    });
  }

  function ensureUi() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.dataset.translySelectionUi = "true";
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host{all:initial}*{box-sizing:border-box}button{font:inherit;color:inherit}
        .trigger{position:fixed;display:grid;width:22px;height:22px;place-items:center;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto}
        .trigger::before{content:"";display:block;width:10px;height:10px;border:2px solid #fff;border-radius:50%;background:#ffc41a;transition:transform 100ms ease}
        .trigger:hover::before,.trigger:focus-visible::before{transform:scale(1.18)}
        .trigger img{display:none;width:24px;height:24px}
        .trigger[data-style=icon]{width:28px;height:28px}
        .trigger[data-style=icon]::before{display:none}
        .trigger[data-style=icon] img{display:block}
        :focus-visible{outline:3px solid rgb(255 196 26 / 55%);outline-offset:1px}
        .panel{--ink:#1d1d1b;--muted:#6b6963;--line:#e8e6e1;--surface:#fff;--raised:#f3f2ee;--skeleton:#ecebe6;--danger:#b3362c;--success:#1f7a4a;
          position:fixed;display:grid;gap:6px;padding:10px 10px 14px 14px;border:1px solid rgb(29 29 27 / 10%);border-radius:12px;background:var(--surface);color:var(--ink);
          box-shadow:0 16px 40px rgb(20 20 18 / 16%),0 2px 8px rgb(20 20 18 / 8%);
          font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Noto Sans SC",sans-serif;-webkit-font-smoothing:antialiased;
          pointer-events:auto;animation:panel-in 140ms ease-out}
        @media (prefers-color-scheme:dark){.panel{--ink:#f1f0ec;--muted:#a8a69f;--line:#3a3935;--surface:#1e1e1c;--raised:#2a2a27;--skeleton:#31312e;--danger:#ff8b7b;--success:#4cc38a;
          border-color:rgb(255 255 255 / 10%);box-shadow:0 16px 40px rgb(0 0 0 / 50%),0 2px 8px rgb(0 0 0 / 30%)}}
        @keyframes panel-in{from{opacity:0;transform:translateY(4px)}}
        .head{display:flex;align-items:center;gap:8px;min-height:28px}
        .brand{display:block;width:16px;height:16px;flex:none}
        .title{flex:1;min-width:0;overflow:hidden;color:var(--muted);font-size:12.5px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
        .panel[data-state=error] .title{color:var(--danger)}
        .actions{display:flex;flex:none;gap:2px}
        .icon{display:grid;width:28px;height:28px;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:var(--muted);cursor:pointer}
        .icon:hover{background:var(--raised);color:var(--ink)}
        .icon[data-copied=true]{color:var(--success)}
        .icon svg,.retry svg{display:block}
        .body{max-height:260px;overflow:auto;padding-right:4px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.6;user-select:text}
        .panel[data-state=error] .body{font-size:14px;line-height:1.5}
        .panel[data-state=loading] .body{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
        .skeleton{display:none;gap:9px;padding:6px 4px 2px 0}
        .panel[data-state=loading] .skeleton{display:grid}
        .skeleton span{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--skeleton) 25%,var(--raised) 50%,var(--skeleton) 75%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
        .skeleton span:last-child{width:58%}
        @keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
        .detail{max-height:76px;overflow:auto;margin-right:4px;padding:7px 9px;border-radius:7px;background:var(--raised);color:var(--muted);font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;user-select:text}
        .detail:empty{display:none}
        .panel:not([data-state=error]) .detail{display:none}
        .retry{display:inline-flex;width:fit-content;height:30px;align-items:center;gap:6px;margin-top:4px;padding:0 11px 0 9px;border:1px solid var(--line);border-radius:8px;background:var(--surface);cursor:pointer;font-size:13px;font-weight:500}
        .retry:hover{background:var(--raised)}
        [hidden]{display:none!important}
        @media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}
      </style>
      <button class="trigger" data-style="dot" type="button" hidden>
        <img src="${chrome.runtime.getURL("assets/icons/transly-player.svg")}" alt="">
      </button>
      <section class="panel" role="dialog" aria-live="polite" hidden>
        <div class="head">
          <img class="brand" src="${chrome.runtime.getURL("assets/icons/transly-player.svg")}" alt="">
          <span class="title" data-role="title"></span>
          <div class="actions">
            <button class="icon" data-role="copy" type="button"></button>
            <button class="icon" data-role="close" type="button">${ICONS.close}</button>
          </div>
        </div>
        <div class="skeleton" aria-hidden="true"><span></span><span></span></div>
        <div class="body" data-role="body"></div>
        <div class="detail" data-role="detail"></div>
        <button class="retry" data-role="retry" type="button" hidden>${ICONS.retry}<span data-role="retry-label"></span></button>
      </section>`;
    trigger = shadow.querySelector(".trigger");
    panel = shadow.querySelector(".panel");
    const openSelectionTranslation = () => {
      if (snapshot) void translateSelection(snapshot).catch((error) => renderError(error, snapshot.rect));
    };
    trigger.addEventListener("pointerenter", openSelectionTranslation);
    trigger.addEventListener("click", openSelectionTranslation);
    panel.querySelector("[data-role='close']").addEventListener("click", () => { panel.hidden = true; });
    panel.querySelector("[data-role='copy']").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const value = button.dataset.value || "";
      if (!value) return;
      await copyText(value);
      setCopyState(button, true);
      setTimeout(() => setCopyState(button, false), 1_200);
    });
    panel.querySelector("[data-role='retry']").addEventListener("click", () => {
      if (!lastRequest) return;
      const { target, explicitTargetLanguage } = lastRequest;
      void translateSelection(target, explicitTargetLanguage).catch((error) => renderError(error, target.rect));
    });
    (document.documentElement || document.body).append(host);
    applyLabels();
  }

  const icon = (paths, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    copy: icon('<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    check: icon('<path d="M20 6 9 17l-5-5"/>'),
    close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    retry: icon('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', 14)
  };
  const TARGET_LANGUAGE_NAMES = {
    "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어",
    es: "Español", de: "Deutsch", fr: "Français", "pt-BR": "Português"
  };

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: localizedText("failed") });
      });
    });
  }

  async function selectionCacheKey(target, targetLanguage) {
    const value = `selection:v1:${targetLanguage}:${target.text}:${target.context}`;
    if (!crypto?.subtle) return value;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `selection:v1:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function localizedText(key) {
    const language = uiLanguage === "en" || uiLanguage === "zh-CN"
      ? uiLanguage
      : (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    const copy = language === "zh-CN" ? {
      action: "翻译所选文本", translating: "翻译中…", failed: "翻译失败",
      errorTitle: "无法翻译", selectFirst: "请先选择文本。", tooLong: "所选文本过长。", disabled: "划词翻译已关闭。",
      copy: "复制译文", copied: "已复制", close: "关闭", retry: "重试",
      errorKey: "翻译服务拒绝了 API 密钥。请在 Transly 设置中检查。",
      errorRate: "翻译服务暂时限制了请求频率。请稍等片刻后重试。",
      errorReach: "无法连接翻译服务。请确认服务正在运行。",
      errorService: "翻译服务出现问题。请稍后重试。",
      errorSetup: "请先在 Transly 设置中连接翻译服务。"
    } : {
      action: "Translate selection", translating: "Translating…", failed: "Translation failed",
      errorTitle: "Couldn't translate", selectFirst: "Select text first.", tooLong: "The selection is too long.", disabled: "Selection translation is turned off.",
      copy: "Copy translation", copied: "Copied", close: "Close", retry: "Try again",
      errorKey: "The translation service rejected the API key. Check it in Transly settings.",
      errorRate: "The translation service is limiting requests. Wait a moment, then try again.",
      errorReach: "Couldn't reach the translation service. Make sure it's running.",
      errorService: "The translation service ran into a problem. Try again in a moment.",
      errorSetup: "Connect a translation service in Transly settings first."
    };
    return copy[key] || "";
  }

  function readableError(error) {
    const value = String(error?.message || error || localizedText("failed"));
    return value.replace(/^\[[A-Z0-9_]+]\s*/, "");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeRect(rect) {
    if (rect && (rect.width || rect.height)) return rect;
    return fallbackRect();
  }

  function selectionEndpointRect(selection, range) {
    if (selection.focusNode) {
      try {
        const caret = document.createRange();
        caret.setStart(selection.focusNode, selection.focusOffset);
        caret.collapse(true);
        const caretRect = caret.getClientRects()[0] || caret.getBoundingClientRect();
        if (caretRect && caretRect.height) return caretRect;
      } catch {}
    }
    const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height);
    if (!rects.length) return normalizeRect(range.getBoundingClientRect());
    const focusAtStart = selection.focusNode === range.startContainer
      && selection.focusOffset === range.startOffset;
    const rect = focusAtStart ? rects[0] : rects.at(-1);
    const x = focusAtStart ? rect.left : rect.right;
    return { left: x, right: x, top: rect.top, bottom: rect.bottom, width: 0, height: rect.height };
  }

  function normalizeShortcutStyle(value) {
    return value === "icon" ? "icon" : "dot";
  }

  function fallbackRect() {
    return { left: Math.max(8, window.innerWidth / 2 - 170), right: window.innerWidth / 2, top: 72, bottom: 72, width: 0, height: 0 };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(Math.max(min, max), Number(value) || min));
  }
})();
