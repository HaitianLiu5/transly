import { Combobox } from "@base-ui/react/combobox";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { Cable, Check, ChevronDown, ChevronRight, Eye, EyeOff, LoaderCircle, Radar, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { sendRuntimeMessage, splitModelName } from "../../src/ui/extension-api";
import { interfaceLanguageItems } from "../../src/ui/i18n";
import { useInterfaceLanguage } from "../../src/ui/use-interface-language";

type Protocol = "auto" | "responses" | "chat-completions";
type SelectionShortcutStyle = "dot" | "icon";
type ProviderConfig = { apiUrl: string; apiKey: string; model: string; protocol: Protocol };
type LocalProvider = {
  apiUrl: string;
  hint?: string;
  authRequired?: boolean;
  models?: string[];
  clientKey?: string;
};
type StatusTone = "neutral" | "success" | "error";
type DiagnosticEvent = {
  recordedAt: number;
  pageUrl: string;
  pageTitle: string;
  subtitleStatus: string;
  subtitleError: string;
  subtitleLastError: string;
  subtitleCueCount: number;
  subtitleTranslatedCueCount: number;
  subtitleSourceLanguage: string;
  subtitleTargetLanguage: string;
  subtitleSourceType: string;
  subtitleSourceKey: string;
  subtitleSkipReason: string;
  subtitleCurrentCueState: string;
};

export function App() {
  const { language, preference, settings, settingsReady, setUiLanguage, t } = useInterfaceLanguage();
  const initialized = useRef(false);
  const debugMode = new URLSearchParams(globalThis.location?.search || "").get("debug") === "1";
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("auto");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelCatalogLoaded, setModelCatalogLoaded] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [savedConfiguration, setSavedConfiguration] = useState(false);
  const [busy, setBusy] = useState<"" | "connect" | "test" | "models">("");
  const [laneBusy, setLaneBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<StatusTone>("neutral");
  const [showSaveWithoutTest, setShowSaveWithoutTest] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState<LocalProvider[]>([]);
  const [discoveryLabel, setDiscoveryLabel] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState("");
  const [selectionTranslationEnabled, setSelectionTranslationEnabled] = useState(true);
  const [selectionIconEnabled, setSelectionIconEnabled] = useState(true);
  const [selectionShortcutStyle, setSelectionShortcutStyle] = useState<SelectionShortcutStyle>("dot");

  const selectedModel = manualModel ? customModel.trim() : model.trim();
  const connection = useMemo(() => ({ apiUrl, apiKey, protocol }), [apiKey, apiUrl, protocol]);
  const uiLanguageItems = useMemo(() => interfaceLanguageItems(language), [language]);
  const selectionShortcutItems = useMemo(() => [
    { value: "dot" as const, label: t("selectionShortcutDot") },
    { value: "icon" as const, label: t("selectionShortcutIcon") }
  ], [t]);
  const protocols = useMemo(() => [
    { value: "auto", label: t("autoDetect") },
    { value: "responses", label: "Responses API" },
    { value: "chat-completions", label: "Chat Completions" }
  ], [t]);

  const showStatus = useCallback((message: string, tone: StatusTone = "neutral") => {
    setStatus(message);
    setStatusTone(tone);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    setSelectionTranslationEnabled(settings?.selectionTranslationEnabled !== false);
    setSelectionIconEnabled(settings?.selectionIconEnabled !== false);
    setSelectionShortcutStyle(settings?.selectionShortcutStyle === "icon" ? "icon" : "dot");
  }, [
    settings?.selectionIconEnabled,
    settings?.selectionShortcutStyle,
    settings?.selectionTranslationEnabled,
    settingsReady
  ]);

  const updateSelectionTranslation = useCallback(async (enabled: boolean) => {
    const previous = selectionTranslationEnabled;
    setSelectionTranslationEnabled(enabled);
    const response = await sendRuntimeMessage({
      type: "TRANSLY_SAVE_SETTINGS",
      payload: { selectionTranslationEnabled: enabled }
    });
    if (!response.ok) {
      setSelectionTranslationEnabled(previous);
      showStatus(response.error || t("settingsSaveFailed"), "error");
    }
  }, [selectionTranslationEnabled, showStatus, t]);

  const updateSelectionIcon = useCallback(async (enabled: boolean) => {
    const previous = selectionIconEnabled;
    setSelectionIconEnabled(enabled);
    const response = await sendRuntimeMessage({
      type: "TRANSLY_SAVE_SETTINGS",
      payload: { selectionIconEnabled: enabled }
    });
    if (!response.ok) {
      setSelectionIconEnabled(previous);
      showStatus(response.error || t("settingsSaveFailed"), "error");
    }
  }, [selectionIconEnabled, showStatus, t]);

  const updateSelectionShortcutStyle = useCallback(async (value: string | null) => {
    const next = value === "icon" ? "icon" : "dot";
    const previous = selectionShortcutStyle;
    setSelectionShortcutStyle(next);
    const response = await sendRuntimeMessage({
      type: "TRANSLY_SAVE_SETTINGS",
      payload: { selectionShortcutStyle: next }
    });
    if (!response.ok) {
      setSelectionShortcutStyle(previous);
      showStatus(response.error || t("settingsSaveFailed"), "error");
    }
  }, [selectionShortcutStyle, showStatus, t]);

  const updateModelChoices = useCallback((values: unknown[], preferred = "") => {
    const nextModels = normalizeModels(values);
    setModels(nextModels);
    const nextModel = preferred;
    if (nextModel && nextModels.includes(nextModel)) {
      setManualModel(false);
      setModel(nextModel);
      setCustomModel("");
    } else if (nextModel) {
      setManualModel(true);
      setCustomModel(nextModel);
      setModel("");
    } else if (nextModels.length) {
      setManualModel(false);
      setModel(chooseDefaultModel(nextModels));
      setCustomModel("");
    } else {
      setManualModel(true);
      setModel("");
    }
  }, []);

  const connectLaneProvider = useCallback(async ({ quiet = false } = {}) => {
    setLaneBusy(true);
    if (!quiet) showStatus(t("connectingLane"));
    const response = await sendRuntimeMessage<any>({ type: "TRANSLY_CONNECT_LANE" });
    setLaneBusy(false);
    if (!response.ok) {
      if (!quiet) showStatus(response.error || t("laneUnavailable"), "error");
      return false;
    }
    const config = response.data.config as ProviderConfig;
    setApiUrl(config.apiUrl);
    setApiKey(config.apiKey);
    setProtocol(config.protocol || "auto");
    updateModelChoices(response.data.models || [], config.model);
    setModelCatalogLoaded(true);
    setSavedConfiguration(true);
    showStatus(t("connectedLane", { model: config.model }), "success");
    return true;
  }, [showStatus, t, updateModelChoices]);

  useEffect(() => {
    if (!settingsReady || initialized.current) return;
    initialized.current = true;
    let active = true;
    sendRuntimeMessage<ProviderConfig>({ type: "TRANSLY_GET_PROVIDER_SETTINGS" })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok || !response.data) {
          showStatus(response.error || t("settingsLoadFailed"), "error");
          return;
        }
        const config = response.data;
        setApiUrl(config.apiUrl || "");
        setApiKey(config.apiKey || "");
        setProtocol(config.protocol || "auto");
        setSavedConfiguration(Boolean(config.apiUrl && config.model));
        if (config.model) updateModelChoices([config.model], config.model);
        if (!config.apiUrl) {
          await connectLaneProvider({ quiet: true });
          return;
        }

        setBusy("models");
        const modelResponse = await sendRuntimeMessage<any>({
          type: "TRANSLY_LIST_PROVIDER_MODELS",
          payload: {
            apiUrl: config.apiUrl,
            apiKey: config.apiKey,
            protocol: config.protocol || "auto"
          }
        });
        if (!active) return;
        setBusy("");
        if (modelResponse.ok) {
          updateModelChoices(modelResponse.data?.models || [], config.model);
          setModelCatalogLoaded(true);
        }
      })
      .finally(() => {
        document.documentElement.dataset.translyOptionsReady = "true";
      });
    return () => { active = false; };
  }, [connectLaneProvider, settingsReady, showStatus, t, updateModelChoices]);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsBusy(true);
    const response = await sendRuntimeMessage<{ events: DiagnosticEvent[] }>({
      type: "TRANSLY_GET_DIAGNOSTICS"
    });
    setDiagnosticsBusy(false);
    if (!response.ok) {
      setDiagnosticsStatus(response.error || "Could not load diagnostics.");
      return;
    }
    setDiagnostics((response.data?.events || []).slice().reverse());
    setDiagnosticsStatus("");
  }, []);

  useEffect(() => {
    if (debugMode) refreshDiagnostics();
  }, [debugMode, refreshDiagnostics]);

  async function clearDiagnostics() {
    setDiagnosticsBusy(true);
    const response = await sendRuntimeMessage({ type: "TRANSLY_CLEAR_DIAGNOSTICS" });
    setDiagnosticsBusy(false);
    if (!response.ok) {
      setDiagnosticsStatus(response.error || "Could not clear diagnostics.");
      return;
    }
    setDiagnostics([]);
    setDiagnosticsStatus("");
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics.slice().reverse(), null, 2));
      setDiagnosticsStatus("Copied diagnostic report.");
    } catch {
      setDiagnosticsStatus("Could not copy diagnostics.");
    }
  }

  function resetModelChoices() {
    setModels([]);
    setModel("");
    setCustomModel("");
    setManualModel(false);
    setModelCatalogLoaded(false);
    setShowSaveWithoutTest(false);
  }

  async function requestModels(nextConnection = connection) {
    const response = await sendRuntimeMessage<any>({
      type: "TRANSLY_LIST_PROVIDER_MODELS",
      payload: nextConnection
    });
    return response.ok
      ? { ok: true as const, models: response.data?.models || [] }
      : { ok: false as const, error: response.error || t("connectServiceFailed") };
  }

  async function refreshModels({ quiet = false } = {}) {
    if (!apiUrl.trim()) return;
    setBusy("models");
    if (!quiet) showStatus(t("loadingModels"));
    const result = await requestModels();
    setBusy("");
    if (!result.ok) {
      if (!quiet) {
        setManualModel(true);
        setShowSaveWithoutTest(true);
        showStatus(result.error, "error");
      }
      return;
    }
    updateModelChoices(result.models, selectedModel);
    setModelCatalogLoaded(true);
    if (!quiet) {
      showStatus(result.models.length
        ? t("loadedModels", { count: result.models.length })
        : t("connectedNoModels"), result.models.length ? "success" : "neutral");
    }
  }

  async function saveConfiguration(verified: boolean, modelOverride = selectedModel) {
    showStatus(verified ? t("savingService") : t("savingWithoutTest"));
    const response = await sendRuntimeMessage({
      type: "TRANSLY_SAVE_PROVIDER_SETTINGS",
      payload: { ...connection, model: modelOverride }
    });
    if (!response.ok) {
      showStatus(response.error || t("settingsSaveFailed"), "error");
      return false;
    }
    setSavedConfiguration(true);
    setShowSaveWithoutTest(false);
    showStatus(verified ? t("serviceConnected") : t("serviceSaved"), "success");
    return true;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiUrl.trim()) return;
    setBusy("connect");
    setShowSaveWithoutTest(false);
    showStatus(t("connectingService"));
    const result = await requestModels();
    if (!result.ok) {
      setManualModel(true);
      setBusy("");
      setShowSaveWithoutTest(true);
      showStatus(result.error, "error");
      return;
    }
    const nextModels = normalizeModels(result.models);
    const nextModel = selectedModel || chooseDefaultModel(nextModels);
    updateModelChoices(nextModels, nextModel);
    setModelCatalogLoaded(true);
    if (!nextModel) {
      setBusy("");
      setManualModel(true);
      showStatus(t("noModelListed"), "error");
      return;
    }
    await saveConfiguration(true, nextModel);
    setBusy("");
  }

  async function testConnection() {
    if (!selectedModel) {
      showStatus(t("chooseModelBeforeTest"), "error");
      return;
    }
    setBusy("test");
    showStatus(t("testingService"));
    const response = await sendRuntimeMessage<any>({
      type: "TRANSLY_TEST_PROVIDER",
      payload: { ...connection, model: selectedModel }
    });
    setBusy("");
    if (!response.ok) {
      showStatus(response.error || t("connectServiceFailed"), "error");
      return;
    }
    if (response.data?.modelAvailable === false) {
      showStatus(t("selectedModelUnavailable", { model: selectedModel }), "error");
      return;
    }
    showStatus(response.data?.modelCount
      ? t("connectionSuccessful")
      : t("connectionNoModelList"), "success");
  }

  async function discoverLocalProviders() {
    setDiscoveryOpen(true);
    setDiscoveryBusy(true);
    setDiscoveryLabel(t("searching"));
    setDiscoveryResults([]);
    const response = await sendRuntimeMessage<LocalProvider[]>({ type: "TRANSLY_DISCOVER_LOCAL_PROVIDERS" });
    setDiscoveryBusy(false);
    if (!response.ok) {
      setDiscoveryLabel(t("searchFailed"));
      showStatus(response.error || t("searchLocalServicesFailed"), "error");
      return;
    }
    const results = response.data || [];
    setDiscoveryResults(results);
    setDiscoveryLabel(results.length ? t("foundCount", { count: results.length }) : t("noneFound"));
  }

  function chooseLocalProvider(result: LocalProvider) {
    setApiUrl(result.apiUrl);
    setApiKey(result.clientKey || "");
    setProtocol("auto");
    updateModelChoices(result.models || []);
    setModelCatalogLoaded(true);
    if (result.authRequired) showStatus(t("localSelectedNeedsKey"));
    else showStatus(result.clientKey ? t("magpieSelected") : t("localSelected"), "success");
  }

  function useOpenAI() {
    setApiUrl("https://api.openai.com/v1");
    setApiKey("");
    setProtocol("auto");
    resetModelChoices();
    showStatus(t("openAiSelected"));
  }

  const modelHint = busy === "models" && !modelCatalogLoaded
    ? t("loadingModels")
    : modelCatalogLoaded && models.length
    ? models.length === 1 ? t("oneAvailableModel") : t("availableModels", { count: models.length })
    : models.length
      ? t("currentModelSelected")
    : manualModel
      ? t("enterExactModel")
      : "";

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <img className="settings-logo" src={chrome.runtime.getURL("assets/icons/icon48.png")} alt="" />
        <h1>{t("settingsTitle")}</h1>
      </header>

      <section className="settings-section" aria-labelledby="quickSetupHeading">
        <div className="section-heading">
          <h2 id="quickSetupHeading">{t("quickSetup")}</h2>
          <p>{t("quickSetupDescription")}</p>
        </div>
        <div className="settings-group provider-group">
          <div className="quick-actions">
            <button id="connectLane" className="setup-action" type="button" title={t("connectLaneDescription")} disabled={laneBusy} onClick={() => connectLaneProvider()}>
              {laneBusy ? <LoaderCircle className="spin" size={15} /> : <Cable size={15} />}
              <span>{laneBusy ? t("connectingLane") : t("connectLane")}</span>
            </button>
            <button id="discoverLocal" className="setup-action" type="button" title={t("findLocalServicesDescription")} disabled={discoveryBusy} onClick={discoverLocalProviders}>
              {discoveryBusy ? <LoaderCircle className="spin" size={15} /> : <Radar size={15} />}
              <span>{t("findLocalServices")}</span>
            </button>
            <button id="useOpenAI" className="setup-action" type="button" title={t("useOpenAiDescription")} onClick={useOpenAI}>
              <img src={chrome.runtime.getURL("assets/providers/openai.svg")} alt="" />
              <span>{t("useOpenAiApi")}</span>
            </button>
          </div>

          {discoveryOpen && (
            <div id="discoveryPanel" className="discovery-panel">
              <div className="discovery-heading"><span>{t("localServices")}</span><span id="discoveryStatus">{discoveryLabel}</span></div>
              <div id="localResults" className="local-results">
                {!discoveryBusy && !discoveryResults.length && <p className="discovery-empty">{t("noCompatibleService")}</p>}
                {discoveryResults.map((result) => (
                  <button className="local-result" type="button" key={result.apiUrl} data-selected={result.apiUrl === apiUrl} onClick={() => chooseLocalProvider(result)}>
                    <span className="local-result-copy"><strong>{result.hint || t("localApi")}</strong><span>{result.apiUrl}</span></span>
                    <span className="local-result-detail">{result.authRequired ? t("apiKeyRequired") : t("modelCount", { count: result.models?.length || 0 })}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <form id="providerForm" className="provider-form" onSubmit={submit}>
            <div className="field-row">
              <label className="field-label" htmlFor="apiUrl">{t("apiUrl")}</label>
              <div className="field-control">
                <input id="apiUrl" name="apiUrl" type="url" spellCheck={false} autoComplete="url" placeholder="https://api.openai.com/v1" required value={apiUrl} onChange={(event) => { setApiUrl(event.target.value); resetModelChoices(); }} />
                <small>{t("apiUrlHelp")}</small>
              </div>
            </div>

            <div className="field-row">
              <label className="field-label" htmlFor="apiKey">{t("apiKey")}</label>
              <div className="field-control">
                <span className="password-input">
                  <input id="apiKey" name="apiKey" type={showKey ? "text" : "password"} spellCheck={false} autoComplete="off" placeholder={t("optional")} value={apiKey} onChange={(event) => { setApiKey(event.target.value); resetModelChoices(); }} />
                  <button id="toggleApiKey" type="button" aria-label={showKey ? t("hideApiKey") : t("showApiKey")} title={showKey ? t("hideApiKey") : t("showApiKey")} onClick={() => setShowKey((value) => !value)}>
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
                <small>{t("apiKeyHelp")}</small>
              </div>
            </div>

            <div className="field-row">
              <span className="field-label" id="modelLabel">{t("model")}</span>
              <div className="field-control">
                <div className="model-input-row">
                  <Combobox.Root
                    items={models}
                    value={manualModel ? null : model || null}
                    onValueChange={(value) => {
                      if (!value) return;
                      setManualModel(false);
                      setModel(value);
                      setCustomModel("");
                    }}
                    disabled={!models.length}
                  >
                    <Combobox.Trigger id="modelTrigger" className="model-trigger" aria-labelledby="modelLabel">
                      <span id="modelValue" className={!selectedModel ? "is-placeholder" : ""}>
                        {selectedModel ? splitModelName(selectedModel).name : models.length ? t("chooseModel") : t("connectToLoadModels")}
                      </span>
                      <Combobox.Icon className="control-icon"><ChevronDown size={16} /></Combobox.Icon>
                    </Combobox.Trigger>
                    <Combobox.Portal>
                      <Combobox.Positioner className="combobox-positioner" align="start" sideOffset={6}>
                        <Combobox.Popup id="modelPopover" className="combobox-popup">
                          <div className="combobox-search">
                            <Search size={15} />
                            <Combobox.Input id="modelSearch" aria-label={t("searchModels")} placeholder={t("searchModels")} />
                          </div>
                          <Combobox.List id="modelList" className="combobox-list">
                            {models.map((value) => {
                              const parts = splitModelName(value);
                              return (
                                <Combobox.Item className="model-option" data-value={value} key={value} value={value}>
                                  <span className="model-option-copy">
                                    <span className="model-option-name">{parts.name}</span>
                                    {parts.provider && <span className="model-option-provider">{parts.provider}</span>}
                                  </span>
                                  <Combobox.ItemIndicator className="model-option-check"><Check size={15} /></Combobox.ItemIndicator>
                                </Combobox.Item>
                              );
                            })}
                          </Combobox.List>
                          <Combobox.Empty className="model-empty">{t("noMatchingModels")}</Combobox.Empty>
                          <button id="manualModel" className="model-manual" type="button" onClick={() => setManualModel(true)}>{t("enterModelManually")}</button>
                        </Combobox.Popup>
                      </Combobox.Positioner>
                    </Combobox.Portal>
                  </Combobox.Root>
                  <button id="loadModels" className="icon-action" type="button" aria-label={t("loadModels")} title={t("loadModels")} disabled={Boolean(busy)} onClick={() => refreshModels()}>
                    {busy === "models" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  </button>
                </div>
                {manualModel && <input id="customModel" className="custom-model" type="text" spellCheck={false} autoComplete="off" placeholder={t("providerModelName")} value={customModel} onChange={(event) => setCustomModel(event.target.value)} />}
                {modelHint && <small id="modelHint">{modelHint}</small>}
              </div>
            </div>

            <details className="advanced-settings">
              <summary><ChevronRight className="advanced-chevron" size={14} />{t("advanced")}</summary>
              <div className="field-row">
                <span className="field-label">{t("apiFormat")}</span>
                <div className="field-control">
                  <Select.Root items={protocols} value={protocol} onValueChange={(value) => { if (value) { setProtocol(value as Protocol); resetModelChoices(); } }}>
                    <Select.Trigger id="protocol" className="protocol-trigger" aria-label={t("apiFormat")}>
                      <Select.Value />
                      <Select.Icon className="control-icon"><ChevronDown size={16} /></Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Positioner className="combobox-positioner" align="start" sideOffset={5}>
                        <Select.Popup className="protocol-popup">
                          <Select.List className="protocol-list">
                            {protocols.map((item) => (
                              <Select.Item className="protocol-option" key={item.value} value={item.value}>
                                <Select.ItemIndicator><Check size={15} /></Select.ItemIndicator>
                                <Select.ItemText>{item.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.List>
                        </Select.Popup>
                      </Select.Positioner>
                    </Select.Portal>
                  </Select.Root>
                </div>
              </div>
            </details>

            <div className="form-footer">
              <p id="providerStatus" className="provider-status" data-tone={statusTone} role="status" aria-live="polite">{status}</p>
              <div className="form-actions">
                {showSaveWithoutTest && <button id="saveWithoutTest" className="secondary-action" type="button" disabled={Boolean(busy)} onClick={async () => { setBusy("connect"); await saveConfiguration(false); setBusy(""); }}>{t("saveWithoutTesting")}</button>}
                <button id="testProvider" className="secondary-action" type="button" disabled={Boolean(busy)} onClick={testConnection}>{busy === "test" ? t("testing") : t("testConnection")}</button>
                <button id="connectProvider" className="primary-action" type="submit" disabled={Boolean(busy)}>{busy === "connect" ? t("connecting") : savedConfiguration ? t("saveChanges") : t("connect")}</button>
              </div>
            </div>
          </form>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="interfaceHeading">
        <div className="section-heading">
          <h2 id="interfaceHeading">{t("interfaceHeading")}</h2>
        </div>
        <div className="settings-group settings-list">
          <div className="setting-row">
            <div className="setting-copy">
              <span className="setting-label">{t("interfaceLanguage")}</span>
              <span className="setting-description">{t("interfaceDescription")}</span>
            </div>
            <Select.Root items={uiLanguageItems} value={preference} onValueChange={async (value) => {
              showStatus("");
              await setUiLanguage(value);
            }}>
              <Select.Trigger id="settingsUiLanguage" className="interface-language-trigger" aria-label={t("interfaceLanguage")}>
                <Select.Value />
                <Select.Icon className="control-icon"><ChevronDown size={16} /></Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner className="combobox-positioner" align="end" sideOffset={5}>
                  <Select.Popup className="protocol-popup interface-language-popup">
                    <Select.List className="protocol-list">
                      {uiLanguageItems.map((item) => (
                        <Select.Item className="protocol-option settings-interface-option" data-value={item.value} key={item.value} value={item.value}>
                          <Select.ItemIndicator><Check size={15} /></Select.ItemIndicator>
                          <Select.ItemText>{item.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
          <div className="setting-row">
            <div className="setting-copy">
              <span className="setting-label">{t("selectionTranslation")}</span>
              <span className="setting-description">{t("selectionTranslationDescription")}</span>
            </div>
            <Switch.Root
              id="selectionTranslationEnabled"
              className="settings-switch"
              checked={selectionTranslationEnabled}
              onCheckedChange={updateSelectionTranslation}
              aria-label={t("selectionTranslation")}
            >
              <Switch.Thumb className="settings-switch-thumb" />
            </Switch.Root>
          </div>
          <div className="setting-row" data-disabled={!selectionTranslationEnabled}>
            <div className="setting-copy">
              <span className="setting-label">{t("selectionIcon")}</span>
              <span className="setting-description">{t("selectionIconDescription")}</span>
            </div>
            <div className="selection-shortcut-controls">
              <Select.Root
                items={selectionShortcutItems}
                value={selectionShortcutStyle}
                onValueChange={updateSelectionShortcutStyle}
                disabled={!selectionTranslationEnabled || !selectionIconEnabled}
              >
                <Select.Trigger
                  id="selectionShortcutStyle"
                  className="selection-shortcut-trigger"
                  aria-label={t("selectionShortcutAppearance")}
                >
                  <Select.Value />
                  <Select.Icon className="control-icon"><ChevronDown size={15} /></Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner className="combobox-positioner" align="end" sideOffset={5}>
                    <Select.Popup className="protocol-popup selection-shortcut-popup">
                      <Select.List className="protocol-list">
                        {selectionShortcutItems.map((item) => (
                          <Select.Item
                            className="protocol-option selection-shortcut-option"
                            data-value={item.value}
                            key={item.value}
                            value={item.value}
                          >
                            <Select.ItemIndicator><Check size={15} /></Select.ItemIndicator>
                            <Select.ItemText>{item.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
              <Switch.Root
                id="selectionIconEnabled"
                className="settings-switch"
                checked={selectionIconEnabled}
                onCheckedChange={updateSelectionIcon}
                disabled={!selectionTranslationEnabled}
                aria-label={t("selectionIcon")}
              >
                <Switch.Thumb className="settings-switch-thumb" />
              </Switch.Root>
            </div>
          </div>
        </div>
      </section>

      {debugMode && (
        <section className="debug-panel" aria-labelledby="debugHeading">
          <div className="debug-heading">
            <div>
              <p className="debug-eyebrow">Developer mode</p>
              <h2 id="debugHeading">Subtitle diagnostics</h2>
              <p>Recent state changes from this browser session. Provider keys and caption text are excluded.</p>
            </div>
            <div className="debug-actions">
              <button type="button" disabled={diagnosticsBusy} onClick={refreshDiagnostics}>Refresh</button>
              <button type="button" disabled={!diagnostics.length} onClick={copyDiagnostics}>Copy</button>
              <button type="button" disabled={diagnosticsBusy || !diagnostics.length} onClick={clearDiagnostics}>Clear</button>
            </div>
          </div>
          {diagnosticsStatus && <p className="debug-status" role="status">{diagnosticsStatus}</p>}
          {!diagnostics.length && !diagnosticsBusy && <p className="debug-empty">No subtitle events recorded in this browser session.</p>}
          <div className="debug-events">
            {diagnostics.map((event, index) => (
              <details className="debug-event" open={index === 0} key={`${event.recordedAt}-${index}`}>
                <summary>
                  <span className="debug-event-status" data-status={event.subtitleStatus}>{event.subtitleStatus}</span>
                  <span>{new Date(event.recordedAt).toLocaleTimeString()}</span>
                  <span className="debug-event-title">{event.pageTitle || event.pageUrl || "Untitled page"}</span>
                </summary>
                <dl>
                  <dt>Language</dt><dd>{event.subtitleSourceLanguage || "unknown"} → {event.subtitleTargetLanguage || "unknown"}</dd>
                  <dt>Source</dt><dd>{event.subtitleSourceType || "unknown"}</dd>
                  <dt>Cues</dt><dd>{event.subtitleTranslatedCueCount || 0} / {event.subtitleCueCount || 0} translated</dd>
                  <dt>Current cue</dt><dd>{event.subtitleCurrentCueState || "none"}</dd>
                  {event.subtitleSkipReason && <><dt>Skipped</dt><dd>{event.subtitleSkipReason}</dd></>}
                  {(event.subtitleError || event.subtitleLastError) && <>
                    <dt>{event.subtitleError ? "Error" : "Last error"}</dt>
                    <dd className="debug-error">{event.subtitleError || event.subtitleLastError}</dd>
                  </>}
                  <dt>Page</dt><dd className="debug-url">{event.pageUrl || "unknown"}</dd>
                  <dt>Source key</dt><dd className="debug-url">{event.subtitleSourceKey || "none"}</dd>
                </dl>
              </details>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function normalizeModels(values: unknown[]) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function chooseDefaultModel(models: string[]) {
  const nonTextPattern = /(embedding|whisper|tts|speech|audio|image|dall-e|moderation|realtime|transcrib)/i;
  return models.find((name) => !nonTextPattern.test(name)) || models[0] || "";
}
