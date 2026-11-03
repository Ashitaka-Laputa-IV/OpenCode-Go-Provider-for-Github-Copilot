# Changelog

## 0.1.7

- Add **Compact** and **Deep Think** preset entries in the model picker. Each preset is a separate model row with its own context window and reasoning effort, because the stable VS Code API does not expose a per-model settings panel to third-party providers.
- Add `opencodeGo.pickerPresets` to turn the preset rows off.

## 0.1.6

- Add per-model context and reasoning effort overrides through **Configure Model Settings** and **Reset Model Settings**.

## 0.1.5

- Remove the hard-coded fallback model list. The last successful catalog is stored locally and reused when the API is unreachable; a first run without network shows no models until a refresh succeeds.

## 0.1.4

- Refresh the live model catalog every 30 minutes and when the window regains focus, so Go plan model changes appear without reloading VS Code.
- Reuse the last successful catalog when the network is unavailable instead of falling back to a stale hard-coded list.
- Only send `reasoning_effort` when the live catalog advertises supported effort levels for that model.

## 0.1.3

- Keep input and output budgets accurate for models whose catalog input limit plus output limit exceeds the context window (for example Step 5 Preview).

## 0.1.2

- Fix the reported context window so VS Code shows the model's real context size instead of input + output exceeding it.
- Add `opencodeGo.contextWindowTokens` to cap the context window reported to VS Code.
- Add `opencodeGo.reasoningEffort` and the **Set Reasoning Effort** command for models with configurable reasoning.

## 0.1.1

- Fix duplicate model entries in the model picker when the provider uses VS Code's native API key configuration.

## 0.1.0

- Initial release.
- Adds the **OpenCode Go** provider to the GitHub Copilot Chat model picker.
- API key configuration through the native model provider configuration UI.
- Streaming chat completions, tool calling, image input, cancellation, and model discovery from `https://opencode.ai/inference/go/v1/models`.
- Stable `x-opencode-session` header per conversation for gateway routing and prompt caching.
