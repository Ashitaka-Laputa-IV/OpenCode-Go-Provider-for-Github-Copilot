import { describe, expect, it } from "vitest";
import { SseParser } from "../src/sse";

describe("SseParser", () => {
  it("parses a simple data event", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("handles chunks split at arbitrary positions", () => {
    const parser = new SseParser();
    const payload = 'data: {"text":"hello"}\n\n';
    const events: string[] = [];
    for (const char of payload) {
      events.push(...parser.push(char));
    }
    expect(events).toEqual(['{"text":"hello"}']);
  });

  it("supports CRLF line endings split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("data: one\r")).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual(["one"]);
  });

  it("parses multiple events from one chunk", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\n\ndata: b\n\n")).toEqual(["a", "b"]);
  });

  it("joins multi-line data fields", () => {
    const parser = new SseParser();
    expect(parser.push("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  it("ignores comments and non-data fields", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\nevent: message\nid: 1\ndata: ok\n\n")).toEqual(["ok"]);
  });

  it("flushes a final event without a trailing blank line", () => {
    const parser = new SseParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.end()).toEqual(["tail"]);
  });
});
