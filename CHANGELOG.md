# Changelog

## 0.1.1

- Fix duplicate model entries in the model picker when the provider uses VS Code's native API key configuration.

## 0.1.0

- Initial release.
- Adds the **OpenCode Go** provider to the GitHub Copilot Chat model picker.
- API key configuration through the native model provider configuration UI.
- Streaming chat completions, tool calling, image input, cancellation, and model discovery from `https://opencode.ai/inference/go/v1/models`.
- Stable `x-opencode-session` header per conversation for gateway routing and prompt caching.
