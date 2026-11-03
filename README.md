# OpenCode Go for GitHub Copilot

Use [OpenCode Go](https://opencode.ai/docs/providers/#opencode-go) models inside GitHub Copilot Chat in VS Code.

This extension contributes an **OpenCode Go** language model provider, so it shows up in the Copilot model picker under **Add Models**. All you need is an OpenCode API key.

> Not affiliated with OpenCode, GitHub, or Microsoft.

## Features

- **One-step setup** — paste an API key in the native VS Code model provider configuration UI.
- **Live model catalog** — models, context windows, output limits, tool calling, and vision support are loaded from the OpenCode API.
- **Streaming responses** with cancellation support.
- **Tool calling** for agent mode and MCP tools.
- **Image input** for models that natively support vision through Chat Completions.
- **Stable session routing** — every conversation gets a stable `x-opencode-session` value for gateway routing and prompt caching.
- **Secure key storage** — the API key is stored by VS Code's secret storage, never in settings or logs.
- **Offline catalog cache** — the last successful model catalog is stored locally and reused when the catalog endpoint is unreachable.

## Requirements

- VS Code **1.125 or newer**
- GitHub Copilot Chat extension
- An OpenCode Go subscription and API key (create one at <https://opencode.ai/auth>)
- The key must come from a workspace with an active **OpenCode Go** plan. A pay-as-you-go (Zen) key needs a different base URL, see [Settings](#settings).

## Install

### From the Marketplace

1. Install **OpenCode Go for GitHub Copilot** from the VS Code Marketplace (or Open VSX).
2. Reload VS Code.

### From a VSIX

```bash
npm install
npm run package
code --install-extension opencode-go-provider-for-copilot-0.1.0.vsix
```

## Setup

1. Open **Copilot Chat**.
2. Click the model picker and choose **Add Models**.
3. Select **OpenCode Go**.
4. Paste your API key (`oc_sk_...`).
5. Pick the models you want to enable.

The provider is also available in **Manage Models** at any time to update the key or add more models.

### Optional: use an environment variable

For CI or shared machines, set `OPENCODE_API_KEY` before starting VS Code. The extension uses it when no key is configured in the UI.

## Models

The list is fetched from `https://opencode.ai/inference/go/v1/models` and updates automatically. Examples:

| Model | Context | Output | Vision | Tools |
| --- | ---: | ---: | :---: | :---: |
| DeepSeek V4.1 Flash | 1M | 384K | yes | yes |
| DeepSeek V4 Pro | 1M | 384K | no | yes |
| Kimi K3 | 1M | 131K | yes | yes |
| GLM-5.3-Flash | 1M | 131K | yes | yes |
| Qwen3.8 Max | 1M | 131K | — | yes |
| Claude Haiku 5.5 | 1M | 128K | — | yes |
| GPT-6 Luna | 1.05M | 128K | — | yes |

**Notes**

- Free-tier models are hidden by default. They are restricted to the OpenCode client and usually return HTTP 403 from other clients. Enable `opencodeGo.includeFreeModels` to show them anyway.
- Vision is advertised only for models that natively use the Chat Completions API. The gateway translates text between APIs, but image translation is not guaranteed for Anthropic/Gemini/Responses-native models.
- Usage limits and model availability are controlled by your OpenCode plan.
- The catalog is read at runtime. It is cached for 10 minutes, refreshed every 30 minutes and when the window regains focus, and can be refreshed immediately with **OpenCode Go: Refresh Models**. New or removed Go models do not require an extension update.
- If the catalog endpoint is unreachable, the extension reuses the last successful catalog stored locally. On a first run with no network, no models are shown until **Refresh Models** succeeds.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeGo.baseUrl` | `https://opencode.ai/inference/go` | OpenCode API base URL. Use `https://opencode.ai/inference` for a pay-as-you-go (Zen) key. |
| `opencodeGo.includeFreeModels` | `false` | Show free-tier models that are usually limited to the OpenCode client. |
| `opencodeGo.contextWindowTokens` | `0` | Maximum context window (input + output) reported to VS Code. `0` uses each model's native window. |
| `opencodeGo.reasoningEffort` | `auto` | Reasoning effort for models that support it: `auto`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |

The stable VS Code provider API does not expose per-model context or reasoning controls to third-party extensions. Use the settings above or the commands below to change them globally.

## Commands

- **OpenCode Go: Set API Key**
- **OpenCode Go: Clear API Key**
- **OpenCode Go: Refresh Models**
- **OpenCode Go: Set Reasoning Effort**
- **OpenCode Go: Set Max Context Window**

The API key commands are a fallback for VS Code versions that do not render the native provider configuration UI.

## Troubleshooting

### The provider does not appear in Add Models

- Make sure VS Code is 1.125 or newer.
- Make sure GitHub Copilot Chat is installed and enabled.
- Run **Developer: Reload Window**.

### HTTP 401 / 403

The API key is invalid, expired, or belongs to a workspace without an OpenCode Go subscription.

- Update the key in **Manage Models → OpenCode Go**.
- If you use a pay-as-you-go (Zen) key, set `opencodeGo.baseUrl` to `https://opencode.ai/inference`.

### HTTP 400 `MissingSessionID`

This extension always sends `x-opencode-session`. If you see this error, a proxy or another client removed the header. Check your network proxy configuration.

### HTTP 429

You reached a usage limit. Check your OpenCode Console usage, or wait for the limit window to reset.

### Model returns HTTP 403

You probably selected a free-tier model. Free models are only available inside the OpenCode client. Disable `opencodeGo.includeFreeModels` and use a paid/Go model.

### Requests time out

Check your network and proxy settings. The catalog request times out after 15 seconds, and a chat request times out after 300 seconds.

## Privacy and security

- The API key is stored by **VS Code's secret storage**, never in `settings.json`, source control, or logs.
- Requests go directly from your machine to `https://opencode.ai`. No telemetry is collected by this extension.
- Logs contain request metadata only (model, message count, latency, token usage). The `Authorization` header and keys are redacted.
- The `OPENCODE_API_KEY` environment variable is read when no key is configured in the UI. Use it only on trusted machines.

## Development

```bash
npm install
npm run check        # typecheck + unit tests + bundle
npm run watch        # rebuild on change
```

Press <kbd>F5</kbd> to launch an Extension Development Host. Open Copilot Chat, then **Add Models → OpenCode Go**.

### Tests

```bash
npm test
```

Unit tests cover the SSE parser, message/tool conversion, model mapping, and session IDs. The live end-to-end suite launches a real VS Code extension host and exercises streaming, tool calls, a tool-result round trip, and image input:

```bash
OPENCODE_API_KEY=oc_sk_... npm run test:integration
```

Set `VSCODE_EXECUTABLE` to use a specific VS Code installation. The suite needs a GUI session and network access.

The project also has a manual verification checklist:

1. Add the provider with a real key.
2. Send a message and confirm streaming.
3. Cancel a response.
4. In agent mode, ask the model to create a file and confirm the tool round trip.
5. Attach an image to a vision-capable model.

### Project layout

```
src/extension.ts   activation and contributions
src/provider.ts    LanguageModelChatProvider implementation
src/client.ts      model catalog + streaming chat requests
src/convert.ts     VS Code <-> OpenAI message conversion
src/models.ts      catalog types and mapping
src/session.ts     stable x-opencode-session IDs
src/sse.ts         incremental SSE parser
```

## Publishing

### One-time setup

**VS Code Marketplace (Trusted Publishing)**

No Personal Access Token is needed. The release workflow uses GitHub OIDC trusted publishing.

1. Create a publisher at <https://marketplace.visualstudio.com/manage>.
2. Open the publisher and select **Trusted Publishing**.
3. Create a policy:
   - **Policy name**: `Release workflow`
   - **Repository owner**: `Ashitaka-Laputa-IV`
   - **Repository**: `OpenCode-Go-Provider-for-Github-Copilot`
   - **Workflow**: `release.yml`
   - **Environment**: leave empty
4. Push a `v*` tag. The workflow exchanges a short-lived OIDC token for Marketplace credentials with `vsce publish --oidc`.

**Open VSX (optional)**

Open VSX is only needed for VSCodium and other non-Marketplace clients. It requires an Eclipse Foundation account and a signed Publisher Agreement.

1. Sign in at <https://open-vsx.org>, link your Eclipse account, and sign the Publisher Agreement.
2. Create a namespace matching your publisher ID.
3. Create an access token.
4. Add it to your GitHub repository as the `OVSX_PAT` secret.

If `OVSX_PAT` is not set, the release workflow skips Open VSX and still publishes to the Marketplace.

### Release

1. Update `CHANGELOG.md`.
2. Bump the version:

   ```bash
   npm version patch   # or minor / major
   git push --follow-tags
   ```

3. The `Release` workflow runs `npm run check`, packages the VSIX, publishes to the Marketplace with OIDC, publishes to Open VSX when configured, and creates a GitHub release with the VSIX attached.

Local publishing with a PAT still works until Azure DevOps retires global PATs on December 1, 2026:

```bash
npm run check
npm run package
npx @vscode/vsce publish -p "$VSCE_PAT"
npx ovsx publish -p "$OVSX_PAT"   # optional
```

### Workflow secrets

| Secret | Purpose |
| --- | --- |
| `OVSX_PAT` | Open VSX publishing (optional) |
| `GITHUB_TOKEN` | Automatic; used for the GitHub release |
| — | Marketplace publishing uses OIDC and needs no secret |

## License

MIT
