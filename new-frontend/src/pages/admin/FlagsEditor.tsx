import React, { useEffect, useState } from "react";
import { MATCH_MODES, flagsSchema, type Flags, type MatchMode } from "@/lib/protocol";
import type { AdminApi } from "@/lib/adminApi";
import { useAdmin, useAdminData } from "./adminShared";
import { Btn, ConfirmDialog, Notice } from "./AdminUi";

type FlagKey = keyof Flags;

const FIELDS: ReadonlyArray<{ key: FlagKey; label: string; help: string }> = [
  { key: "matching_enabled", label: "Matching enabled", help: "Kill switch. Off: no new matches start." },
  { key: "new_sessions_enabled", label: "New sessions enabled", help: "Off: nobody new can pass the entry gate." },
  { key: "max_waiting", label: "Max waiting", help: "Queue size cap." },
  { key: "turn_enabled", label: "TURN relay enabled", help: "Off: calls that need a relay cannot connect." },
  { key: "private_mode_enabled", label: "Hide my IP allowed", help: "Relay-only calls on request." },
  { key: "video_max_kbps", label: "Video max (kbps)", help: "Direct calls." },
  { key: "relay_video_max_kbps", label: "Relayed video max (kbps)", help: "Calls through TURN." },
  { key: "banner_message", label: "Banner message", help: "Shown to everyone; empty hides it. Max 280 characters." },
  { key: "blocked_countries", label: "Blocked countries", help: "Comma-separated ISO codes, e.g. GB,AU,DE." },
  { key: "staffed_hours", label: "Staffed hours", help: 'e.g. "20:00-24:00 Asia/Kolkata". Empty means always open.' },
  { key: "default_mode", label: "Default match mode", help: "instant or preview." },
  { key: "online_count_threshold", label: "Online count threshold", help: "Show the online count only at or above this." },
];

/** Changes to these flags need an explicit confirmation. */
const CONFIRM_KEYS: readonly FlagKey[] = ["matching_enabled", "turn_enabled"];

const loadFlags = (api: AdminApi) => api.getFlags();

function describeRisky(key: FlagKey, on: boolean): string {
  if (key === "matching_enabled") {
    return on ? "Matching opens again for everyone (staffed hours still apply)." : "No new matches will start for anyone until you turn matching back on.";
  }
  return on
    ? "TURN relays are used again; relay traffic costs money."
    : "People on networks that need a relay will not be able to connect, and Hide my IP stops working.";
}

export const FlagsEditor: React.FC = () => {
  const { api, fail } = useAdmin();
  const { data, error, loading, reload } = useAdminData(loadFlags);
  const [draft, setDraft] = useState<Flags | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FlagKey, string>>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (error && !draft) return <Notice tone="error">{error}</Notice>;
  if (loading && !draft) return <p className="text-sm text-gray-500">Loading...</p>;
  if (!draft || !data) return null;

  const set = <K extends FlagKey>(key: K, value: Flags[K]) => {
    setDraft({ ...draft, [key]: value });
    setResult(null);
  };

  const risky = CONFIRM_KEYS.filter((k) => draft[k] !== data[k]);
  const dirty = (Object.keys(draft) as FlagKey[]).some((k) => draft[k] !== data[k]);

  const save = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const saved = await api.setFlags(draft);
      setDraft(saved);
      setResult({ tone: "ok", text: "Flags saved. Servers pick them up within a few seconds." });
      reload();
    } catch (err) {
      setResult({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = flagsSchema.safeParse(draft);
    if (!parsed.success) {
      const next: Partial<Record<FlagKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FlagKey;
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    if (risky.length > 0) setConfirming(true);
    else void save();
  };

  const field = (key: FlagKey) => {
    const value = draft[key];
    const id = `flag-${key}`;
    if (typeof value === "boolean") {
      return (
        <input
          id={id}
          type="checkbox"
          checked={value}
          onChange={(e) => set(key, e.target.checked as never)}
          className="h-5 w-5"
        />
      );
    }
    if (typeof value === "number") {
      return (
        <input
          id={id}
          type="number"
          value={Number.isNaN(value) ? "" : value}
          onChange={(e) => set(key, e.target.valueAsNumber as never)}
          className="w-40 rounded-md border border-gray-300 p-1.5"
        />
      );
    }
    if (key === "default_mode") {
      return (
        <select
          id={id}
          value={value}
          onChange={(e) => set("default_mode", e.target.value as MatchMode)}
          className="rounded-md border border-gray-300 p-1.5"
        >
          {MATCH_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      );
    }
    if (key === "banner_message") {
      return (
        <textarea
          id={id}
          value={value}
          maxLength={280}
          rows={2}
          onChange={(e) => set(key, e.target.value)}
          className="w-full rounded-md border border-gray-300 p-1.5"
        />
      );
    }
    return (
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) =>
          set(key, key === "blocked_countries" ? e.target.value.toUpperCase().replace(/\s+/g, "") : e.target.value)
        }
        className="w-full rounded-md border border-gray-300 p-1.5 font-mono text-sm"
      />
    );
  };

  return (
    <section aria-labelledby="flags-title" className="space-y-3">
      <h2 id="flags-title" className="text-lg font-semibold">
        Flags
      </h2>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {FIELDS.map(({ key, label, help }) => (
          <div key={key} className="grid gap-1 rounded-md border border-gray-200 bg-white p-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
            <div>
              <label htmlFor={`flag-${key}`} className="text-sm font-medium">
                {label}
              </label>
              <p className="text-xs text-gray-500" id={`flag-${key}-help`}>
                {help}
              </p>
            </div>
            <div>
              {field(key)}
              {errors[key] && (
                <p role="alert" className="mt-1 text-xs text-red-700">
                  {errors[key]}
                </p>
              )}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Btn type="submit" tone="primary" disabled={busy || !dirty}>
            {busy ? "Saving..." : "Save flags"}
          </Btn>
          <Btn disabled={busy || !dirty} onClick={() => setDraft(data)}>
            Discard changes
          </Btn>
        </div>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
      </form>
      <ConfirmDialog
        open={confirming}
        title="Confirm this change"
        description={risky.map((k) => (
          <p key={k}>
            <strong>{FIELDS.find((f) => f.key === k)?.label}</strong> {draft[k] ? "on" : "off"}: {describeRisky(k, !!draft[k])}
          </p>
        ))}
        confirmLabel="Save flags"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </section>
  );
};
