import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { convertMessages, convertTools, firstUserText } from "../src/convert";

function text(value: string): vscode.LanguageModelTextPart {
  return new vscode.LanguageModelTextPart(value);
}

describe("convertMessages", () => {
  it("converts user and assistant text", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [text("hello")],
      },
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [text("hi")],
      },
    ] satisfies vscode.LanguageModelChatRequestMessage[];

    expect(convertMessages(messages)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("converts assistant tool calls", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          text("checking"),
          new vscode.LanguageModelToolCallPart("call_1", "read_file", { path: "a.txt" }),
        ],
      },
    ] satisfies vscode.LanguageModelChatRequestMessage[];

    expect(convertMessages(messages)).toEqual([
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
    ]);
  });

  it("emits tool results before remaining user text", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          text("here is the result"),
          new vscode.LanguageModelToolResultPart("call_1", [text("file contents")]),
        ],
      },
    ] satisfies vscode.LanguageModelChatRequestMessage[];

    expect(convertMessages(messages)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      { role: "user", content: "here is the result" },
    ]);
  });

  it("converts image data parts", () => {
    const image = Buffer.from([1, 2, 3]);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [text("what is this?"), vscode.LanguageModelDataPart.image(image, "image/png")],
      },
    ] satisfies vscode.LanguageModelChatRequestMessage[];

    expect(convertMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
          },
        ],
      },
    ]);
  });

  it("skips empty messages", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [],
      },
    ] satisfies vscode.LanguageModelChatRequestMessage[];

    expect(convertMessages(messages)).toEqual([]);
  });
});

describe("convertTools", () => {
  it("returns nothing when there are no tools", () => {
    expect(convertTools([], vscode.LanguageModelChatToolMode.Auto)).toEqual({});
  });

  it("maps tool schemas and supplies a default object schema", () => {
    const tools: vscode.LanguageModelChatTool[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "ping",
        description: "Ping",
      },
    ];

    const result = convertTools(tools, vscode.LanguageModelChatToolMode.Required);

    expect(result.toolChoice).toBe("required");
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "ping",
          description: "Ping",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});

describe("firstUserText", () => {
  it("finds the first non-empty user message", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [text("ignored")],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [text("first"), text(" message")],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [text("second")],
      },
    ] satisfies vscode.LanguageModelChatRequestMessage[];

    expect(firstUserText(messages)).toBe("first message");
  });
});
