import { Select } from "@base-ui/react/select";
import { ArrowLeftRight, Check, ChevronDown, Languages, LoaderCircle, Server, Settings2, Square, TextCursorInput } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterTranslationModels,
  sendRuntimeMessage,
  splitModelName,
  TARGET_LANGUAGES
} from "../../src/ui/extension-api";
import { interfaceLanguageItems, type MessageKey } from "../../src/ui/i18n";
import { resolveActiveArticleTarget, sendToActiveTab, sendToTabFrame } from "../../src/ui/popup-tab";
import { useInterfaceLanguage } from "../../src/ui/use-interface-language";

type ArticleStatus = "idle" | "running" | "translated" | "error";
type ProviderSummary = {
  configured?: boolean;
  available?: boolean;
  error?: string;
  host?: string;
  model?: string;
  provider?: { id?: string; name?: string; icon?: string };
};

const sourceTabId = Number(new URLSearchParams(location.search).get("tabId") || 0);

export function App() {
  const { language, preference, settings, settingsReady, setUiLanguage, t } = useInterfaceLanguage();
  const initialized = useRef(false);
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [displayMode, setDisplayMode] = useState("bilingual");
  const [provider, setProvider] = useState<ProviderSummary>({});
  const [providerChecked, setProviderChecked] = useState(false);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [articleStatus, setArticleStatus] = useState<ArticleStatus>("idle");
  const [articleError, setArticleError] = useState("");
  const [hasTranslation, setHasTranslation] = useState(false);
  const [selectionAvailable, setSelectionAvailable] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const providerConfigured = Boolean(provider.configured);
  const selectionTranslationEnabled = settings?.selectionTranslationEnabled !== false;
  const providerAvailable = provider.available !== false;
  const providerState = !providerChecked
    ? t("checking")
    : !providerConfigured
      ? t("setupRequired")
      : providerAvailable ? t("ready") : t("offline");
  const engineState = !providerConfigured ? "setup" : providerAvailable ? "ready" : "error";
  const uiLanguageItems = useMemo(() => interfaceLanguageItems(language), [language]);

  useEffect(() => {
    if (!settingsReady || initialized.current) return;
    initialized.current = true;
    let active = true;
    Promise.all([loadPageState(), loadSelectionState()]).then(async ([pageState, selectionState]) => {
      if (!active) return;
      setTargetLanguage(settings?.targetLanguage || "zh-CN");
      setDisplayMode(settings?.articleDisplayMode || "bilingual");
      if (pageState?.ok) {
        const data = pageState.data || {};
        const nextStatus = data.articleStatus || (data.articleTranslated ? "translated" : "idle");
        setArticleStatus(normalizeArticleStatus(nextStatus));
        setArticleError(String(data.articleError || ""));
        setHasTranslation(Boolean(data.articleTranslated));
      }
      setSelectionAvailable(Boolean(selectionState?.ok && selectionState.data?.available));
      const response = await sendRuntimeMessage<ProviderSummary>({ type: "TRANSLY_PROVIDER_STATUS" });
      if (!active) return;
      if (response.ok && response.data?.configured) {
        setProvider(response.data);
        setModel(response.data.model || "");
        if (response.data.available === false) setStatusMessage(providerUnavailableMessage(response.data, t));
        else if (pageState?.data?.articleStatus === "error") {
          setStatusMessage(articleFailureMessage(pageState.data.articleError, t));
        }
      } else {
        setProvider({ configured: false, available: false });
        setModel("");
        setStatusMessage(response.error || "");
      }
      setProviderChecked(true);
    });
    return () => { active = false; };
  }, [settings, settingsReady, t]);

  const loadModels = useCallback(async () => {
    if (!providerConfigured || modelsLoaded || modelsLoading) return;
    setModelsLoading(true);
    const response = await sendRuntimeMessage<any>({ type: "TRANSLY_LIST_CONFIGURED_MODELS" });
    if (response.ok) {
      setModels(filterTranslationModels(response.data?.models || []));
      if (response.data?.currentModel) setModel(response.data.currentModel);
      setModelsLoaded(true);
    } else {
      setStatusMessage(response.error || t("loadModelsFailed"));
    }
    setModelsLoading(false);
  }, [modelsLoaded, modelsLoading, providerConfigured, t]);

  async function selectModel(value: string | null) {
    if (!value || value === model) return;
    const previous = model;
    setModel(value);
    const response = await sendRuntimeMessage<ProviderSummary>({
      type: "TRANSLY_SELECT_PROVIDER_MODEL",
      model: value
    });
    if (!response.ok) {
      setModel(previous);
      setStatusMessage(response.error || t("switchModelFailed"));
      return;
    }
    setProvider(response.data || provider);
    setStatusMessage("");
  }

  async function changeLanguage(value: string | null) {
    if (!value) return;
    setTargetLanguage(value);
    setStatusMessage("");
    await sendRuntimeMessage({ type: "TRANSLY_SAVE_SETTINGS", payload: { targetLanguage: value } });
  }

  async function changeInterfaceLanguage(value: string | null) {
    setStatusMessage("");
    await setUiLanguage(value);
  }

  async function toggleDisplayMode() {
    const nextMode = displayMode === "translation-only" ? "bilingual" : "translation-only";
    setDisplayMode(nextMode);
    await sendRuntimeMessage({
      type: "TRANSLY_SAVE_SETTINGS",
      payload: { articleDisplayMode: nextMode }
    });
    try {
      await sendToActiveTab({ type: "TRANSLY_SET_ARTICLE_DISPLAY_MODE", mode: nextMode }, sourceTabId);
    } catch {
      // The saved setting applies when the next translatable page opens.
    }
  }

  function openSettings() {
    chrome.runtime.openOptionsPage();
    window.close();
  }

  async function runPrimaryAction() {
    setStatusMessage("");
    if (needsSetup) {
      openSettings();
      return;
    }
    if (articleStatus === "running") {
      try {
        const response = await sendToActiveTab({ type: "TRANSLY_CANCEL_ARTICLE" }, sourceTabId);
        if (response?.ok === false) throw new Error(response.error || t("translationFailed"));
        const articleTranslated = Boolean(response?.data?.articleTranslated);
        setHasTranslation(articleTranslated);
        setArticleStatus(articleTranslated ? "translated" : "idle");
      } catch (error) {
        setStatusMessage(String((error as Error)?.message || error));
      }
      return;
    }

    if (hasTranslation) {
      setArticleStatus("running");
      try {
        const response = await sendToActiveTab({ type: "TRANSLY_CLEAR_ARTICLE" }, sourceTabId);
        if (response?.ok === false) throw new Error(response.error || t("restoreFailed"));
        setHasTranslation(false);
        setArticleStatus("idle");
      } catch (error) {
        setHasTranslation(true);
        setArticleStatus("translated");
        setStatusMessage(String((error as Error)?.message || error));
      }
      return;
    }

    setArticleStatus("running");
    try {
      const response = await sendToActiveTab({
        type: "TRANSLY_TRANSLATE_ARTICLE",
        targetLanguage,
        articleDisplayMode: displayMode
      }, sourceTabId);
      if (response?.ok === false) throw new Error(response.error || t("translationFailed"));
      setTimeout(() => window.close(), 240);
    } catch (error) {
      setArticleStatus("idle");
      setStatusMessage(String((error as Error)?.message || error));
    }
  }

  async function translateSelection() {
    setStatusMessage("");
    try {
      const response = await sendToActiveTab({
        type: "TRANSLY_TRANSLATE_SELECTION",
        targetLanguage
      }, sourceTabId);
      if (response?.ok === false) throw new Error(response.error || t("selectionTranslationFailed"));
      window.close();
    } catch (error) {
      setStatusMessage(String((error as Error)?.message || error));
    }
  }

  const modelItems = useMemo(() => {
    const values = models.length ? models : model ? [model] : [];
    return values.map((value) => ({ value, label: splitModelName(value).name }));
  }, [model, models]);
  const running = articleStatus === "running";
  const needsSetup = providerChecked && !providerConfigured && !running && !hasTranslation;
  const primaryAction = running ? "stop" : hasTranslation ? "restore" : needsSetup ? "setup" : "translate";
  const primaryLabel = {
    stop: t("stop"),
    restore: t("restore"),
    setup: t("setUpTranslation"),
    translate: t("translate")
  }[primaryAction];
  const primaryAriaLabel = {
    stop: t("stopArticleTranslation"),
    restore: t("restoreOriginalArticle"),
    setup: t("setUpTranslation"),
    translate: t("translateArticle")
  }[primaryAction];
  const providerIcon = provider.provider?.icon
    ? chrome.runtime.getURL(provider.provider.icon)
    : "";
  const namedProvider = Boolean(provider.provider?.id && provider.provider.id !== "custom" && provider.provider.name);
  const providerName = namedProvider ? String(provider.provider?.name) : t("aiProvider");

  return (
    <main className="popup-shell">
      <section className="language-section" aria-label={t("targetLanguage")}>
        <span className="section-label">{t("translateTo")}</span>
        <Select.Root items={TARGET_LANGUAGES} value={targetLanguage} onValueChange={changeLanguage}>
          <Select.Trigger id="targetLanguage" className="compact-select" aria-label={t("targetLanguage")}>
            <Select.Value />
            <Select.Icon className="select-chevron"><ChevronDown size={16} /></Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner
              className="select-positioner"
              align="end"
              alignItemWithTrigger={false}
              collisionPadding={8}
              sideOffset={6}
            >
              <Select.Popup className="select-popup language-popup">
                <Select.List className="select-list">
                  {TARGET_LANGUAGES.map((language) => (
                    <Select.Item
                      className="select-item language-option"
                      key={language.value}
                      value={language.value}
                    >
                      <span className="language-check-slot" aria-hidden="true">
                        <Select.ItemIndicator className="select-check"><Check size={15} /></Select.ItemIndicator>
                      </span>
                      <Select.ItemText className="language-option-label">{language.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </section>

      <section id="engineRow" className="engine-row" data-state={providerChecked ? engineState : "checking"}>
        <div className="provider-mark" role="img" aria-label={providerName}>
          {providerIcon
            ? <img id="providerIcon" src={providerIcon} alt="" />
            : namedProvider
              ? <span id="providerFallback" aria-hidden="true">{providerName.slice(0, 1)}</span>
              : <Server id="providerFallback" size={16} aria-hidden="true" />}
        </div>
        <div className="engine-copy">
          <Select.Root
            items={modelItems}
            value={model || null}
            onValueChange={selectModel}
            onOpenChange={(open) => { if (open) void loadModels(); }}
            disabled={!providerConfigured}
          >
            <Select.Trigger id="popupModelTrigger" className="model-select" aria-label={t("translationModel")}>
              <strong id="modelValue">{splitModelName(model || (providerChecked ? t("notConfigured") : t("checking"))).name}</strong>
              {modelsLoading
                ? <LoaderCircle className="spin" size={14} />
                : providerConfigured && <Select.Icon className="select-chevron"><ChevronDown size={15} /></Select.Icon>}
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner
                className="select-positioner"
                align="start"
                alignItemWithTrigger={false}
                collisionPadding={8}
                sideOffset={7}
              >
                <Select.Popup className="select-popup model-popup">
                  <Select.List id="popupModelList" className="select-list">
                    {modelItems.map((item) => {
                      const parts = splitModelName(item.value);
                      return (
                        <Select.Item
                          className="select-item popup-model-option"
                          data-value={item.value}
                          key={item.value}
                          value={item.value}
                        >
                          <span className="model-option-copy">
                            <span className="model-option-name">{parts.name}</span>
                            {parts.provider && <span className="model-option-provider">{parts.provider}</span>}
                          </span>
                          <Select.ItemIndicator className="select-check"><Check size={15} /></Select.ItemIndicator>
                        </Select.Item>
                      );
                    })}
                    {modelsLoaded && !modelItems.length && <p className="select-empty">{t("noTextModels")}</p>}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
          <div className="provider-meta">
            <span className="provider-status-dot" aria-hidden="true" />
            {providerConfigured && <>
              <span id="providerValue">{providerName}</span>
              <span aria-hidden="true">·</span>
            </>}
            <span id="providerState">{providerState}</span>
          </div>
        </div>
      </section>

      <section className="primary-action-section">
        <div id="primaryActionRow" className="primary-action-row" data-has-translation={hasTranslation}>
          {hasTranslation && (
            <button
              id="articleDisplayMode"
              className="display-mode-action"
              type="button"
              data-mode={displayMode}
              aria-label={displayMode === "bilingual"
                ? t("bilingualViewLabel")
                : t("translationViewLabel")}
              title={displayMode === "bilingual" ? t("switchTranslationOnly") : t("switchBilingual")}
              onClick={toggleDisplayMode}
            >
              <span className="display-mode-glyph" aria-hidden="true">
                {displayMode === "bilingual" ? "文A" : "文"}
              </span>
              <span>{displayMode === "bilingual" ? t("bilingual") : t("translationOnly")}</span>
              <ArrowLeftRight className="display-mode-swap" size={13} aria-hidden="true" />
            </button>
          )}
          <button
            id="translateArticle"
            className="primary-action"
            type="button"
            data-action={primaryAction}
            disabled={!providerChecked && !running && !hasTranslation}
            aria-label={primaryAriaLabel}
            onClick={runPrimaryAction}
          >
            {running && <Square size={12} fill="currentColor" />}
            <span>{primaryLabel}</span>
          </button>
        </div>
        {selectionTranslationEnabled && selectionAvailable && providerConfigured && (
          <button
            id="translateSelection"
            className="selection-action"
            type="button"
            onClick={translateSelection}
          >
            <TextCursorInput size={15} aria-hidden="true" />
            <span>{t("translateSelection")}</span>
          </button>
        )}
        <p id="status" className="inline-status" role="status" aria-live="polite" hidden={!statusMessage}>
          {statusMessage}
        </p>
      </section>

      <footer className="popup-footer">
        <Select.Root items={uiLanguageItems} value={preference} onValueChange={changeInterfaceLanguage}>
          <Select.Trigger
            id="popupUiLanguage"
            className="footer-action"
            aria-label={t("interfaceLanguage")}
            title={t("interfaceLanguage")}
          >
            <Languages size={14} aria-hidden="true" />
            <span>{language === "zh-CN" ? "中文" : "English"}</span>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner
              className="select-positioner"
              align="start"
              alignItemWithTrigger={false}
              collisionPadding={8}
              sideOffset={6}
            >
              <Select.Popup className="select-popup interface-language-popup">
                <Select.List className="select-list">
                  {uiLanguageItems.map((item) => (
                    <Select.Item
                      className="select-item interface-language-option"
                      data-value={item.value}
                      key={item.value}
                      value={item.value}
                    >
                      <Select.ItemIndicator className="select-check"><Check size={15} /></Select.ItemIndicator>
                      <Select.ItemText>{item.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <button
          id="configureProvider"
          className="footer-action"
          type="button"
          title={t("translationSettings")}
          onClick={openSettings}
        >
          <Settings2 size={14} aria-hidden="true" />
          <span>{t("settings")}</span>
        </button>
      </footer>
    </main>
  );
}

async function loadPageState() {
  try {
    const target = await resolveActiveArticleTarget(sourceTabId);
    return await sendToTabFrame(target, { type: "TRANSLY_GET_PAGE_STATE" });
  } catch {
    return { ok: false };
  }
}

async function loadSelectionState() {
  try {
    return await sendToActiveTab({ type: "TRANSLY_GET_SELECTION_STATE" }, sourceTabId);
  } catch {
    return { ok: false };
  }
}

function normalizeArticleStatus(value: string): ArticleStatus {
  return ["running", "translated", "error"].includes(value)
    ? value as ArticleStatus
    : "idle";
}

function providerUnavailableMessage(summary: ProviderSummary, t: (key: MessageKey) => string) {
  const host = String(summary?.host || "").toLowerCase();
  if (host.includes("127.0.0.1") || host.includes("localhost") || host.includes("[::1]")) {
    return t("localProviderOffline");
  }
  return t("providerUnavailable");
}

function articleFailureMessage(error: unknown, t: (key: MessageKey) => string) {
  const message = String(error || "").toLowerCase();
  if (/(failed to fetch|fetch failed|network|connection|econnrefused|503)/.test(message)) {
    return t("providerUnreachable");
  }
  return t("retryOrCheckSettings");
}
