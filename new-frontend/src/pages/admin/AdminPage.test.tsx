import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminPage from "./AdminPage";
import { ADMIN_TOKEN_KEY } from "@/lib/adminApi";
import { FLAG_DEFAULTS, type AdminAppeal, type AdminReport, type AdminTakedown, type Flags } from "@/lib/protocol";
import { watermarkCode } from "@/components/safety/watermarkCode";

const NOW = Date.now();
const H = 3_600_000;

function report(over: Partial<AdminReport>): AdminReport {
  return {
    id: "r-x",
    createdAt: NOW - H,
    reason: "spam",
    severity: "low",
    status: "open",
    roomId: "44444444-4444-4444-8444-444444444444",
    reporter: "rep-hash",
    reported: "dev-hash",
    reporterWeight: 0.8,
    details: null,
    hasFrame: false,
    chat: [],
    restricted: false,
    nsfwScore: null,
    ackDueAt: NOW + 10 * H,
    resolveDueAt: NOW + 100 * H,
    priorReportsAgainst: 0,
    ...over,
  };
}

const REPORTS: AdminReport[] = [
  report({ id: "r-spam", reason: "spam", severity: "low" }),
  report({
    id: "r-nude",
    reason: "nudity",
    severity: "high",
    hasFrame: true,
    nsfwScore: 0.93,
    ackDueAt: NOW - 2 * H,
    chat: [{ from: "reported", text: "show me", ts: NOW - H }],
  }),
  report({ id: "r-minor", reason: "underage", severity: "critical", hasFrame: true, restricted: true }),
  report({ id: "r-done", reason: "harassment", severity: "medium", status: "dismissed" }),
];

const APPEALS: AdminAppeal[] = [
  {
    id: "a1",
    restrictionId: "55555555-5555-4555-8555-555555555555",
    restriction: {
      id: "55555555-5555-4555-8555-555555555555",
      reason: "spam",
      kind: "pause",
      until: NOW + 24 * H,
      createdAt: NOW - H,
      evidenceAvailable: true,
      appeal: { status: "pending", submittedAt: NOW - H },
      appealable: true,
    },
    text: "I was not spamming, I only said hello.",
    createdAt: NOW - H,
    dueAt: NOW + 47 * H,
    status: "pending",
  },
];

const TAKEDOWNS: AdminTakedown[] = [
  {
    id: "t1",
    kind: "ncii",
    contactEmail: "person@example.com",
    description: "A frame of me was captured without consent during a call.",
    location: "Yesterday 9 pm",
    isAffectedPerson: true,
    createdAt: NOW - 50 * H,
    dueAt: NOW - 2 * H,
    status: "open",
    resolution: null,
  },
];

type Call = { method: string; path: string; body: unknown; auth: string | null };

