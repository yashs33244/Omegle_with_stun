import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseLanguage, getTranslator, resetTranslators, translatorApi, type TranslatorAvailability } from "./translator";

function stubTranslator(availability: TranslatorAvailability, translate = async (text: string) => `[${text}]`) {
  const api = {
    availability: vi.fn(async () => availability),
    create: vi.fn(async () => ({ translate })),
  };
  vi.stubGlobal("Translator", api);
  return api;
}

beforeEach(() => resetTranslators());
afterEach(() => vi.unstubAllGlobals());

describe("translator", () => {
  it("is absent where the browser has no Translator (feature detection, not UA sniffing)", async () => {
    expect(translatorApi()).toBeNull();
    expect(await getTranslator("hi", "en")).toBeNull();
  });

  it("translates through the built-in API when the pair is available, one translator per pair", async () => {
    const api = stubTranslator("available");
    const translator = await getTranslator("hi-IN", "en");
    expect(translator).not.toBeNull();
    expect(await translator!.translate("नमस्ते")).toBe("[नमस्ते]");
    expect(api.availability).toHaveBeenCalledWith({ sourceLanguage: "hi", targetLanguage: "en" });
    await getTranslator("hi", "en-US");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("also creates when the pair is downloadable (Chrome fetches the model on create)", async () => {
    const api = stubTranslator("downloadable");
    expect(await getTranslator("es", "en")).not.toBeNull();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("falls back to null for an unavailable pair, a throwing create, or the same language", async () => {
    stubTranslator("unavailable");
    expect(await getTranslator("ar", "en")).toBeNull();
    const api = stubTranslator("available");
    api.create.mockRejectedValueOnce(new Error("needs a user gesture"));
    expect(await getTranslator("fr", "en")).toBeNull();
    // Not cached: the next call tries again.
    expect(await getTranslator("fr", "en")).not.toBeNull();
    expect(await getTranslator("en", "en-GB")).toBeNull();
    expect(api.availability).toHaveBeenCalledTimes(2);
  });

  it("baseLanguage folds regional tags", () => {
    expect(baseLanguage("hi-IN")).toBe("hi");
    expect(baseLanguage("EN")).toBe("en");
  });
});
