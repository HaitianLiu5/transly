<div align="center">
  <img src="assets/transly-logo.png" width="112" alt="Transly logo">
  <h1>Transly</h1>
  <p><strong>Context-aware AI translation for web articles and YouTube captions.</strong></p>

  <p>
    <a href="https://chromewebstore.google.com/detail/transly/mdjfkiddlpdgchddcckhcmdjekmmhcgp"><img src="https://img.shields.io/badge/Install_from-Chrome_Web_Store-4285F4?logo=googlechrome&logoColor=white" alt="Install Transly from the Chrome Web Store"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT License"></a>
    <a href="PRIVACY.md"><img src="https://img.shields.io/badge/privacy-policy-111111" alt="Privacy Policy"></a>
    <a href="https://github.com/1MoreBuild/transly/actions/workflows/ci.yml"><img src="https://github.com/1MoreBuild/transly/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  </p>
</div>

<p align="center">
  <img src="marketing/chrome-web-store/transly-article-bilingual-2560x1600.png" alt="Transly translating a web article in bilingual mode" width="100%">
</p>

Transly is an open-source Chrome extension that translates with a model service
you choose. It sends related text together for better context, then places each
translation back beside the original content.

## What It Does

### Article Translation

- Translates article text in context instead of sending isolated sentences.
- Shows finished passages progressively while the rest of the article continues.
- Supports bilingual and translation-only reading modes.
- Preserves document structure such as headings, links, lists, tables, code, and
  formulas where the page exposes them as usable HTML.
- Caches validated results locally to avoid repeating identical model requests.

### YouTube Subtitles (Beta)

- Translates existing YouTube captions from timed-text responses or native
  browser caption tracks.
- Prioritizes captions around the current playhead, then fills the rest in the
  background.
- Keeps translated cues available when you seek backward.
- Supports original-only, translation-only, and bilingual display, plus line
  order, text size, position, and background controls inside the player.
- Uses available target-language captions directly instead of translating them
  again.

Transly does not transcribe audio. A YouTube video must already have a usable
caption track. Other video sites are not supported in the current release.

## Get Started

1. [Install Transly from the Chrome Web Store](https://chromewebstore.google.com/detail/transly/mdjfkiddlpdgchddcckhcmdjekmmhcgp).
2. Connect a model service using one of the options below.
3. Open an article and choose **Translate this article**, or use the Transly
   control inside a YouTube player.

### Use Lane On macOS

[Lane](https://github.com/1MoreBuild/Lane) is the easiest local setup on macOS.
It can connect ChatGPT / Codex through browser OAuth or use provider API keys,
then exposes a private OpenAI-compatible endpoint on your Mac. Install and open
Lane, add a provider, and Transly can discover its connection and models
automatically.

Lane is optional and maintained as a separate project.

### Use Your Own API

Transly also connects directly to hosted APIs, self-hosted services, and local
gateways such as [Magpie](https://github.com/yetone/magpie), which settings can
find with **Find other local services**. Configure:

- an OpenAI-compatible base URL or complete endpoint;
- an API key when the service requires one;
- a model returned by the service, or a model name entered manually;
- Responses or Chat Completions format, normally left on **Auto detect**.

See [Provider Setup](docs/providers.md) for supported URL formats, local service
discovery, and security guidance.

## Privacy And Boundaries

Transly has no hosted translation backend. Article or caption text is sent from
the extension to the model service you configure. Provider settings stay in
Chrome's local extension storage and are not synchronized through Chrome Sync.

Your provider controls authentication, retention, billing, rate limits, uptime,
and model behavior. Use a service you trust. See the [Privacy Policy](PRIVACY.md)
for the complete data-handling description.

Transly focuses on web articles and YouTube captions. It does not currently
translate PDFs, EPUBs, images, input boxes, or live speech.

## Transly And Immersive Translate

[Immersive Translate](https://immersivetranslate.com/) is an important product
reference for Transly. Immersive Translate supports many more formats, sites,
and translation services. Transly deliberately has a narrower scope and puts
more article context into each model request to improve long-form terminology,
tone, and coherence.

Translation quality still depends on the page, source language, configured
model, and provider. Transly has not published a comparative quality benchmark.

## Development

Requires Node.js 24 LTS and npm:

```bash
npm install
npx playwright install chromium
npm test
npm run package
```

Transly uses [WXT](https://wxt.dev/) with React for the popup and settings UI.
`npm run dev` starts a development build, while `npm run build` writes the
unpacked extension to `dist/extension`.

`npm test` runs TypeScript checks, narrow contract tests, and Playwright product journeys
against the real generated extension and a deterministic local model service.
It does not send real model requests.

Further documentation:

- [Changelog](CHANGELOG.md)
- [Provider setup](docs/providers.md)
- [Architecture](docs/architecture.md)
- [Chrome Web Store release](docs/chrome-web-store.md)

## Credits

Transly owes a substantial design debt to
[Immersive Translate](https://immersivetranslate.com/). Its bilingual reading
experience and DOM-aware translation approach informed many product and
engineering decisions. Transly is an independent implementation and is not
affiliated with or endorsed by Immersive Translate.

## License

[MIT](LICENSE) • Haitian ([1MoreBuild](https://github.com/1MoreBuild))
