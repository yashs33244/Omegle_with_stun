import { describe, expect, it } from "vitest";
import { formatDuration, parseDob } from "./dob";

const today = new Date(2026, 9, 4);

describe("parseDob", () => {
  it("accepts a real past date and returns ISO", () => {
    expect(parseDob({ day: "7", month: "3", year: "1999" }, today)).toEqual({ ok: true, iso: "1999-03-07" });
  });

  it("rejects missing, malformed, impossible and future dates", () => {
    expect(parseDob({ day: "", month: "3", year: "1999" }, today).ok).toBe(false);
    expect(parseDob({ day: "a", month: "3", year: "1999" }, today).ok).toBe(false);
    expect(parseDob({ day: "31", month: "2", year: "1999" }, today).ok).toBe(false);
    expect(parseDob({ day: "29", month: "2", year: "2001" }, today).ok).toBe(false);
    expect(parseDob({ day: "29", month: "2", year: "2004" }, today).ok).toBe(true);
    expect(parseDob({ day: "5", month: "10", year: "2026" }, today).ok).toBe(false);
    expect(parseDob({ day: "1", month: "1", year: "1899" }, today).ok).toBe(false);
  });

  it("does not judge age: a 15 year old's date is still a valid date for the server to decide", () => {
    expect(parseDob({ day: "1", month: "1", year: "2011" }, today)).toEqual({ ok: true, iso: "2011-01-01" });
  });
});

describe("formatDuration", () => {
  it("formats countdowns", () => {
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(4 * 60_000 + 9_000)).toBe("4 min 09 s");
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe("2 h 05 min");
    expect(formatDuration(3 * 86_400_000)).toBe("3 d 0 h");
    expect(formatDuration(-5)).toBe("0 s");
  });
});
