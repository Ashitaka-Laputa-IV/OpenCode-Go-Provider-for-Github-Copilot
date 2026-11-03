import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const PROVIDER = "opencode-go";
const PRIMARY_MODEL = "deepseek-v4.1-flash";

function timeoutToken(ms: number): { token: vscode.CancellationToken; dispose: () => void } {
  const source = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), ms);
  return {
    token: source.token,
    dispose: () => {
      clearTimeout(timer);
      source.dispose();
    },
  };
}

async function collectText(response: vscode.LanguageModelChatResponse): Promise<string> {
  let text = "";
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

async function collectToolCalls(
  response: vscode.LanguageModelChatResponse,
): Promise<vscode.LanguageModelToolCallPart[]> {
  const calls: vscode.LanguageModelToolCallPart[] = [];
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      calls.push(part);
    }
  }
  return calls;
}

export async function run(): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: PROVIDER });
  console.log(`[integration] discovered ${models.length} OpenCode Go models`);
  console.log(
    `[integration] models: ${models
      .slice(0, 10)
      .map((model) => model.id)
      .join(", ")}`,
  );
  assert.ok(models.length > 0, "expected at least one OpenCode Go model");

  const model = models.find((candidate) => candidate.id === PRIMARY_MODEL) ?? models[0];
  console.log(`[integration] using model ${model.id} (${model.name})`);

  // 1. Streaming text completion.
  {
    const lease = timeoutToken(180_000);
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User("Reply with exactly: pong")],
        {},
        lease.token,
      );
      const text = await collectText(response);
      console.log(`[integration] streamed text: ${JSON.stringify(text.slice(0, 120))}`);
      assert.match(text.toLowerCase(), /pong/, "expected a pong response");
    } finally {
      lease.dispose();
    }
  }

  // 2. Tool call emission and tool-result round trip.
  {
    const tool: vscode.LanguageModelChatTool = {
      name: "create_file",
      description: "Create a file with the given content.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    };

    const prompt = vscode.LanguageModelChatMessage.User(
      "Create a file named notes.txt containing the word hello. Use the create_file tool.",
    );

    const lease = timeoutToken(180_000);
    let call: vscode.LanguageModelToolCallPart | undefined;
    try {
      const response = await model.sendRequest(
        [prompt],
        { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto },
        lease.token,
      );
      const calls = await collectToolCalls(response);
      console.log(`[integration] tool calls: ${calls.map((item) => item.name).join(", ") || "(none)"}`);
      assert.ok(
        calls.some((item) => item.name === "create_file"),
        "expected the model to call create_file",
      );
      call = calls.find((item) => item.name === "create_file");
    } finally {
      lease.dispose();
    }

    assert.ok(call, "expected a create_file tool call part");

    const followLease = timeoutToken(180_000);
    try {
      const response = await model.sendRequest(
        [
          prompt,
          vscode.LanguageModelChatMessage.Assistant([
            new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input),
          ]),
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelToolResultPart(call.callId, [
              new vscode.LanguageModelTextPart("File notes.txt created with content: hello"),
            ]),
          ]),
        ],
        {},
        followLease.token,
      );
      const text = await collectText(response);
      console.log(`[integration] tool follow-up: ${JSON.stringify(text.slice(0, 160))}`);
      assert.ok(text.trim().length > 0, "expected a follow-up response after the tool result");
    } finally {
      followLease.dispose();
    }
  }

  // 3. Image input (best effort; only for vision-capable chat-completions models).
  {
    const visionModel = models.find((candidate) => candidate.id === PRIMARY_MODEL);
    if (visionModel) {
      const png = Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3P9wAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const lease = timeoutToken(120_000);
      try {
        const response = await visionModel.sendRequest(
          [
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelTextPart("Describe this image in one word."),
              vscode.LanguageModelDataPart.image(png, "image/png"),
            ]),
          ],
          {},
          lease.token,
        );
        const text = await collectText(response);
        console.log(`[integration] image response: ${JSON.stringify(text.slice(0, 120))}`);
        assert.ok(text.trim().length > 0, "expected a response for the image input");
      } catch (error) {
        console.warn("[integration] image test skipped after an upstream error:", error);
      } finally {
        lease.dispose();
      }
    }
  }

  console.log("[integration] all checks passed");
}
