import { Trans, useTranslation } from "react-i18next";
import { LegalPage, Todo } from "./LegalPage";

/** Retention table from LAUNCH_PLAN LB-16 (the lawyer confirms it). */
const RETENTION = ["logs", "reports", "csam", "bans", "ageCheck", "lockout", "dob", "chat", "media", "telemetry"] as const;

const Privacy = () => {
  const { t } = useTranslation("legal");
  const todo = { todo: <Todo /> };
  return (
    <LegalPage title={t("privacy.title")} englishAuthoritative>
      <p>
        <Trans t={t} i18nKey="privacy.intro" components={todo} />
      </p>

      <h2>{t("privacy.ip.title")}</h2>
      <p data-testid="privacy-ip-disclosure">
        <Trans t={t} i18nKey="privacy.ip.body" />
      </p>

      <h2>{t("privacy.collect.title")}</h2>
      <ul>
        <li>
          <Trans t={t} i18nKey="privacy.collect.age" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.collect.profile" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.collect.signals" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.collect.reports" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.collect.telemetry" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.collect.errors" />
        </li>
      </ul>
      <p>{t("privacy.collect.noRecording")}</p>

      <h2>{t("privacy.processors.title")}</h2>
      <ul>
        <li>
          <Trans t={t} i18nKey="privacy.processors.cloudflare" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.processors.sentry" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.processors.posthog" />
        </li>
        <li>
          <Trans t={t} i18nKey="privacy.processors.hosting" components={todo} />
        </li>
      </ul>
      <p>
        <Trans t={t} i18nKey="privacy.processors.transfers" components={todo} />
      </p>

      <h2>{t("privacy.retention.title")}</h2>
      <table data-testid="retention-table">
        <thead>
          <tr>
            <th scope="col">{t("privacy.retention.colData")}</th>
            <th scope="col">{t("privacy.retention.colRetention")}</th>
          </tr>
        </thead>
        <tbody>
          {RETENTION.map((row) => (
            <tr key={row}>
              <td>{t(`privacy.retention.rows.${row}.data`)}</td>
              <td>{t(`privacy.retention.rows.${row}.period`)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t("privacy.storage.title")}</h2>
      <p>{t("privacy.storage.body")}</p>

      <h2>{t("privacy.children.title")}</h2>
      <p>{t("privacy.children.body")}</p>

      <h2>{t("privacy.rights.title")}</h2>
      <p>
        <Trans t={t} i18nKey="privacy.rights.body" components={{ ...todo, grievance: <a href="/grievance" /> }} />
      </p>

      <h2>{t("privacy.law.title")}</h2>
      <p>{t("privacy.law.body")}</p>

      <h2>{t("privacy.changes.title")}</h2>
      <p>{t("privacy.changes.body")}</p>
    </LegalPage>
  );
};

export default Privacy;
