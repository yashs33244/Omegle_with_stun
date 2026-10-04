import { useEffect, useId, useState } from "react";
import { Ban } from "lucide-react";
import { api as defaultApi, type Api } from "@/lib/api";
import { getDeviceId } from "@/lib/device";
import { LIMITS, type Restriction, type RestrictionReason } from "@/lib/protocol";
import { Countdown } from "./gate/Countdown";
import { GateShell } from "./gate/GateScreens";

const REASON_TEXT: Record<RestrictionReason, string> = {
  nudity: "Nudity or sexual content on camera",
  "minor-safety": "A child safety concern",
  harassment: "Harassing or threatening someone",
  hate: "Hateful content about someone's identity",
  violence: "Violent or graphic content",
  spam: "Spam, scams or advertising",
  "fake-video": "Fake or pre-recorded video",
  underage: "Using Chizzy while under 18",
  other: "Breaking the Community Guidelines",
};

const KIND_TEXT: Record<Restriction["kind"], string> = {
  warning: "Warning",
  pause: "Temporary pause",
  ban: "Ban",
};

const APPEAL_STATUS_TEXT: Record<Exclude<Restriction["appeal"]["status"], "none">, string> = {
  pending: "We received your appeal. A person on our team will review it.",
  upheld: "Your appeal was reviewed and the restriction stays in place.",
  overturned: "Your appeal was accepted and the restriction was lifted.",
};

const APPEAL_ERROR_TEXT: Record<string, string> = {
  invalid: "Write at least 10 characters.",
  not_found: "We could not find this restriction. It may have ended already.",
  already_appealed: "You have already appealed this restriction.",
  not_appealable: "This restriction cannot be appealed.",
  rate_limited: "Too many tries. Wait a minute and try again.",
};

export interface RestrictedScreenProps {
  restriction: Restriction;
  /** The restriction ended or was lifted: start over. */
  onContinue: () => void;
  api?: Api;
}

export const RestrictedScreen: React.FC<RestrictedScreenProps> = ({ restriction: initial, onContinue, api = defaultApi }) => {
  const ids = useId();
  const [restriction, setRestriction] = useState(initial);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(initial.until !== null && initial.until <= Date.now());

  // Pick up a newer appeal status, if the server has one.
  useEffect(() => {
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
      setError(APPEAL_ERROR_TEXT.invalid);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.submitAppeal({ restrictionId: restriction.id, deviceId: getDeviceId(), text: trimmed });
      if (res.ok) {
        setRestriction((r) => ({ ...r, appeal: { status: "pending", submittedAt: Date.now() } }));
      } else {
        setError(APPEAL_ERROR_TEXT[res.error] ?? "Something went wrong. Try again.");
        if (res.error === "already_appealed") {
          setRestriction((r) => ({ ...r, appeal: { ...r.appeal, status: "pending" } }));
        }
      }
    } catch {
      setError("Cannot reach Chizzy. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <GateShell testId="restricted">
      <div className="text-center space-y-2 mb-4">
        <Ban className="w-10 h-10 mx-auto text-red-600" aria-hidden="true" />
        <h1 className="text-2xl font-bold">
          {restriction.kind === "warning" ? "You received a warning" : "Your access to matching is restricted"}
        </h1>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mb-4">
        <dt className="font-bold">Reason</dt>
        <dd data-testid="restriction-reason">{REASON_TEXT[restriction.reason]}</dd>
        <dt className="font-bold">Type</dt>
        <dd data-testid="restriction-kind">{KIND_TEXT[restriction.kind]}</dd>
        <dt className="font-bold">Ends</dt>
        <dd data-testid="restriction-until">
          {restriction.until === null ? (
            "Permanent"
          ) : expired ? (
            "Ended"
          ) : (
            <>
              in <Countdown until={restriction.until} onDone={() => setExpired(true)} />
            </>
          )}
        </dd>
      </dl>

      {!restriction.evidenceAvailable && (
        <p className="text-xs text-gray-600 mb-4">For safety reasons we cannot show the material behind this decision.</p>
      )}

      {!lifted &&
        (appealStatus !== "none" ? (
          <p role="status" className="text-sm bg-gray-100 rounded p-3 mb-4" data-testid="appeal-status">
            {APPEAL_STATUS_TEXT[appealStatus]}
          </p>
        ) : canAppeal ? (
          <form onSubmit={submit} className="space-y-2 mb-4" noValidate>
            <label htmlFor={`${ids}-appeal`} className="text-sm font-bold block">
              Think this is a mistake? Appeal for free.
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
              Tell us what happened. A person reviews every appeal. {trimmed.length}/{LIMITS.appealMax}
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <button type="submit" className="retro-button w-full" disabled={sending} data-testid="appeal-submit">
              {sending ? "Sending..." : "Send appeal"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-700 mb-4">This restriction cannot be appealed.</p>
        ))}

      {(lifted || restriction.kind === "warning") && (
        <button type="button" onClick={onContinue} className="retro-button w-full" data-testid="restriction-continue">
          Continue
        </button>
      )}
    </GateShell>
  );
};
