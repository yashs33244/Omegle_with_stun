import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { api as defaultApi, type Api } from "@/lib/api";
import { LIMITS, takedownRequestSchema, type PublicConfig, type TakedownRequest } from "@/lib/protocol";
import { Turnstile } from "../gate/Turnstile";
import { LegalPage } from "./LegalPage";

const KINDS: ReadonlyArray<{ value: TakedownRequest["kind"]; label: string }> = [
  { value: "ncii", label: "An intimate image of me (or someone I represent) shared without consent" },
  { value: "csam", label: "Sexual content involving a minor" },
  { value: "impersonation", label: "Someone is pretending to be me" },
  { value: "other", label: "Something else" },
];

const ERROR_TEXT: Record<string, string> = {
  invalid: "Some fields are not valid. Check the form and try again.",
  turnstile_failed: "The security check failed. Please try again.",
  rate_limited: "Too many requests. Wait a minute and try again.",
};

const field = "w-full rounded border-2 border-black bg-white px-3 py-2 text-black";

export const TakedownForm: React.FC<{ api?: Api }> = ({ api = defaultApi }) => {
  const ids = useId();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [kind, setKind] = useState<TakedownRequest["kind"]>("ncii");
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [affected, setAffected] = useState<"yes" | "no" | "">("");
  const [goodFaith, setGoodFaith] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((c) => !cancelled && setConfig(c))
      .catch(() => !cancelled && setConfigFailed(true));
    return () => {
      cancelled = true;
    };
  }, [api]);

  const siteKey = config?.turnstileSiteKey ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = takedownRequestSchema.safeParse({
      kind,
      contactEmail: email.trim(),
      description,
      ...(location.trim() ? { location } : {}),
      isAffectedPerson: affected === "yes",
      goodFaithStatement: goodFaith,
      ...(token ? { turnstileToken: token } : {}),
    });
    if (!parsed.success || affected === "") {
      const issue = parsed.success ? null : parsed.error.issues[0];
      const path = issue?.path[0];
      setError(
        affected === ""
          ? "Tell us whether you are the person affected."
          : path === "contactEmail"
            ? "Enter a valid email address."
            : path === "description"
              ? "Describe the content in at least 20 characters."
              : path === "goodFaithStatement"
                ? "Confirm the good faith statement."
                : ERROR_TEXT.invalid,
      );
      return;
    }
    if (siteKey && !token) {
      setError("Wait for the security check to finish.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.submitTakedown(parsed.data);
      if (res.ok) setTicketId(res.ticketId);
      else {
        setError(ERROR_TEXT[res.error] ?? ERROR_TEXT.invalid);
        setResetKey((n) => n + 1);
      }
    } catch {
      setError("Cannot reach Chizzy. Check your connection and try again.");
      setResetKey((n) => n + 1);
    } finally {
      setSending(false);
    }
  };

  if (ticketId) {
    return (
      <div role="status" data-testid="takedown-success" className="bg-green-50 border-2 border-green-600 rounded p-4 my-4">
        <p className="font-bold">We received your request.</p>
        <p>
          Your reference is <strong data-testid="takedown-ticket">{ticketId}</strong>. We will contact you at the email
          address you gave us.
        </p>
      </div>
    );
  }

  if (configFailed) {
    return (
      <p role="alert" className="text-red-700">
        The form cannot load right now. Check your connection and reload the page.
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 my-4" data-testid="takedown-form">
      <fieldset className="space-y-1">
        <legend className="font-bold">What is the content?</legend>
        {KINDS.map((k) => (
          <label key={k.value} className="flex items-start gap-2">
            <input
              type="radio"
              name={`${ids}-kind`}
              value={k.value}
              checked={kind === k.value}
              onChange={() => setKind(k.value)}
              className="mt-1"
            />
            <span>{k.label}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="font-bold">Are you the person affected?</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${ids}-affected`} checked={affected === "yes"} onChange={() => setAffected("yes")} />
          <span>Yes, it is me</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${ids}-affected`} checked={affected === "no"} onChange={() => setAffected("no")} />
          <span>No, I am reporting for someone else or as their representative</span>
        </label>
      </fieldset>

      <div>
        <label htmlFor={`${ids}-email`} className="font-bold block">
          Your email address
        </label>
        <input
          id={`${ids}-email`}
          data-testid="takedown-email"
          type="email"
          autoComplete="email"
          className={field}
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor={`${ids}-description`} className="font-bold block">
          Describe the content
        </label>
        <textarea
          id={`${ids}-description`}
          data-testid="takedown-description"
          className={`${field} min-h-32`}
          maxLength={LIMITS.takedownDescriptionMax}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-describedby={`${ids}-description-hint`}
        />
        <p id={`${ids}-description-hint`} className="text-xs text-gray-600">
          Do not attach or paste the image itself. Describe it so we can find it (at least 20 characters).
        </p>
      </div>

      <div>
        <label htmlFor={`${ids}-location`} className="font-bold block">
          Where and when did it appear? (optional)
        </label>
        <input
          id={`${ids}-location`}
          className={field}
          maxLength={500}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Approximate date and time, a display name, anything that helps"
        />
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid="takedown-good-faith"
          className="mt-1"
          checked={goodFaith}
          onChange={(e) => setGoodFaith(e.target.checked)}
        />
        <span>
          I believe in good faith that this content was shared without the consent of the person shown, or otherwise
          breaks the law or Chizzy's rules, and the information in this request is accurate.
        </span>
      </label>

      {siteKey && (
        <Turnstile
          siteKey={siteKey}
          action="takedown"
          resetKey={resetKey}
          onToken={setToken}
          onError={() => setError("The security check could not load. Check your connection and try again.")}
        />
      )}

      {error && (
        <p role="alert" className="text-red-700 text-sm" data-testid="takedown-error">
          {error}
        </p>
      )}

      <button type="submit" className="retro-button" disabled={sending || !config || (siteKey !== null && !token)} data-testid="takedown-submit">
        {sending ? "Sending..." : "Send request"}
      </button>
    </form>
  );
};

const Takedown = () => (
  <LegalPage title="Report content for removal">
    <p>
      Use this form to ask us to remove an intimate image shared without consent, sexual content involving a minor,
      impersonation, or other unlawful content connected to Chizzy.
    </p>
    <ul>
      <li>
        Chizzy does not record calls. Content we may hold is an image captured when a call was reported. Profile photos
        are passed between partners during a match and not kept after it.
      </li>
      <li>
        For intimate images shared without consent, the law (the US TAKE IT DOWN Act, and India's IT Rules) sets short
        deadlines for removal after a valid request. This form starts that process.
      </li>
      <li>
        If a child is in danger, contact the police or the helplines on our <Link to="/safety">Safety page</Link> first.
      </li>
    </ul>
    <TakedownForm />
  </LegalPage>
);

export default Takedown;