function mockServer(opts: { status?: number } = {}) {
  const calls: Call[] = [];
  let flags: Flags = { ...FLAG_DEFAULTS };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body, auth: new Headers(init?.headers).get("Authorization") });
    if (opts.status) return json({ error: "unauthorized" }, opts.status);
    const p = url.pathname;
    if (p === "/admin/api/reports") return json({ reports: REPORTS });
    if (p.endsWith("/frame")) return json({ frame: "data:image/jpeg;base64,AAAA" });
    if (p.endsWith("/action")) {
      return body.action === "escalate_csam"
        ? json({ ok: true, packet: { reportId: "r-minor", humanViewed: false } })
        : json({ ok: true });
    }
    if (p === "/admin/api/appeals") return json({ appeals: APPEALS });
    if (p.endsWith("/decision")) return json({ ok: true });
    if (p === "/admin/api/takedowns") return json({ takedowns: TAKEDOWNS });
    if (p.endsWith("/resolve")) return json({ ok: true });
    if (p === "/admin/api/flags") {
      if (method === "PUT") flags = body;
      return json({ flags });
    }
    if (p === "/admin/api/audit") {
      return json({
        entries: [
          { id: "e1", ts: NOW - 2 * H, action: "report.dismiss", target: "r-done", note: null, ip: "10.0.0.1" },
          { id: "e2", ts: NOW - H, action: "evidence.view", target: "r-nude", note: "checked", ip: null },
        ],
      });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

beforeEach(() => {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, "tok");
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("admin console", () => {
  it("asks for a token, keeps it in sessionStorage and uses it as a bearer token", async () => {
    sessionStorage.clear();
    const server = mockServer();
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.type(screen.getByLabelText("Admin token"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe("s3cret");
    await screen.findAllByTestId("queue-item");
    expect(server.calls[0]).toMatchObject({ path: "/admin/api/reports", auth: "Bearer s3cret" });
  });

  it("signs out when the server rejects the token", async () => {
    mockServer({ status: 401 });
    render(<AdminPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected this token");
    expect(screen.getByLabelText("Admin token")).toBeInTheDocument();
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it("sorts the open queue by severity with SLA chips, overdue in red", async () => {
    mockServer();
    render(<AdminPage />);
    const items = await screen.findAllByTestId("queue-item");
    expect(items.map((i) => i.getAttribute("data-severity"))).toEqual(["critical", "high", "low"]);
    const overdue = within(items[1]!).getByTestId("sla-chip");
    expect(overdue).toHaveAttribute("data-overdue", "true");
    expect(overdue).toHaveTextContent(/Ack: overdue 2 h/);
    expect(overdue.className).toContain("bg-red-600");
    expect(within(items[2]!).getByTestId("sla-chip")).toHaveAttribute("data-overdue", "false");

    await userEvent.setup().click(screen.getByLabelText("Show closed"));
    expect(screen.getAllByTestId("queue-item")).toHaveLength(4);
  });

  it("shows evidence blurred and greyscale until Unblur, with chat, score and watermark code", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<AdminPage />);
    const items = await screen.findAllByTestId("queue-item");
    await user.click(items[1]!);
    const detail = screen.getByTestId("report-detail");
    expect(within(detail).getByText(/submitted by the reporter, unverified/)).toBeInTheDocument();
    const img = await within(detail).findByTestId("evidence-image");
    expect(img).toHaveAttribute("data-blurred", "true");
    expect(img.style.filter).toBe("blur(16px) grayscale(1)");
    expect(within(detail).getByTestId("detail-score")).toHaveTextContent("0.93");
    expect(within(detail).getByTestId("detail-chat")).toHaveTextContent("Reported: show me");
    expect(within(detail).getByTestId("detail-watermark")).toHaveTextContent(watermarkCode(REPORTS[1]!.roomId));

    await user.click(within(detail).getByRole("button", { name: "Unblur" }));
    expect(img).toHaveAttribute("data-blurred", "false");
    expect(img.style.filter).toBe("none");
  });

  it("never loads or offers to unblur a restricted item, and escalation downloads the packet", async () => {
    const server = mockServer();
    const create = vi.fn(() => "blob:packet");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<AdminPage />);
    const items = await screen.findAllByTestId("queue-item");
    await user.click(items[0]!);
    const detail = screen.getByTestId("report-detail");
    expect(within(detail).getByTestId("evidence-restricted")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Unblur" })).not.toBeInTheDocument();
    expect(server.calls.some((c) => c.path.endsWith("/frame"))).toBe(false);

    await user.click(within(detail).getByRole("button", { name: "Escalate CSAM" }));
    await user.click(await screen.findByRole("button", { name: "Escalate and download packet" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(server.calls.find((c) => c.path.endsWith("/action"))).toMatchObject({
      path: "/admin/api/reports/r-minor/action",
      body: { action: "escalate_csam" },
    });
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual({ reportId: "r-minor", humanViewed: false });
    expect(await screen.findByText(/Escalated/)).toBeInTheDocument();
  });

  it("restricts with a duration preset and confirms a permanent restriction", async () => {
    const server = mockServer();
    const user = userEvent.setup();
    render(<AdminPage />);
    const items = await screen.findAllByTestId("queue-item");
    await user.click(items[1]!);
    const detail = screen.getByTestId("report-detail");

    await user.selectOptions(within(detail).getByLabelText("Duration"), "10 min");
    await user.click(within(detail).getByRole("button", { name: "Restrict" }));
    await within(detail).findByText("Restricted for 10 min.");
    expect(server.calls.filter((c) => c.path.endsWith("/action")).at(-1)?.body).toEqual({
      action: "restrict",
      reason: "nudity",
      durationMs: 600_000,
    });

    await user.selectOptions(within(detail).getByLabelText("Duration"), "Permanent");
    await user.type(within(detail).getByLabelText(/Note/), "repeat offender");
    await user.click(within(detail).getByRole("button", { name: "Restrict" }));
    await user.click(await screen.findByRole("button", { name: "Restrict permanently" }));
    await within(detail).findByText("Restricted permanently.");
    expect(server.calls.filter((c) => c.path.endsWith("/action")).at(-1)?.body).toEqual({
      action: "restrict",
      reason: "nudity",
      durationMs: null,
      note: "repeat offender",
    });
  });

  it("decides appeals and resolves takedowns", async () => {
    const server = mockServer();
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole("button", { name: "Appeals" }));
    const appeal = await screen.findByTestId("appeal-item");
    expect(appeal).toHaveTextContent("I was not spamming");
    await user.click(within(appeal).getByRole("button", { name: "Overturn" }));
    await within(appeal).findByText("Restriction overturned.");
    expect(server.calls.find((c) => c.path === "/admin/api/appeals/a1/decision")?.body).toEqual({ decision: "overturn" });

    await user.click(screen.getByRole("button", { name: "Takedowns" }));
    const ticket = await screen.findByTestId("takedown-item");
    expect(within(ticket).getByTestId("sla-chip")).toHaveAttribute("data-overdue", "true");
    const resolve = within(ticket).getByRole("button", { name: "Resolve" });
    expect(resolve).toBeDisabled();
    await user.type(within(ticket).getByLabelText(/Resolution/), "Frame deleted");
    await user.click(resolve);
    await within(ticket).findByText("Resolved.");
    expect(server.calls.find((c) => c.path === "/admin/api/takedowns/t1/resolve")?.body).toEqual({
      resolution: "Frame deleted",
    });
  });

  it("edits flags, validates them and confirms turning matching off", async () => {
    const server = mockServer();
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole("button", { name: "Flags" }));
    const blocked = await screen.findByLabelText("Blocked countries");
    expect(blocked).toHaveValue(FLAG_DEFAULTS.blocked_countries);

    await user.clear(screen.getByLabelText("Staffed hours"));
    await user.type(screen.getByLabelText("Staffed hours"), "8pm to midnight");
    await user.click(screen.getByRole("button", { name: "Save flags" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === "PUT")).toBe(false);

    await user.clear(screen.getByLabelText("Staffed hours"));
    await user.type(screen.getByLabelText("Staffed hours"), "20:00-24:00 Asia/Kolkata");
    await user.click(screen.getByLabelText("Matching enabled"));
    await user.click(screen.getByRole("button", { name: "Save flags" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("No new matches will start");
    await user.click(within(dialog).getByRole("button", { name: "Save flags" }));
    await screen.findByText(/Flags saved/);
    expect(server.calls.find((c) => c.method === "PUT")?.body).toMatchObject({
      matching_enabled: false,
      staffed_hours: "20:00-24:00 Asia/Kolkata",
    });
  });

  it("lists the audit log newest first", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole("button", { name: "Audit log" }));
    const table = await screen.findByTestId("audit-table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("evidence.view");
    expect(rows[1]).toHaveTextContent("report.dismiss");
  });
});
