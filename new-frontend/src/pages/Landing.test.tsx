import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { RoomProps } from "./Room";

const roomProps: { current: RoomProps | null } = { current: null };

vi.mock("./Room", () => ({
  Room: (props: RoomProps) => {
    roomProps.current = props;
    return (
      <div data-testid="room">
        <button type="button" onClick={props.onBackToHome}>
          leave
        </button>
      </div>
    );
  },
}));

import { Landing } from "./Landing";

function fakeStream() {
  const tracks = [
    { kind: "video", enabled: true, stop: vi.fn() },
    { kind: "audio", enabled: true, stop: vi.fn() },
  ];
  return {
    tracks,
    stream: {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
      getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    } as unknown as MediaStream,
  };
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  roomProps.current = null;
  getUserMedia = vi.fn(async () => fakeStream().stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  // useMediaStream logs the expected getUserMedia failures in the camera tests.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function openDetails() {
  const user = userEvent.setup();
  render(<Landing />, { wrapper: MemoryRouter });
  const start = await screen.findByTestId("start-chat");
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  await user.click(await screen.findByTestId("skip-photo"));
  const dialog = await screen.findByRole("dialog");
  return { user, dialog };
}

describe("Landing profile validation", () => {
  it("requires a name before the chat can start", async () => {
    const { user, dialog } = await openDetails();
    const begin = within(dialog).getByTestId("begin-chat");
    const name = within(dialog).getByTestId("name-input");

    expect(begin).toBeDisabled();

    await user.click(name);
    await user.tab();
    expect(within(dialog).getByText("Enter your name.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");

    await user.type(name, "   ");
    expect(begin).toBeDisabled();

    await user.type(name, "Asha");
    expect(begin).toBeEnabled();
    expect(within(dialog).queryByText("Enter your name.")).not.toBeInTheDocument();
  });

  it("requires at least one topic", async () => {
    const { user, dialog } = await openDetails();
    await user.type(within(dialog).getByTestId("name-input"), "Asha");
    const begin = within(dialog).getByTestId("begin-chat");
    expect(begin).toBeEnabled();

    const general = within(dialog).getByTestId("topic-general");
    expect(general).toHaveAttribute("aria-pressed", "true");
    await user.click(general);

    expect(general).toHaveAttribute("aria-pressed", "false");
    expect(begin).toBeDisabled();
    expect(within(dialog).getByText("Choose at least one topic.")).toBeInTheDocument();

    await user.click(within(dialog).getByTestId("topic-music"));
    expect(begin).toBeEnabled();
  });

  it("renders a topic button for every protocol topic", async () => {
    const { dialog } = await openDetails();
    const { TOPICS } = await import("../lib/protocol");
    for (const topic of TOPICS) {
      expect(within(dialog).getByTestId(`topic-${topic}`)).toBeInTheDocument();
    }
  });

  it("passes a typed profile with the chosen gender and topics to Room", async () => {
    const { user, dialog } = await openDetails();
    await user.type(within(dialog).getByTestId("name-input"), "  Asha  ");

    const gender = within(dialog).getByTestId("gender-select");
    expect(gender).toHaveTextContent("Prefer not to say");
    await user.click(gender);
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Male", "Female", "Other", "Prefer not to say"]);
    await user.click(within(dialog).getByRole("option", { name: "Female" }));
    expect(gender).toHaveTextContent("Female");

    await user.click(within(dialog).getByTestId("topic-music"));
    await user.click(within(dialog).getByTestId("begin-chat"));

    expect(await screen.findByTestId("room")).toBeInTheDocument();
    expect(roomProps.current?.profile).toEqual({
      name: "Asha",
      country: "IN",
      language: "en",
      gender: "female",
      topics: ["general", "music"],
    });
    expect(roomProps.current?.preferences).toEqual({ genderFilter: "all", languageFilter: "any" });
  });

  it("Escape closes an open dropdown first, then the dialog", async () => {
    const { user, dialog } = await openDetails();
    await user.click(within(dialog).getByTestId("gender-select"));
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("sends unspecified when the user prefers not to say", async () => {
    const { user, dialog } = await openDetails();
    await user.type(within(dialog).getByTestId("name-input"), "Sam");
    await user.click(within(dialog).getByTestId("begin-chat"));
    await screen.findByTestId("room");
    expect(roomProps.current?.profile.gender).toBe("unspecified");
  });
});

describe("Landing photo capture", () => {
  async function openCapture() {
    const user = userEvent.setup();
    render(<Landing />, { wrapper: MemoryRouter });
    const start = await screen.findByTestId("start-chat");
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    const dialog = await screen.findByRole("dialog");
    const video = within(dialog).getByLabelText("Camera preview") as HTMLVideoElement;
    return { user, dialog, video };
  }

  it("enables capture once the preview has a frame and sends the small photo", async () => {
    const jpeg = "data:image/jpeg;base64,QUJD";
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(jpeg);

    const { user, dialog, video } = await openCapture();
    const capture = within(dialog).getByTestId("capture-photo");
    expect(capture).toBeDisabled();

    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
    fireEvent.loadedData(video);
    expect(capture).toBeEnabled();

    await user.click(capture);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.8);
    expect(drawImage).toHaveBeenCalledWith(video, 280, 0, 720, 720, 0, 0, 256, 256);
    expect(await within(dialog).findByAltText("Your profile photo")).toHaveAttribute("src", jpeg);

    await user.type(within(dialog).getByTestId("name-input"), "Asha");
    await user.click(within(dialog).getByTestId("begin-chat"));
    expect(roomProps.current?.profile.photo).toBe(jpeg);
  });

  it("shows why a capture failed instead of failing silently", async () => {
    const { user, dialog, video } = await openCapture();
    // loadeddata fired but the frame size is still unknown.
    fireEvent.loadedData(video);
    await user.click(within(dialog).getByTestId("capture-photo"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("not showing a picture yet");
    expect(within(dialog).getByTestId("capture-photo")).toBeInTheDocument();
  });
});

describe("Landing camera handling", () => {
  it("shows the real cause when the camera is blocked and retries on demand", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const user = userEvent.setup();
    render(<Landing />, { wrapper: MemoryRouter });

    const problem = await screen.findByTestId("camera-error");
    expect(problem).toHaveTextContent("Camera access is blocked");
    expect(screen.getByTestId("start-chat")).toBeDisabled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await user.click(within(problem).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("start-chat")).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("explains a busy camera", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    render(<Landing />, { wrapper: MemoryRouter });
    expect(await screen.findByTestId("camera-error")).toHaveTextContent("Camera is busy");
  });

  it("releases the camera when leaving the room and starts a fresh one at home", async () => {
    const first = fakeStream();
    const second = fakeStream();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const { user, dialog } = await openDetails();
    await user.type(within(dialog).getByTestId("name-input"), "Asha");
    await user.click(within(dialog).getByTestId("begin-chat"));
    expect(roomProps.current?.localStream).toBe(first.stream);

    await user.click(screen.getByRole("button", { name: "leave" }));

    first.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("start-chat")).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    second.tracks.forEach((t) => expect(t.stop).not.toHaveBeenCalled());
  });
});
