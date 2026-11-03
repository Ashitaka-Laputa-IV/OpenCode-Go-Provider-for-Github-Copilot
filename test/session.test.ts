import { describe, expect, it } from "vitest";
import { sessionIdFor, sessionSeed } from "../src/session";

describe("session ids", () => {
  it("is deterministic and prefixed", () => {
    const first = sessionIdFor("seed");
    expect(first).toBe(sessionIdFor("seed"));
    expect(first.startsWith("ses_")).toBe(true);
    expect(first).toHaveLength(36);
  });

  it("stays stable across turns because the first user message is stable", () => {
    const turn1 = sessionSeed("workspace", "model", "hello");
    const turn2 = sessionSeed("workspace", "model", "hello");
    expect(sessionIdFor(turn1)).toBe(sessionIdFor(turn2));
  });

  it("changes with model, workspace, or first message", () => {
    const base = sessionIdFor(sessionSeed("workspace", "model", "hello"));
    expect(sessionIdFor(sessionSeed("workspace", "other-model", "hello"))).not.toBe(base);
    expect(sessionIdFor(sessionSeed("other-workspace", "model", "hello"))).not.toBe(base);
    expect(sessionIdFor(sessionSeed("workspace", "model", "goodbye"))).not.toBe(base);
  });
});
