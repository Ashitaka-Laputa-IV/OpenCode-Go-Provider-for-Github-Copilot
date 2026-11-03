import { describe, expect, it } from "vitest";
import {
  FALLBACK_MODELS,
  formatTokenCount,
  isFreeModel,
  resolveTokenLimits,
  selectModels,
  supportsImageInput,
  supportsToolCalling,
  toChatInformation,
  type OpenCodeModel,
} from "../src/models";

const visionModel: OpenCodeModel = {
  id: "vision-model",
  name: "Vision Model",
  family: "vision",
  description: "A vision model",
  type: "chat",
  modalities: { input: ["text", "image/png"] },
  capabilities: { tools: { supported: true } },
  limit: { context: 1_000_000, output: 128_000 },
  cost: { text: { input: { price: 1 }, output: { price: 2 } } },
};

describe("model helpers", () => {
  it("detects image and tool capabilities", () => {
    expect(supportsImageInput(visionModel)).toBe(true);
    expect(supportsToolCalling(visionModel)).toBe(true);
    expect(supportsImageInput({ id: "text-only", modalities: { input: ["text"] } })).toBe(false);
    expect(
      supportsImageInput({
        id: "translated-vision",
        modalities: { input: ["text", "image/png"] },
        api: { messages: { base_url: "https://example.test" } },
      }),
    ).toBe(false);
  });

  it("detects free models", () => {
    expect(isFreeModel({ id: "free", cost: { text: { input: { price: 0 }, output: { price: 0 } } } })).toBe(
      true,
    );
    expect(isFreeModel(visionModel)).toBe(false);
    expect(isFreeModel({ id: "unknown" })).toBe(false);
  });

  it("filters non-chat and free models", () => {
    const embedding: OpenCodeModel = { id: "embed", type: "embedding" };
    const free: OpenCodeModel = {
      id: "free",
      type: "chat",
      cost: { text: { input: { price: 0 }, output: { price: 0 } } },
    };

    expect(selectModels([visionModel, embedding, free], false).map((m) => m.id)).toEqual([
      "vision-model",
    ]);
    expect(selectModels([visionModel, embedding, free], true).map((m) => m.id)).toEqual([
      "vision-model",
      "free",
    ]);
  });

  it("maps catalog metadata to VS Code model information", () => {
    expect(toChatInformation(visionModel)).toMatchObject({
      id: "vision-model",
      name: "Vision Model",
      family: "vision",
      maxInputTokens: 872_000,
      maxOutputTokens: 128_000,
      detail: "1M context",
      capabilities: { imageInput: true, toolCalling: true },
    });
  });

  it("keeps input and output inside the real context window", () => {
    expect(resolveTokenLimits(visionModel)).toEqual({
      maxInputTokens: 872_000,
      maxOutputTokens: 128_000,
      context: 1_000_000,
    });
    expect(
      resolveTokenLimits({ id: "deepseek", limit: { context: 1_000_000, output: 384_000 } }),
    ).toEqual({
      maxInputTokens: 616_000,
      maxOutputTokens: 384_000,
      context: 1_000_000,
    });
  });

  it("caps the context window when configured", () => {
    expect(resolveTokenLimits(visionModel, 100_000)).toEqual({
      maxInputTokens: 25_000,
      maxOutputTokens: 75_000,
      context: 100_000,
    });
  });

  it("handles models whose output limit equals the context window", () => {
    const limits = resolveTokenLimits({ id: "equal", limit: { context: 262_144, output: 262_144 } });
    expect(limits.context).toBe(262_144);
    expect(limits.maxInputTokens).toBeGreaterThan(0);
    expect(limits.maxOutputTokens).toBeGreaterThan(0);
  });

  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_048_576)).toBe("1M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(262_144)).toBe("262K");
  });

  it("ships fallback models for offline use", () => {
    expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
    expect(FALLBACK_MODELS.every((model) => model.id.length > 0)).toBe(true);
  });
});
