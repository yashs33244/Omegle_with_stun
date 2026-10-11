import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { MATCH_MODES, flagsSchema, type Flags, type MatchMode } from "@/lib/protocol";
import type { AdminApi } from "@/lib/adminApi";
import { useAdmin, useAdminData } from "./adminShared";
import { Btn, ConfirmDialog, Notice } from "./AdminUi";

type FlagKey = keyof Flags;

const FIELDS: readonly FlagKey[] = [
  "matching_enabled",
  "new_sessions_enabled",
  "max_waiting",
  "turn_enabled",
  "private_mode_enabled",
  "video_max_kbps",
  "relay_video_max_kbps",
  "banner_message",
  "blocked_countries",
  "staffed_hours",
  "default_mode",
  "online_count_threshold",
  "premium_filters_enabled",
  "gender_filter_coins_per_day",
  "coin_packs",
];

/** Changes to these flags need an explicit confirmation. */
const CONFIRM_KEYS: readonly FlagKey[] = ["matching_enabled", "turn_enabled"];

const loadFlags = (api: AdminApi) => api.getFlags();

function riskyKey(key: FlagKey, on: boolean) {
  if (key === "matching_enabled") return on ? "flags.risky.matchingOn" : "flags.risky.matchingOff";
  return on ? "flags.risky.turnOn" : "flags.risky.turnOff";
}

export const FlagsEditor: React.FC = () => {
  const { t } = useTranslation("admin");
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
  if (loading && !draft) return <p className="text-sm text-gray-500">{t("loading", { ns: "common" })}</p>;
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
      setResult({ tone: "ok", text: t("flags.saved") });
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
        {t("flags.title")}
      </h2>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {FIELDS.map((key) => (
          <div key={key} className="grid gap-1 rounded-md border border-gray-200 bg-white p-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
            <div>
              <label htmlFor={`flag-${key}`} className="text-sm font-medium">
                {t(`flags.fields.${key}.label`)}
              </label>
              <p className="text-xs text-gray-500" id={`flag-${key}-help`}>
                {t(`flags.fields.${key}.help`)}
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
            {busy ? t("flags.saving") : t("flags.save")}
          </Btn>
          <Btn disabled={busy || !dirty} onClick={() => setDraft(data)}>
            {t("flags.discard")}
          </Btn>
        </div>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
      </form>
      <ConfirmDialog
        open={confirming}
        title={t("flags.confirmTitle")}
        description={risky.map((k) => (
          <p key={k}>
            <Trans
              t={t}
              i18nKey="flags.riskyLine"
              values={{
                label: t(`flags.fields.${k}.label`),
                state: draft[k] ? t("flags.on") : t("flags.off"),
                description: t(riskyKey(k, !!draft[k])),
              }}
              components={{ strong: <strong /> }}
            />
          </p>
        ))}
        confirmLabel={t("flags.save")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </section>
  );
};
