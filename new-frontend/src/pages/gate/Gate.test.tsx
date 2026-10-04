import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Api } from "@/lib/api";
import type { PublicConfig, Restriction, SessionRequest, SessionResponse } from "@/lib/protocol";
import {
  getSessionToken,
  invalidateSession,
  isLockedOut,
  resetSessionStateForTests,
  saveSession,
  waitForSession,
} from "@/lib/session";
import { Gate } from "./Gate";

const TOS = "2026-10-draft";
const FP = "f".repeat(64);

function config(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    tosVersion: TOS,
    turnstileSiteKey: null,
    sentryDsn: null,
    posthogKey: null,
    posthogHost: null,
    banner: null,
    matchingOpen: true,
    staffedHours: null,
    reopensAt: null,
    defaultMode: "instant",
    privateModeEnabled: true,
    ...overrides,
  };
}

const okSession = (token = "session-1"): SessionResponse => ({
  ok: true,
  sessionToken: token,
  sessionExpiresAt: Date.now() + 86_400_000,
  ageToken: "age-1",
  ageExpiresAt: Date.now() + 180 * 86_400_000,
  country: "IN",
});

function fakeApi(cfg: PublicConfig | (() => PublicConfig), sessions: SessionResponse[] = [okSession()]) {
  const requests: SessionRequest[] = [];
  const api: Api = {
    getConfig: vi.fn(async () => (typeof cfg === "function" ? cfg() : cfg)),
    createSession: vi.fn(async (req: SessionRequest) => {
      requests.push(req);
      return sessions.shift() ?? okSession();
    }),
    getRestriction: vi.fn(async () => null),
    submitAppeal: vi.fn(async () => ({ ok: true as const, appealId: "a1" })),
    submitTakedown: vi.fn(async () => ({ ok: true as const, ticketId: "t1" })),
  };
  return { api, requests };
}

function renderGate(api: Api) {
  return render(
    <MemoryRouter>
      <Gate api={api} fingerprint={async () => FP}>
        <div data-testid="app">camera app</div>
      </Gate>
    </MemoryRouter>,
  );
}

async function fillDob(user: ReturnType<typeof userEvent.setup>, d: string, m: string, y: string) {
  await user.type(await screen.findByTestId("dob-day"), d);
  await user.type(screen.getByTestId("dob-month"), m);
  await user.type(screen.getByTestId("dob-year"), y);
  await user.click(screen.getByTestId("attest-18"));
  await user.click(screen.getByTestId("accept-tos"));
}

beforeEach(() => {
  localStorage.clear();
  resetSessionStateForTests();
  delete window.turnstile;
});

