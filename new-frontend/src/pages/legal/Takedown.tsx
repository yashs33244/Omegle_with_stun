import { useEffect, useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api as defaultApi, type Api } from "@/lib/api";
import { LIMITS, takedownRequestSchema, type PublicConfig, type TakedownRequest } from "@/lib/protocol";
import { Turnstile } from "../gate/Turnstile";
import { LegalPage } from "./LegalPage";

const KINDS: ReadonlyArray<TakedownRequest["kind"]> = ["ncii", "csam", "impersonation", "other"];

type ErrorKey = `takedown.errors.${
  | "invalid"
  | "turnstileFailed"
  | "rateLimited"
  | "affected"
  | "email"
  | "description"
  | "goodFaith"
  | "turnstilePending"
  | "network"
  | "turnstileLoad"}`;

const API_ERROR: Record<string, ErrorKey> = {
  invalid: "takedown.errors.invalid",
  turnstile_failed: "takedown.errors.turnstileFailed",
  rate_limited: "takedown.errors.rateLimited",
};

const field = "w-full rounded border-2 border-black bg-white px-3 py-2 text-black";

export const TakedownForm: React.FC<{ api?: Api }> = ({ api = defaultApi }) => {
  const { t } = useTranslation("legal");
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
  const [error, setError] = useState<ErrorKey | null>(null);
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
          ? "takedown.errors.affected"
          : path === "contactEmail"
            ? "takedown.errors.email"
            : path === "description"
              ? "takedown.errors.description"
              : path === "goodFaithStatement"
                ? "takedown.errors.goodFaith"
                : "takedown.errors.invalid",
      );
      return;
    }
    if (siteKey && !token) {
      setError("takedown.errors.turnstilePending");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.submitTakedown(parsed.data);
      if (res.ok) setTicketId(res.ticketId);
      else {
        setError(API_ERROR[res.error] ?? "takedown.errors.invalid");
        setResetKey((n) => n + 1);
      }
    } catch {
      setError("takedown.errors.network");
      setResetKey((n) => n + 1);
    } finally {
      setSending(false);
    }
  };

  if (ticketId) {
    return (
      <div role="status" data-testid="takedown-success" className="bg-green-50 border-2 border-green-600 rounded p-4 my-4">
        <p className="font-bold">{t("takedown.success.title")}</p>
        <p>
          <Trans t={t} i18nKey="takedown.success.body" values={{ ticketId }} components={{ ref: <strong data-testid="takedown-ticket" /> }} />
        </p>
      </div>
    );
  }

  if (configFailed) {
    return (
      <p role="alert" className="text-red-700">
        {t("takedown.configFailed")}
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 my-4" data-testid="takedown-form">
      <fieldset className="space-y-1">
        <legend className="font-bold">{t("takedown.form.kind")}</legend>
        {KINDS.map((k) => (
          <label key={k} className="flex items-start gap-2">
            <input
              type="radio"
              name={`${ids}-kind`}
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              className="mt-1"
            />
            <span>{t(`takedown.kinds.${k}`)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="font-bold">{t("takedown.form.affected")}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${ids}-affected`} checked={affected === "yes"} onChange={() => setAffected("yes")} />
          <span>{t("takedown.form.affectedYes")}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${ids}-affected`} checked={affected === "no"} onChange={() => setAffected("no")} />
          <span>{t("takedown.form.affectedNo")}</span>
        </label>
      </fieldset>

      <div>
        <label htmlFor={`${ids}-email`} className="font-bold block">
          {t("takedown.form.email")}
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
          {t("takedown.form.description")}
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
          {t("takedown.form.descriptionHint")}
        </p>
      </div>

      <div>
        <label htmlFor={`${ids}-location`} className="font-bold block">
          {t("takedown.form.location")}
        </label>
        <input
          id={`${ids}-location`}
          className={field}
          maxLength={500}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder={t("takedown.form.locationPlaceholder")}
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
        <span>{t("takedown.form.goodFaith")}</span>
      </label>

      {siteKey && (
        <Turnstile
          siteKey={siteKey}
          action="takedown"
          resetKey={resetKey}
          onToken={setToken}
          onError={() => setError("takedown.errors.turnstileLoad")}
        />
      )}

      {error && (
        <p role="alert" className="text-red-700 text-sm" data-testid="takedown-error">
          {t(error)}
        </p>
      )}

      <button type="submit" className="retro-button" disabled={sending || !config || (siteKey !== null && !token)} data-testid="takedown-submit">
        {sending ? t("takedown.form.sending") : t("takedown.form.submit")}
      </button>
    </form>
  );
};

const Takedown = () => {
  const { t } = useTranslation("legal");
  return (
    <LegalPage title={t("takedown.title")}>
      <p>{t("takedown.intro")}</p>
      <ul>
        <li>{t("takedown.noRecording")}</li>
        <li>{t("takedown.deadlines")}</li>
        <li>
          <Trans t={t} i18nKey="takedown.childInDanger" components={{ safety: <Link to="/safety" /> }} />
        </li>
      </ul>
      <TakedownForm />
    </LegalPage>
  );
};

export default Takedown;
