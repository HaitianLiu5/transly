# Provider Setup

Transly works with model services that expose an OpenAI-compatible Responses API or Chat Completions API. The service can run in the cloud, on another machine, or on the same computer as Chrome.

## Required Settings

Open Transly's popup and choose **Configure**.

| Setting | Meaning |
| --- | --- |
| API URL | A base URL such as `https://api.openai.com/v1`, or a complete Responses or Chat Completions endpoint |
| API key | The Bearer token accepted by the service; leave empty only when the service explicitly requires no key |
| Model | Loaded automatically from the service's `/models` endpoint; manual entry remains available as a fallback |
| API format | Available under **Advanced**; use **Auto detect** unless the service requires a specific protocol |

Choose **Connect** before translating an article. Transly checks `/v1/models`, fills the model dropdown, and saves the selected configuration. If a compatible service does not expose a model list, choose the manual model option and save without verification.

## Connect Lane Automatically

Install and open [Lane](https://github.com/1MoreBuild/Lane), then connect a
provider there. Transly detects Lane through Chrome Native Messaging and fills
the Lane API URL, client key, and available model automatically. Opening the
Transly popup is enough when no other provider has been configured. You can also
choose **Connect Lane** in Transly settings.

Lane keeps upstream provider API keys and OAuth tokens in its secure storage.
Transly receives only the separate Lane client key needed to call the loopback
gateway. If Lane is missing or has no model provider, Transly leaves the current
configuration unchanged.

## Find A Local Service

Choose **Find other local services** to check a small fixed list of common OpenAI-compatible loopback endpoints. Discovery runs only after this click. It does not scan the local network and does not attach your stored API key to probe requests.

The list covers Magpie (`3425`), CLIProxyAPI (`8317`), LM Studio (`1234`), Ollama (`11434`), LiteLLM (`4000`), vLLM (`8000`), and LocalAI or llama.cpp (`8080`).

Select a detected service, add its client key when required, choose one of the returned models, and connect. Services on nonstandard ports can still be configured by entering their URL manually.

## Compatible Services

### Hosted APIs

For a hosted OpenAI-compatible service, use its HTTPS endpoint, API key, and model name. For example:

```text
API URL: https://api.openai.com/v1
API key: your provider key
Model: a model available to your account
API format: Auto detect
```

### Self-Hosted Gateways And Local Proxies

Transly can also call an OpenAI-compatible gateway or local proxy:

```text
API URL: http://127.0.0.1:<port>/v1
API key: the client key configured by the gateway
Model: a model listed by the gateway
API format: Auto detect
```

[Magpie](https://github.com/yetone/magpie) is a compatible local gateway that serves the providers and subscriptions configured in its app at `http://127.0.0.1:3425/v1`. Start Magpie, choose **Find other local services**, pick **Magpie**, and choose one of its `provider/model` entries. Magpie accepts requests from the same computer without a key, so leave the API key empty. Transly sends translation text to Magpie, and Magpie forwards it to the vendor that serves the selected model.

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is another compatible local gateway. Both are developed and operated independently from Transly. Follow each project's own installation, authentication, and service-management documentation.

For local services:

- bind the service to `127.0.0.1` rather than all network interfaces;
- configure a strong client API key when the service supports one;
- arrange for the service to restart with the operating system if you expect it to remain available;
- review the service's license, security guidance, and upstream provider terms.

## URL And Protocol Rules

- Remote endpoints must use HTTPS.
- Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`.
- A base URL ending in `/v1` is expanded to `/v1/responses` or `/v1/chat/completions`.
- A complete endpoint is used directly, subject to the selected API format.
- Auto mode selects Chat Completions when the URL ends in `/chat/completions`; otherwise it prefers Responses.

## Data And Credentials

Provider configuration is stored in `chrome.storage.local`, not Chrome Sync. The API key is read only by trusted extension contexts and is attached to provider requests by the extension service worker.

The configured provider receives the text sent for translation. Only use a service you trust. Transly does not control the provider's retention policy, billing, rate limits, authentication, uptime, or model behavior.
