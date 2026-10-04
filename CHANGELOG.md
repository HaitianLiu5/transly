# Changelog

All notable user-visible changes to Transly are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Transly uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-04

### Added

- Settings can find a running [Magpie](https://github.com/yetone/magpie) gateway on this computer and translate through its models without an API key.

## [0.3.1] - 2026-09-16

### Added

- Translate selected text from the popup, Chrome's right-click menu, or a configurable dot or icon that follows the selection endpoint and opens the translation on hover, with independent controls for the feature and its page shortcut.
- Stop an article translation in progress while keeping passages that already finished.

### Changed

- Add a little more space between the original text and its translation for easier bilingual reading.

### Fixed

- Preserve paragraph spacing and list line breaks when translating Twitter/X posts and other text that uses visible newlines.

## [0.2.1] - 2026-08-11

### Added

- Added English and Simplified Chinese interface controls to the popup and
  settings, with automatic browser-language detection and a remembered choice.

## [0.2.0] - 2026-08-09

### Added

- Added a YouTube player control for subtitle translation and appearance settings.
- Added playhead-priority subtitle translation, cached seek-back playback, and
  direct use of existing target-language caption tracks.
- Expanded product-level Playwright coverage for articles, long videos, preview
  players, target-language captions, and subtitle controls.

### Changed

- Improved article extraction, batching, streaming, link preservation, spacing,
  and rendering across complex pages.
- Improved provider discovery, model selection, error diagnostics, and Lane
  integration.
- Improved translation-only and bilingual article modes and their remembered
  preference.
- Updated the development baseline to Node.js 24.

### Fixed

- Prevented YouTube controls from appearing on unsupported preview players.
- Fixed clipped popup menus and subtitle controls that remained visible after
  YouTube hid its own controls.
- Fixed repeated or malformed article translations around lists, tables, code,
  formulas, and linked icons.

## [0.1.1] - 2026-08-04

### Added

- Released context-aware article translation with progressive rendering and
  local result caching.
- Added OpenAI-compatible Responses and Chat Completions providers.
- Added automatic discovery of the optional Lane local gateway.
- Added the initial YouTube subtitle translation beta.
- Added WXT and React entrypoints for the popup and settings interfaces.
- Added product-level Playwright coverage against the packaged extension and a
  deterministic local provider.
- Added automated Chrome Web Store publishing through GitHub Actions.
- Published Transly in the Chrome Web Store.

### Changed

- Migrated the extension build and manifest to WXT.
- Refined the popup, provider setup, translated-page styling, and installation
  documentation for the first public release.

[Unreleased]: https://github.com/1MoreBuild/transly/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/1MoreBuild/transly/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/1MoreBuild/transly/compare/v0.2.1...v0.3.1
[0.2.1]: https://github.com/1MoreBuild/transly/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/1MoreBuild/transly/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/1MoreBuild/transly/releases/tag/v0.1.1
