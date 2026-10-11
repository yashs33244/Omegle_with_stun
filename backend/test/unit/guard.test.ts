import { describe, expect, test } from "bun:test";
import { HIDDEN } from "../../src/safety/constants";
import { containsSlur, guardChat, guardName, nicknameFor, normalize } from "../../src/safety/guard";
import { NAME_SLURS, SOLICITATION_PHRASES } from "../../src/safety/phrases";

const DEVICE = "6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11";
const on = (text: string) => guardChat(text, { redact: true });

describe("chat guard redaction", () => {
  const hidden: [string, string][] = [
    ["check https://evil.example.com/x now", `check ${HIDDEN} now`],
    ["go to www.example.org", `go to ${HIDDEN}`],
    ["mysite.com is cool", `${HIDDEN} is cool`],
    ["mail me a.b@example.com", `mail me ${HIDDEN}`],
    ["follow @priya_22 pls", `follow ${HIDDEN} pls`],
    ["snap: rahulk", HIDDEN],
    ["my insta is priya.k", `my ${HIDDEN}`],
    ["insta priya", HIDDEN],
    ["ig priya_22", HIDDEN],
    ["ig - rahul", HIDDEN],
    ["add me on whatsapp", `add me on ${HIDDEN}`],
    ["telegram pe aao", HIDDEN],
    ["call 98765 43210", `call ${HIDDEN}`],
    ["+91 (987) 654-3210 ok", `${HIDDEN} ok`],
    ["number ९८७६५४३२१० hai", `number ${HIDDEN} hai`],
    ["call 1234567", `call ${HIDDEN}`], // PHONE_MIN_DIGITS
    ["card 123456789012345", `card ${HIDDEN}`], // PHONE_MAX_DIGITS
    ["instagram.com/priya", HIDDEN],
  ];
  test.each(hidden)("%p -> %p", (input, output) => {
    const r = on(input);
    expect(r.text).toBe(output);
    expect(r.redacted).toBe(true);
  });

  const clean = [
    "hi how are you",
    "ig its fine", // "I guess", not Instagram
    "I love snap peas",
    "i am 25 from delhi",
    "do you have insta account?",
    "the year 2024 was fun",
    "e.g. node.js is nice",
    "pin 123456", // one digit short of a phone number
    "ref 1234567890123456", // one digit past PHONE_MAX_DIGITS
  ];
  test.each(clean)("%p is left alone", (input) => {
    const r = on(input);
    expect(r.text).toBe(input);
    expect(r.redacted).toBe(false);
  });

  test("outside the guarded window nothing is hidden but contact sharing is still flagged", () => {
    const r = guardChat("snap: rahulk", { redact: false });
    expect(r).toEqual({ text: "snap: rahulk", redacted: false, contactSharing: true, solicitation: false });
  });

  test("plain links are hidden but are not contact sharing; social links are", () => {
    expect(on("see example.com").contactSharing).toBe(false);
    expect(on("see t.me/somebody").contactSharing).toBe(true);
  });

  test("contact phrases flag contact sharing without hiding anything", () => {
    const r = on("give me your number");
    expect(r).toMatchObject({ redacted: false, contactSharing: true });
    expect(on("apna number do na").contactSharing).toBe(true);
  });
});

describe("solicitation phrases", () => {
  const hits = [
    "show me your body",
    "SHOOOW your b0dy",
    "remove shirt pls",
    "kapde utaro",
    "kuch dikhao na",
    "i'll pay you for it",
    "send nudes",
    "कपड़े उतारो",
    "क्या तुम अकेली हो",
  ];
  test.each(hits)("%p is solicitation", (input) => {
    expect(on(input).solicitation).toBe(true);
  });

  const misses = ["show me your dog", "nice shirt", "what do you do", "I am alone at home studying"];
  test.each(misses)("%p is not", (input) => {
    expect(on(input).solicitation).toBe(false);
  });

  test("every listed phrase matches itself", () => {
    for (const p of SOLICITATION_PHRASES) expect(on(p).solicitation).toBe(true);
  });
});

describe("name guard", () => {
  test("ordinary names pass, including names that contain short slurs as substrings", () => {
    for (const name of ["Priya", "Rahul K", "Therapist Tom", "Spice Girl", "Scunthorpe", "Snap"]) {
      expect(guardName(name, DEVICE)).toEqual({ name, replaced: false });
    }
  });

  test("handles, links, phones and slurs become a stable nickname", () => {
    for (const name of ["@priya_22", "snap: rahulk", "insta priya", "9876543210", "site.com", "N1gg3r", "chutiya", "xxmadarchodxx", "रंडी"]) {
      const r = guardName(name, DEVICE);
      expect(r).toEqual({ name: nicknameFor(DEVICE), replaced: true });
    }
    expect(nicknameFor(DEVICE)).toMatch(/^Stranger \d{4}$/);
    expect(nicknameFor(DEVICE)).toBe(nicknameFor(DEVICE));
  });

  test("every listed slur is caught", () => {
    for (const s of NAME_SLURS) expect(containsSlur(s)).toBe(true);
  });
});

test("normalize collapses repeats, leetspeak and punctuation", () => {
  expect(normalize("Sh0ooow!!  ME")).toBe(" show me ");
});
