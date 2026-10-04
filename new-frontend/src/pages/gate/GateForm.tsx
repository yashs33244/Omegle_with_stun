import { useId, useState } from "react";
import { Loader, ShieldCheck } from "lucide-react";
import { Button } from "@/components/retroui/Button";
import { parseDob, type DobParts } from "./dob";
import { Turnstile } from "./Turnstile";

export interface GateSubmit {
  /** ISO date of birth; absent for a returning device that has an age token. */
  dob?: string;
  turnstileToken?: string;
}

export interface GateFormProps {
  /** Null when the server runs without Turnstile (development). */
  siteKey: string | null;
  /** A returning device: only Turnstile is asked again. */
  returning: boolean;
  submitting: boolean;
  error: string | null;
  /** Shown above the form, for example "Our Terms changed". */
  notice?: string | null;
  /** Bumped by the parent to get a fresh Turnstile token after a failed attempt. */
  turnstileReset?: number;
  onSubmit: (input: GateSubmit) => void;
  onTurnstileError: () => void;
}

const fieldClass =
  "w-full rounded border-2 border-black bg-white px-3 py-2 text-black text-base focus:outline-none focus:ring-2 focus:ring-yellow-500";

/** Opens in a new tab so the half-filled gate is kept. */
const DocLink: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => (
  <a href={to} target="_blank" rel="noopener" className="underline font-medium">
    {children}
  </a>
);

export const GateForm: React.FC<GateFormProps> = ({
  siteKey,
  returning,
  submitting,
  error,
  notice,
  turnstileReset = 0,
  onSubmit,
  onTurnstileError,
}) => {
  const ids = useId();
  const [dob, setDob] = useState<DobParts>({ day: "", month: "", year: "" });
  const [dobTouched, setDobTouched] = useState(false);
  const [attest, setAttest] = useState(false);
  const [tos, setTos] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const parsed = parseDob(dob);
  const dobComplete = dob.day !== "" && dob.month !== "" && dob.year.length === 4;
  const showDobError = !parsed.ok && (dobTouched || dobComplete);
  const needsToken = siteKey !== null;
  const ready = (returning || (parsed.ok && attest && tos)) && (!needsToken || token !== null) && !submitting;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDobTouched(true);
    if (!ready) return;
    onSubmit({
      ...(returning || !parsed.ok ? {} : { dob: parsed.iso }),
      ...(token ? { turnstileToken: token } : {}),
    });
  };

  const setPart = (part: keyof DobParts) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDob((prev) => ({ ...prev, [part]: e.target.value.replace(/\D/g, "") }));

  return (
    <form onSubmit={submit} noValidate className="space-y-5" data-testid="gate-form" aria-busy={submitting}>
      <div className="text-center space-y-2">
        <ShieldCheck className="w-10 h-10 mx-auto text-yellow-500" aria-hidden="true" />
        <h1 className="text-2xl font-bold text-black">{returning ? "Welcome back" : "Before you start"}</h1>
        <p className="text-sm text-gray-600">
          {returning
            ? "Confirm you are a person to continue."
            : "Chizzy is for adults only. We check your age before turning on your camera."}
        </p>
      </div>

      {notice && (
        <p role="status" className="text-sm bg-yellow-100 border-2 border-yellow-500 rounded p-2 text-black">
          {notice}
        </p>
      )}

      {!returning && (
        <>
          <fieldset aria-describedby={`${ids}-dob-hint${showDobError ? ` ${ids}-dob-error` : ""}`}>
            <legend className="text-sm font-bold text-black">Date of birth</legend>
            <p id={`${ids}-dob-hint`} className="text-xs text-gray-600 mb-2">
              For example 27 3 1999. We do not store your date of birth, only whether you are 18 or older.
            </p>
            <div className="grid grid-cols-[1fr_1fr_1.6fr] gap-2">
              <div>
                <label htmlFor={`${ids}-day`} className="text-xs text-gray-700 block">
                  Day
                </label>
                <input
                  id={`${ids}-day`}
                  data-testid="dob-day"
                  className={fieldClass}
                  inputMode="numeric"
                  autoComplete="bday-day"
                  maxLength={2}
                  value={dob.day}
                  aria-invalid={showDobError || undefined}
                  onChange={setPart("day")}
                  onBlur={() => dob.day && setDobTouched(true)}
                />
              </div>
              <div>
                <label htmlFor={`${ids}-month`} className="text-xs text-gray-700 block">
                  Month
                </label>
                <input
                  id={`${ids}-month`}
                  data-testid="dob-month"
                  className={fieldClass}
                  inputMode="numeric"
                  autoComplete="bday-month"
                  maxLength={2}
                  value={dob.month}
                  aria-invalid={showDobError || undefined}
                  onChange={setPart("month")}
                />
              </div>
              <div>
                <label htmlFor={`${ids}-year`} className="text-xs text-gray-700 block">
                  Year
                </label>
                <input
                  id={`${ids}-year`}
                  data-testid="dob-year"
                  className={fieldClass}
                  inputMode="numeric"
                  autoComplete="bday-year"
                  maxLength={4}
                  value={dob.year}
                  aria-invalid={showDobError || undefined}
                  onChange={setPart("year")}
                  onBlur={() => setDobTouched(true)}
                />
              </div>
            </div>
            {showDobError && !parsed.ok && (
              <p id={`${ids}-dob-error`} className="text-xs text-red-700 mt-1">
                {parsed.error}
              </p>
            )}
          </fieldset>

          <div className="space-y-3 text-sm text-black">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="attest-18"
                className="mt-1 h-4 w-4 accent-yellow-500"
                checked={attest}
                onChange={(e) => setAttest(e.target.checked)}
              />
              <span>I am 18 or older.</span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="accept-tos"
                className="mt-1 h-4 w-4 accent-yellow-500"
                checked={tos}
                onChange={(e) => setTos(e.target.checked)}
              />
              <span>
                I agree to the <DocLink to="/terms">Terms</DocLink> and the{" "}
                <DocLink to="/guidelines">Community Guidelines</DocLink>, and I have read the{" "}
                <DocLink to="/privacy">Privacy Policy</DocLink>.
              </span>
            </label>
          </div>
        </>
      )}

      {siteKey && (
        <Turnstile
          siteKey={siteKey}
          action="session"
          resetKey={turnstileReset}
          onToken={setToken}
          onError={onTurnstileError}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700" data-testid="gate-error">
          {error}
        </p>
      )}

      <Button
        type="submit"
        data-testid="gate-continue"
        disabled={!ready}
        className="w-full justify-center bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? <Loader className="w-4 h-4 animate-spin mr-2" aria-hidden="true" /> : null}
        Continue
      </Button>
    </form>
  );
};