describe("Gate", () => {
  it("asks a new visitor for date of birth, attestation and Terms before showing the app", async () => {
    const user = userEvent.setup();
    const { api, requests } = fakeApi(config());
    renderGate(api);

    const continueButton = await screen.findByTestId("gate-continue");
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    expect(continueButton).toBeDisabled();
    expect(screen.getByRole("group", { name: "Date of birth" })).toBeInTheDocument();
    expect(within(screen.getByTestId("gate-form")).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByTestId("site-footer")).toBeInTheDocument();

    await fillDob(user, "7", "3", "1999");
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(requests[0]).toMatchObject({
      fingerprint: FP,
      age: { dob: "1999-03-07", attest18: true, tosVersion: TOS },
    });
    expect(requests[0]).not.toHaveProperty("turnstileToken");
    expect(getSessionToken()).toBe("session-1");
    expect(JSON.stringify(localStorage)).not.toContain("1999");
  });

  it("lets a returning device with a valid session straight through", async () => {
    saveSession(okSession() as Extract<SessionResponse, { ok: true }>, TOS);
    const { api } = fakeApi(config());
    renderGate(api);
    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("only re-runs the bot check when the session expired", async () => {
    const user = userEvent.setup();
    saveSession({ ...(okSession() as Extract<SessionResponse, { ok: true }>), sessionExpiresAt: Date.now() - 1 }, TOS);
    window.turnstile = {
      render: (_el, opts) => {
        setTimeout(() => opts.callback("ts-token"), 0);
        return "w1";
      },
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const { api, requests } = fakeApi(config({ turnstileSiteKey: "1x00000000000000000000AA" }));
    renderGate(api);

    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expect(screen.queryByTestId("dob-day")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("gate-continue")).toBeEnabled());
    await user.click(screen.getByTestId("gate-continue"));
    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(requests[0]).toMatchObject({ turnstileToken: "ts-token", age: { ageToken: "age-1", tosVersion: TOS } });
  });

  it("locks out an under-18 date of birth and keeps it locked", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(config(), [{ ok: false, error: "underage" }]);
    const { unmount } = renderGate(api);
    await fillDob(user, "1", "1", "2012");
    await user.click(screen.getByTestId("gate-continue"));

    expect(await screen.findByText("Chizzy is for adults only")).toBeInTheDocument();
    expect(screen.getByTestId("helplines")).toHaveTextContent("1098");
    expect(screen.getByTestId("helplines")).toHaveTextContent("988");
    expect(isLockedOut()).toBe(true);
    unmount();

    renderGate(api);
    expect(await screen.findByText("Chizzy is for adults only")).toBeInTheDocument();
    expect(screen.queryByTestId("dob-day")).not.toBeInTheDocument();
  });

  it("explains a regional block", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(config(), [{ ok: false, error: "region_blocked" }]);
    renderGate(api);
    await fillDob(user, "1", "1", "1990");
    await user.click(screen.getByTestId("gate-continue"));
    expect(await screen.findByText("Chizzy is not available in your country yet")).toBeInTheDocument();
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
  });

  it("shows the staffed hours while closed and continues by itself when matching opens", async () => {
    let open = false;
    const { api } = fakeApi(() =>
      config({ matchingOpen: open, staffedHours: "8 pm to midnight IST", reopensAt: open ? null : Date.now() + 1500 }),
    );
    renderGate(api);
    expect(await screen.findByText("Chizzy is open 8 pm to midnight IST")).toBeInTheDocument();
    expect(screen.getByTestId("reopens-countdown")).toHaveTextContent(/s$/);
    open = true;
    expect(await screen.findByTestId("dob-day", {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("offers a retry after a failed bot check", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(config(), [{ ok: false, error: "turnstile_failed" }, okSession()]);
    renderGate(api);
    await fillDob(user, "1", "1", "1990");
    await user.click(screen.getByTestId("gate-continue"));
    await user.click(await screen.findByTestId("gate-retry"));
    await fillDob(user, "1", "1", "1990");
    await user.click(screen.getByTestId("gate-continue"));
    expect(await screen.findByTestId("app")).toBeInTheDocument();
  });

  it("shows a restriction with a free appeal", async () => {
    const user = userEvent.setup();
    const restriction: Restriction = {
      id: "6a1f6f0e-8a43-4c5e-9f39-0c5e4f9b2d10",
      reason: "harassment",
      kind: "pause",
      until: Date.now() + 3_600_000,
      createdAt: Date.now(),
      evidenceAvailable: true,
      appeal: { status: "none" },
      appealable: true,
    };
    const { api } = fakeApi(config(), [{ ok: false, error: "banned", restriction }]);
    renderGate(api);
    await fillDob(user, "1", "1", "1990");
    await user.click(screen.getByTestId("gate-continue"));

    expect(await screen.findByTestId("restriction-reason")).toHaveTextContent("Harassing or threatening someone");
    expect(screen.getByTestId("restriction-kind")).toHaveTextContent("Temporary pause");
    expect(screen.getByTestId("restriction-until")).toHaveTextContent(/^in \d+ h \d+ min$/);
    await user.type(screen.getByTestId("appeal-text"), "I did not say anything rude.");
    await user.click(screen.getByTestId("appeal-submit"));
    expect(await screen.findByTestId("appeal-status")).toHaveTextContent("We received your appeal");
    expect(api.submitAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ restrictionId: restriction.id, text: "I did not say anything rude." }),
    );
  });

  it("asks again over the app when the socket rejects the session", async () => {
    const user = userEvent.setup();
    saveSession(okSession() as Extract<SessionResponse, { ok: true }>, TOS);
    const { api, requests } = fakeApi(config(), [okSession("session-2")]);
    renderGate(api);
    expect(await screen.findByTestId("app")).toBeInTheDocument();

    const next = waitForSession();
    act(() => invalidateSession("session_required"));
    const overlay = await screen.findByTestId("gate-reverify");
    expect(screen.getByTestId("app")).toBeInTheDocument();
    await user.click(await screen.findByTestId("gate-continue"));

    await expect(next).resolves.toBe("session-2");
    await waitFor(() => expect(overlay).not.toBeInTheDocument());
    expect(requests[0]?.age).toEqual({ ageToken: "age-1", tosVersion: TOS });
  });

  it("shows the operator banner from the config", async () => {
    const { api } = fakeApi(config({ banner: "Maintenance at 11 pm" }));
    renderGate(api);
    expect(await screen.findByTestId("server-banner")).toHaveTextContent("Maintenance at 11 pm");
  });
});
