import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AdminApiError, createAdminApi, loadAdminToken, saveAdminToken } from "@/lib/adminApi";
import { AdminContext, errorText, type AdminContextValue } from "./adminShared";
import { Btn, Notice } from "./AdminUi";
import { ReportsView } from "./ReportsView";
import { AppealsView } from "./AppealsView";
import { TakedownsView } from "./TakedownsView";
import { FlagsEditor } from "./FlagsEditor";
import { AuditView } from "./AuditView";

const SECTIONS = [
  { id: "reports", label: "Reports", view: ReportsView },
  { id: "appeals", label: "Appeals", view: AppealsView },
  { id: "takedowns", label: "Takedowns", view: TakedownsView },
  { id: "flags", label: "Flags", view: FlagsEditor },
  { id: "audit", label: "Audit log", view: AuditView },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Keeps the console out of search engines while it is open. */
function useNoIndex() {
  useEffect(() => {
    const title = document.title;
    document.title = "Chizzy admin";
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => {
      document.title = title;
      meta.remove();
    };
  }, []);
}

const TokenForm: React.FC<{ message: string | null; onToken: (token: string) => void }> = ({ message, onToken }) => {
  const [value, setValue] = useState("");
  return (
    <form
      className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onToken(value.trim());
      }}
    >
      <h1 className="text-xl font-semibold">Chizzy admin</h1>
      {message && <Notice tone="error">{message}</Notice>}
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Admin token</span>
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-gray-300 p-2"
        />
      </label>
      <p className="text-xs text-gray-500">Kept in this tab only (session storage) and cleared when you sign out.</p>
      <Btn type="submit" tone="primary" disabled={!value.trim()} className="w-full">
        Sign in
      </Btn>
    </form>
  );
};

/** /admin: the moderation console. Loaded as its own chunk, never part of the main bundle. */
const AdminPage: React.FC = () => {
  useNoIndex();
  const [token, setToken] = useState<string | null>(loadAdminToken);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("reports");
  const now = useNow(30_000);

  const signOut = useCallback((message: string | null) => {
    saveAdminToken(null);
    setToken(null);
    setAuthMessage(message);
  }, []);

  const api = useMemo(() => (token ? createAdminApi({ token }) : null), [token]);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof AdminApiError && err.unauthorized) {
        signOut("The server rejected this token (or this network is not allowed). Sign in again.");
      }
      return errorText(err);
    },
    [signOut],
  );

  const ctx = useMemo<AdminContextValue | null>(() => (api ? { api, fail, now } : null), [api, fail, now]);

  if (!ctx) {
    return (
      <main className="min-h-screen bg-gray-50 p-4 text-gray-900">
        <TokenForm
          message={authMessage}
          onToken={(t) => {
            saveAdminToken(t);
            setAuthMessage(null);
            setToken(t);
          }}
        />
      </main>
    );
  }

  const View = SECTIONS.find((s) => s.id === section)!.view;

  return (
    <AdminContext.Provider value={ctx}>
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-3">
          <h1 className="text-lg font-semibold">Chizzy admin</h1>
          <nav aria-label="Admin sections" className="flex flex-wrap gap-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  section === s.id ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <Btn onClick={() => signOut(null)}>Sign out</Btn>
        </header>
        <main className="mx-auto max-w-6xl p-4">
          <View />
        </main>
      </div>
    </AdminContext.Provider>
  );
};

export default AdminPage;
