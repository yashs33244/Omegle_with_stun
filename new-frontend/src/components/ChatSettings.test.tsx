import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatSettings } from "./ChatSettings";
import { REPORT_REASONS, type Preferences, type SimpleAck } from "@/lib/protocol";
import { GENDER_OPTIONS, LANGUAGE_OPTIONS, REPORT_REASON_LABELS } from "@/lib/utils";

const prefs: Preferences = { genderFilter: "all", languageFilter: "any" };

function renderSettings(overrides: Partial<React.ComponentProps<typeof ChatSettings>> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    preferences: prefs,
    onUpdatePreferences: vi.fn(async (): Promise<SimpleAck> => ({ ok: true })),
    onReport: vi.fn(async (): Promise<SimpleAck> => ({ ok: true })),
    canReport: true,
    ...overrides,
  };
  render(<ChatSettings {...props} />);
  return props;
}

async function openSelect(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name }));
  return { user, listbox: screen.getByRole("listbox", { name }) };
}

describe("ChatSettings", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ChatSettings
        isOpen={false}
        onClose={vi.fn()}
        preferences={prefs}
        onUpdatePreferences={vi.fn()}
        onReport={vi.fn()}
        canReport
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current selections as labels", () => {
    renderSettings({ preferences: { genderFilter: "female", languageFilter: "hi" } });
    expect(screen.getByRole("button", { name: "Who do you want to meet?" })).toHaveTextContent("Female");
    expect(screen.getByRole("button", { name: "Preferred Language" })).toHaveTextContent("Hindi");
  });

  it("renders every gender filter option", async () => {
    renderSettings();
    const { listbox } = await openSelect("Who do you want to meet?");
    const options = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(GENDER_OPTIONS.map((o) => o.label));
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

  it("report lists the protocol reasons and submits the chosen enum value", async () => {
    const props = renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Report Current User/ }));

    const submit = screen.getByRole("button", { name: "Submit Report" });
    expect(submit).toBeDisabled();

    const { listbox } = await openSelect("Reason for reporting");
    const labels = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(REPORT_REASONS.map((r) => REPORT_REASON_LABELS[r]));

    await user.click(within(listbox).getByRole("option", { name: "Harassment or bullying" }));
    await user.type(screen.getByLabelText(/Additional details/), "  rude  ");
    await user.click(screen.getByRole("button", { name: "Submit Report" }));

    expect(props.onReport).toHaveBeenCalledWith("harassment", "rude");
    expect(await screen.findByRole("status")).toHaveTextContent("User reported");
    expect(screen.queryByRole("dialog", { name: "Report User" })).not.toBeInTheDocument();
  });

  it("report shows the server error and keeps the dialog open", async () => {
    renderSettings({
      onReport: vi.fn(async (): Promise<SimpleAck> => ({ ok: false, error: "not_in_room" })),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Report Current User/ }));
    const { listbox } = await openSelect("Reason for reporting");
    await user.click(within(listbox).getByRole("option", { name: "Spam or unwanted content" }));
    await user.click(screen.getByRole("button", { name: "Submit Report" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("no longer in a call"));
    expect(screen.getByRole("dialog", { name: "Report User" })).toBeInTheDocument();
  });

  it("report is disabled outside a call", () => {
    renderSettings({ canReport: false });
    expect(screen.getByRole("button", { name: /Report Current User/ })).toBeDisabled();
  });

  it("close button calls onClose", async () => {
    const props = renderSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close settings" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
