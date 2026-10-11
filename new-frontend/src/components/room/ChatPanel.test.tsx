import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import { ChatToast } from "./ChatSheet";
import { Banner } from "@/components/Banner";
import { MatchPrompt } from "./MatchPrompt";
import { REDACTION_MARK } from "@/components/safety/RedactedText";
import type { ChatEntry } from "@/hooks/useSignaling";
import type { PublicProfile } from "@/lib/protocol";

/**
 * Partner- and server-provided text is rendered as text: markup stays literal,
 * nothing becomes an element, no URL becomes a link or a navigation target.
 */
const HOSTILE = '<img src=x onerror="window.pwned=1"><a href="javascript:alert(1)">click</a><script>window.pwned=1</script>';
const JS_URL = "javascript:alert(document.domain)";

declare global {
  interface Window {
    /** Set by the hostile markup above if it ever ran. */
    pwned?: number;
  }
}

function entry(from: ChatEntry["from"], text: string, id = `${from}-${text.length}`): ChatEntry {
  return { id, from, text, ts: 1 };
}

function renderPanel(messages: ChatEntry[], extra: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return render(
    <ChatPanel messages={messages} partnerTyping={false} textOnly={false} onSend={vi.fn()} onTyping={vi.fn()} {...extra} />,
  );
}

/** No element with a scriptable or navigating attribute was created from the text. */
function expectInert(root: HTMLElement) {
  expect(root.querySelector("script, img, iframe, object, embed, a, form")).toBeNull();
  expect(root.querySelector("[onerror], [onload], [onclick], [href], [src]")).toBeNull();
  expect(window.pwned).toBeUndefined();
}

describe("chat text is inert", () => {
  it("shows a partner message with HTML tags and a javascript: URL as plain text", () => {
    renderPanel([entry("partner", HOSTILE, "m1"), entry("partner", `open ${JS_URL} now`, "m2")]);
    const [first, second] = screen.getAllByTestId("chat-message");
    expect(first).toHaveTextContent(HOSTILE);
    expect(first!.textContent).toBe(HOSTILE);
    expect(second!.textContent).toBe(`open ${JS_URL} now`);
    expectInert(first!);
    expectInert(second!);
    expect(document.querySelector("a")).toBeNull();
  });

  it("keeps my own, system and redacted messages inert too", () => {
    renderPanel(
      [
        entry("me", HOSTILE, "mine"),
        entry("system", HOSTILE, "sys"),
        entry("partner", `${HOSTILE} ${REDACTION_MARK} ${JS_URL}`, "red"),
      ],
      { redactedIds: new Set(["red"]), safetyNotice: HOSTILE },
    );
    for (const el of screen.getAllByTestId("chat-message")) expectInert(el);
    expect(screen.getByText(HOSTILE, { selector: "p" })).toBeInTheDocument();
    const redacted = screen.getAllByTestId("chat-message")[1]!;
    expect(redacted.querySelectorAll("[data-testid=redaction-mark]")).toHaveLength(1);
    expect(redacted.textContent).toContain(JS_URL);
    expect(window.pwned).toBeUndefined();
  });

  it("renders the chat toast and the partner name as text", () => {
    render(<ChatToast message={entry("partner", HOSTILE)} partnerName={HOSTILE} onOpen={vi.fn()} onDismiss={vi.fn()} />);
    const toast = screen.getByTestId("chat-toast");
    expect(toast.textContent).toBe(`${HOSTILE}${HOSTILE}`);
    expect(toast.querySelector("script, img, a")).toBeNull();
    expect(toast).toHaveAttribute("aria-label", expect.stringContaining(HOSTILE));
  });
});

describe("server and partner profile text is inert", () => {
  it("renders the operator banner as text", () => {
    render(<Banner message={HOSTILE} />);
    const banner = screen.getByTestId("server-banner");
    expect(banner.textContent).toBe(HOSTILE);
    expectInert(banner);
  });

  it("never turns a partner photo into a remote or script URL", () => {
    const partner: PublicProfile = { name: HOSTILE, country: "IN", language: "en", topics: ["music"], photo: JS_URL };
    render(
      <MatchPrompt
        partner={partner}
        myTopics={["music"]}
        isFriend={false}
        expiresAt={Date.now() + 30_000}
        accepted={false}
        partnerAccepted={false}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onReport={vi.fn()}
      />,
    );
    const prompt = screen.getByTestId("match-prompt");
    expect(prompt.querySelector("img")).toBeNull();
    expect(prompt.querySelector("script, [onerror], a[href]")).toBeNull();
    expect(prompt.textContent).toContain(HOSTILE);
  });
});
