import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LegalPage } from "./LegalPage";

const Guidelines = () => {
  const { t } = useTranslation("legal");
  return (
    <LegalPage title={t("guidelines.title")}>
      <p>{t("guidelines.intro")}</p>

      <h2>{t("guidelines.rules.title")}</h2>
      <ol>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.adults" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.clothes" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.minors" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.respect" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.violence" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.spam" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.real" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.privacy" />
        </li>
        <li>
          <Trans t={t} i18nKey="guidelines.rules.law" />
        </li>
      </ol>

      <h2>{t("guidelines.enforcement.title")}</h2>
      <p>{t("guidelines.enforcement.intro")}</p>
      <ol>
        <li>{t("guidelines.enforcement.warning")}</li>
        <li>{t("guidelines.enforcement.pause10m")}</li>
        <li>{t("guidelines.enforcement.pause24h")}</li>
        <li>{t("guidelines.enforcement.pause7d")}</li>
        <li>{t("guidelines.enforcement.ban")}</li>
      </ol>
      <p>{t("guidelines.enforcement.outro")}</p>

      <h2>{t("guidelines.staySafe.title")}</h2>
      <ul>
        <li>{t("guidelines.staySafe.personal")}</li>
        <li>
          <Trans t={t} i18nKey="guidelines.staySafe.sextortion" components={{ safety: <Link to="/safety" /> }} />
        </li>
        <li>{t("guidelines.staySafe.next")}</li>
      </ul>
    </LegalPage>
  );
};

export default Guidelines;
