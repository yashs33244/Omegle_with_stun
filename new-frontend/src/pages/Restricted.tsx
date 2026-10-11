import { useEffect, useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Ban } from "lucide-react";
import { api as defaultApi, type Api } from "@/lib/api";
import { getDeviceId } from "@/lib/device";
import { LIMITS, type Restriction, type RestrictionReason } from "@/lib/protocol";
import { Countdown } from "./gate/Countdown";
import { GateShell } from "./gate/GateScreens";

const REASON_KEY = {
  nudity: "restricted.reasons.nudity",
  "minor-safety": "restricted.reasons.minorSafety",
  harassment: "restricted.reasons.harassment",
  hate: "restricted.reasons.hate",
  violence: "restricted.reasons.violence",
  spam: "restricted.reasons.spam",
  "fake-video": "restricted.reasons.fakeVideo",
  underage: "restricted.reasons.underage",
  other: "restricted.reasons.other",
} as const satisfies Record<RestrictionReason, string>;

const KIND_KEY = {
  warning: "restricted.kinds.warning",
  pause: "restricted.kinds.pause",
  ban: "restricted.kinds.ban",
} as const satisfies Record<Restriction["kind"], string>;

const APPEAL_STATUS_KEY = {
  pending: "restricted.appealStatus.pending",
  upheld: "restricted.appealStatus.upheld",
  overturned: "restricted.appealStatus.overturned",
} as const satisfies Record<Exclude<Restriction["appeal"]["status"], "none">, string>;

type AppealErrorKey = `restricted.appealErrors.${"invalid" | "notFound" | "alreadyAppealed" | "notAppealable" | "rateLimited" | "generic" | "network"}`;

const APPEAL_ERROR_KEY: Record<string, AppealErrorKey> = {
  invalid: "restricted.appealErrors.invalid",
  not_found: "restricted.appealErrors.notFound",
  already_appealed: "restricted.appealErrors.alreadyAppealed",
  not_appealable: "restricted.appealErrors.notAppealable",
  rate_limited: "restricted.appealErrors.rateLimited",
};

export interface RestrictedScreenProps {
  restriction: Restriction;
  /** The restriction ended or was lifted: start over. */
  onContinue: () => void;
  api?: Api;
}

export const RestrictedScreen: React.FC<RestrictedScreenProps> = ({ restriction: initial, onContinue, api = defaultApi }) => {
  const { t } = useTranslation("safety");
  const ids = useId();
  const [restriction, setRestriction] = useState(initial);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<AppealErrorKey | null>(null);
  const [expired, setExpired] = useState(initial.until !== null && initial.until <= Date.now());

  // Pick up a newer appeal status, if the server has one.
  useEffect(() => {
    if (!initial.id) return;
    let cancelled = false;
    api
      .getRestriction(initial.id, getDeviceId())
      .then((view) => {
        if (!cancelled && view) setRestriction(view.restriction);
      })
      .catch(() => {
        // The copy we have is good enough to show.
      });
    return () => {
      cancelled = true;
    };
  }, [api, initial.id]);

  const appealStatus = restriction.appeal.status;
  const canAppeal = restriction.appealable && appealStatus === "none";
  const lifted = appealStatus === "overturned" || expired;
  const trimmed = text.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmed.length < 10 || sending) {
      setError(APPEAL_ERROR_KEY.invalid);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.submitAppeal({ restrictionId: restriction.id, deviceId: getDeviceId(), text: trimmed });
      if (res.ok) {
        setRestriction((r) => ({ ...r, appeal: { status: "pending", submittedAt: Date.now() } }));
      } else {
        setError(APPEAL_ERROR_KEY[res.error] ?? "restricted.appealErrors.generic");
        if (res.error === "already_appealed") {
          setRestriction((r) => ({ ...r, appeal: { ...r.appeal, status: "pending" } }));
        }
      }
    } catch {
      setError("restricted.appealErrors.network");
    } finally {
      setSending(false);
    }
  };

  return (
    <GateShell testId="restricted">
      <div className="text-center space-y-2 mb-4">
        <Ban className="w-10 h-10 mx-auto text-red-600" aria-hidden="true" />
        <h1 className="text-2xl font-bold">
          {restriction.kind === "warning" ? t("restricted.titleWarning") : t("restricted.title")}
        </h1>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mb-4">
        <dt className="font-bold">{t("restricted.reasonLabel")}</dt>
        <dd data-testid="restriction-reason">{t(REASON_KEY[restriction.reason])}</dd>
        <dt className="font-bold">{t("restricted.typeLabel")}</dt>
        <dd data-testid="restriction-kind">{t(KIND_KEY[restriction.kind])}</dd>
        <dt className="font-bold">{t("restricted.endsLabel")}</dt>
        <dd data-testid="restriction-until">
          {restriction.until === null ? (
            t("restricted.permanent")
          ) : expired ? (
            t("restricted.ended")
          ) : (
            <Trans
              t={t}
              i18nKey="restricted.endsIn"
              components={{ countdown: <Countdown until={restriction.until} onDone={() => setExpired(true)} /> }}
            />
          )}
        </dd>
      </dl>

      {!restriction.evidenceAvailable && (
        <p className="text-xs text-gray-600 mb-4">{t("restricted.evidenceNote")}</p>
      )}

      {!lifted &&
        (appealStatus !== "none" ? (
          <p role="status" className="text-sm bg-gray-100 rounded p-3 mb-4" data-testid="appeal-status">
            {t(APPEAL_STATUS_KEY[appealStatus])}
          </p>
        ) : canAppeal ? (
          <form onSubmit={submit} className="space-y-2 mb-4" noValidate>
            <label htmlFor={`${ids}-appeal`} className="text-sm font-bold block">
              {t("restricted.appealLabel")}
            </label>
            <textarea
              id={`${ids}-appeal`}
              data-testid="appeal-text"
              className="w-full min-h-28 rounded border-2 border-black p-2 text-sm"
              maxLength={LIMITS.appealMax}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={`${ids}-appeal-hint`}
            />
            <p id={`${ids}-appeal-hint`} className="text-xs text-gray-600">
              {t("restricted.appealHint", { length: trimmed.length, max: LIMITS.appealMax })}
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {t(error)}
              </p>
            )}
            <button type="submit" className="retro-button w-full" disabled={sending} data-testid="appeal-submit">
              {sending ? t("restricted.sending") : t("restricted.sendAppeal")}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-700 mb-4">{t("restricted.notAppealable")}</p>
        ))}

      {(lifted || restriction.kind === "warning") && (
        <button type="button" onClick={onContinue} className="retro-button w-full" data-testid="restriction-continue">
          {t("restricted.continue")}
        </button>
      )}
    </GateShell>
  );
};
