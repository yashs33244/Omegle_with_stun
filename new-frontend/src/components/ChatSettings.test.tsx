import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatSettings } from "./ChatSettings";
import type { Preferences, SimpleAck } from "@/lib/protocol";
import { LANGUAGE_OPTIONS } from "@/lib/utils";

const prefs: Preferences = { genderFilter: "all", languageFilter: "any" };

function renderSettings(overrides: Partial<React.ComponentProps<typeof ChatSettings>> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    preferences: prefs,
    onUpdatePreferences: vi.fn(async (): Promise<SimpleAck> => ({ ok: true })),
    ...overrides,
  };
  render(<ChatSettings {...props} />);
  return props;
}

/** A select's accessible name is its label followed by the current value. */
const labelled = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

async function openSelect(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: labelled(name) }));
  return { user, listbox: screen.getByRole("listbox", { name: labelled(name) }) };
}

describe("ChatSettings", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ChatSettings
        isOpen={false}
        onClose={vi.fn()}
        preferences={prefs}
        onUpdatePreferences={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current selections as labels", () => {
    renderSettings({ preferences: { genderFilter: "female", languageFilter: "hi" } });
    expect(screen.getByRole("button", { name: "Who do you want to meet? Female" })).toHaveTextContent("Female");
    expect(screen.getByRole("button", { name: /^Preferred Language .*Hindi/ })).toHaveTextContent("Hindi");
  });

  it("renders every gender filter option", async () => {
    renderSettings();
    const { listbox } = await openSelect("Who do you want to meet?");
    const options = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Everyone", "Male", "Female", "Other"]);
  });

  it("renders any language plus every language option", async () => {
    renderSettings();
    const { listbox } = await openSelect("Preferred Language");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(LANGUAGE_OPTIONS.length + 1);
    expect(options[0]).toHaveTextContent("Any language");
  });

  it("gender filter change calls updatePreferences and shows the ack result", async () => {
    const props = renderSettings();
    const { user, listbox } = await openSelect("Who do you want to meet?");
    await user.click(within(listbox).getByRole("option", { name: "Male" }));
    expect(props.onUpdatePreferences).toHaveBeenCalledWith({ genderFilter: "male", languageFilter: "any" });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("language change calls updatePreferences and shows a rejected ack", async () => {
    const props = renderSettings({
      onUpdatePreferences: vi.fn(async (): Promise<SimpleAck> => ({ ok: false, error: "rate_limited" })),
    });
    const { user, listbox } = await openSelect("Preferred Language");
    await user.click(within(listbox).getByRole("option", { name: /Spanish/ }));
    expect(props.onUpdatePreferences).toHaveBeenCalledWith({ genderFilter: "all", languageFilter: "es" });
    expect(await screen.findByRole("status")).toHaveTextContent("Too many changes");
  });

  it("re-selecting the current value does not send anything", async () => {
    const props = renderSettings();
    const { user, listbox } = await openSelect("Who do you want to meet?");
    await user.click(within(listbox).getByRole("option", { name: "Everyone" }));
    expect(props.onUpdatePreferences).not.toHaveBeenCalled();
  });

  it("keeps the gender and language preferences and points reporting to the flag", () => {
    renderSettings();
    expect(screen.getByRole("button", { name: labelled("Who do you want to meet?") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: labelled("Preferred Language") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Report/ })).not.toBeInTheDocument();
    expect(screen.getByText(/tap the flag in the call controls/)).toBeInTheDocument();
  });

  it("offers the UI language switcher", () => {
    renderSettings();
    expect(screen.getByTestId("language-switcher")).toBeInTheDocument();
  });

  it("close button calls onClose", async () => {
    const props = renderSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close settings" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
