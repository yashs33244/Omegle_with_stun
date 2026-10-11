import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n, { LANG_STORAGE_KEY } from "@/lib/i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { SafetyHelplines } from "./safety/SafetyInfo";

describe("LanguageSwitcher", () => {
  afterEach(async () => {
    localStorage.removeItem(LANG_STORAGE_KEY);
    await act(() => i18n.changeLanguage("en"));
  });

  it("starts in English with <html lang> set", () => {
    render(<LanguageSwitcher />);
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByTestId("language-en")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("language-hi")).toHaveAttribute("aria-pressed", "false");
  });

  it("switching to Hindi updates <html lang>, the helplines and the saved choice", async () => {
    render(
      <>
        <LanguageSwitcher />
        <SafetyHelplines />
      </>,
    );
    const helplines = screen.getByTestId("safety-helplines");
    expect(helplines).toHaveTextContent("India: cyber crime helpline 1930");

    await userEvent.click(screen.getByTestId("language-hi"));

    expect(document.documentElement.lang).toBe("hi");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("hi");
    expect(screen.getByTestId("language-hi")).toHaveAttribute("aria-pressed", "true");
    expect(helplines).toHaveTextContent("भारत: साइबर क्राइम हेल्पलाइन 1930");
    expect(screen.getByRole("link", { name: "1930" })).toHaveAttribute("href", "tel:1930");

    await userEvent.click(screen.getByTestId("language-en"));
    expect(document.documentElement.lang).toBe("en");
    expect(helplines).toHaveTextContent("India: cyber crime helpline 1930");
  });
});
