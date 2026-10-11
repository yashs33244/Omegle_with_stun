import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LegalPage, Todo } from "./LegalPage";

const Grievance = () => {
  const { t } = useTranslation("legal");
  const todo = { todo: <Todo /> };
  return (
    <LegalPage title={t("grievance.title")}>
      <p>{t("grievance.intro")}</p>

      <h2>{t("grievance.contact.title")}</h2>
      <ul data-testid="grievance-contact">
        <li>
          <Trans t={t} i18nKey="grievance.contact.officer" components={todo} />
        </li>
        <li>
          <Trans t={t} i18nKey="grievance.contact.email" components={todo} />
        </li>
        <li>
          <Trans t={t} i18nKey="grievance.contact.address" components={todo} />
        </li>
      </ul>

      <h2>{t("grievance.timelines.title")}</h2>
      <ul>
        <li>{t("grievance.timelines.acknowledge")}</li>
        <li>{t("grievance.timelines.resolve")}</li>
        <li>
          <Trans t={t} i18nKey="grievance.timelines.intimate" components={{ takedown: <Link to="/takedown" /> }} />
        </li>
      </ul>

      <h2>{t("grievance.include.title")}</h2>
      <ul>
        <li>{t("grievance.include.what")}</li>
        <li>{t("grievance.include.name")}</li>
        <li>{t("grievance.include.email")}</li>
      </ul>

      <h2>{t("grievance.unsatisfied.title")}</h2>
      <p>
        <Trans
          t={t}
          i18nKey="grievance.unsatisfied.body"
          components={{ gac: <a href="https://gac.gov.in" target="_blank" rel="noopener noreferrer" /> }}
        />
      </p>
    </LegalPage>
  );
};

export default Grievance;
