import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LegalPage, Todo } from "./LegalPage";

const LawEnforcement = () => {
  const { t } = useTranslation("legal");
  const todo = { todo: <Todo /> };
  return (
    <LegalPage title={t("lawEnforcement.title")} englishAuthoritative>
      <p>
        <Trans t={t} i18nKey="lawEnforcement.intro" components={{ safety: <Link to="/safety" /> }} />
      </p>

      <h2>{t("lawEnforcement.how.title")}</h2>
      <ul>
        <li>
          <Trans t={t} i18nKey="lawEnforcement.how.email" components={todo} />
        </li>
        <li>{t("lawEnforcement.how.official")}</li>
        <li>{t("lawEnforcement.how.mlat")}</li>
      </ul>

      <h2>{t("lawEnforcement.emergencies.title")}</h2>
      <p>
        <Trans t={t} i18nKey="lawEnforcement.emergencies.body" components={todo} />
      </p>

      <h2>{t("lawEnforcement.data.title")}</h2>
      <p>
        <Trans t={t} i18nKey="lawEnforcement.data.intro" components={{ privacy: <Link to="/privacy" /> }} />
      </p>
      <ul>
        <li>{t("lawEnforcement.data.logs")}</li>
        <li>{t("lawEnforcement.data.matches")}</li>
        <li>{t("lawEnforcement.data.reports")}</li>
        <li>{t("lawEnforcement.data.bans")}</li>
      </ul>

      <h2>{t("lawEnforcement.preservation.title")}</h2>
      <p>{t("lawEnforcement.preservation.body")}</p>

      <h2>{t("lawEnforcement.csam.title")}</h2>
      <p>{t("lawEnforcement.csam.body")}</p>
    </LegalPage>
  );
};

export default LawEnforcement;
