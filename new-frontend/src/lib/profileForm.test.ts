import { describe, expect, it } from "vitest";
import { profileSchema, TOPICS } from "./protocol";
import { GENDER_CHOICES, TOPIC_EMOJI, hasErrors, toProfile, validateProfileForm, type ProfileForm } from "./profileForm";

const base: ProfileForm = {
  name: "Asha",
  country: "IN",
  language: "en",
  gender: "unspecified",
  topics: ["general"],
};

describe("validateProfileForm", () => {
  it("accepts a name and one topic", () => {
    expect(hasErrors(validateProfileForm(base))).toBe(false);
  });

  it("requires a non-blank name", () => {
    expect(validateProfileForm({ ...base, name: "" }).name).toBe("form.errors.nameRequired");
    expect(validateProfileForm({ ...base, name: "   " }).name).toBe("form.errors.nameRequired");
  });

  it("requires at least one topic", () => {
    expect(validateProfileForm({ ...base, topics: [] }).topics).toBe("form.errors.topicsRequired");
  });
});

describe("toProfile", () => {
  it("builds a profile the server schema accepts", () => {
    const profile = toProfile({ ...base, name: "  Asha  ", gender: "female", topics: ["music", "art"] });
    expect(profile).toEqual({
      name: "Asha",
      country: "IN",
      language: "en",
      gender: "female",
      topics: ["music", "art"],
    });
    expect(profileSchema.safeParse(profile).success).toBe(true);
  });

  it("keeps a valid inline photo and drops anything else", () => {
    const photo = "data:image/jpeg;base64,AAAA";
    expect(toProfile({ ...base, photo }).photo).toBe(photo);
    expect(toProfile({ ...base, photo: "https://example.com/me.jpg" })).not.toHaveProperty("photo");
  });

  it("clamps an over-long name", () => {
    expect(toProfile({ ...base, name: "x".repeat(100) }).name).toHaveLength(32);
  });
});

describe("labels", () => {
  it("has an emoji for every protocol topic", () => {
    expect(Object.keys(TOPIC_EMOJI).sort()).toEqual([...TOPICS].sort());
  });

  it("offers unspecified as the last gender choice with its own label key", () => {
    expect(GENDER_CHOICES.at(-1)).toEqual({ value: "unspecified", label: "form.gender.unspecified" });
  });
});
