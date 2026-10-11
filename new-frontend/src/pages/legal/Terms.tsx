import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { TOS_VERSION } from "@/lib/protocol";
import { LegalPage, Todo } from "./LegalPage";

const Terms = () => {
  const { t } = useTranslation("legal");
  const todo = { todo: <Todo /> };
  return (
    <LegalPage title={t("terms.title")} updated={t("terms.version", { version: TOS_VERSION })} englishAuthoritative>
      <p>
        <Trans t={t} i18nKey="terms.intro" components={todo} />
      </p>

      <h2>{t("terms.who.title")}</h2>
      <ul>
        <li>{t("terms.who.age")}</li>
        <li>{t("terms.who.regions")}</li>
        <li>{t("terms.who.banned")}</li>
      </ul>

      <h2>{t("terms.what.title")}</h2>
      <p>
        <Trans t={t} i18nKey="terms.what.body" components={{ privacy: <Link to="/privacy" /> }} />
      </p>

      <h2>{t("terms.rules.title")}</h2>
      <p>
        <Trans t={t} i18nKey="terms.rules.intro" components={{ guidelines: <Link to="/guidelines" /> }} />
      </p>
      <ul>
        <li>{t("terms.rules.minors")}</li>
        <li>{t("terms.rules.nudity")}</li>
        <li>{t("terms.rules.harassment")}</li>
        <li>{t("terms.rules.violence")}</li>
        <li>{t("terms.rules.spam")}</li>
        <li>{t("terms.rules.fake")}</li>
        <li>{t("terms.rules.unlawful")}</li>
      </ul>
      <p>{t("terms.rules.recording")}</p>

      <h2>{t("terms.tools.title")}</h2>
      <p>{t("terms.tools.body")}</p>

      <h2>{t("terms.enforcement.title")}</h2>
      <p>{t("terms.enforcement.body")}</p>

      <h2>{t("terms.appeals.title")}</h2>
      <p>
        <Trans t={t} i18nKey="terms.appeals.body" components={{ grievance: <Link to="/grievance" /> }} />
      </p>

      <h2>{t("terms.content.title")}</h2>
      <p>{t("terms.content.body")}</p>

      <h2>{t("terms.liability.title")}</h2>
      <p>
        <Trans t={t} i18nKey="terms.liability.body" components={todo} />
      </p>

      <h2>{t("terms.changes.title")}</h2>
      <p>{t("terms.changes.body")}</p>

      <h2>{t("terms.law.title")}</h2>
      <p>
        <Trans t={t} i18nKey="terms.law.body" components={todo} />
      </p>

      <h2>{t("terms.contact.title")}</h2>
      <p>
        <Trans t={t} i18nKey="terms.contact.body" components={todo} />
      </p>
    </LegalPage>
  );
};

export default Terms;
