import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LegalPage } from "./LegalPage";

const external = (href: string) => <a href={href} target="_blank" rel="noopener noreferrer" />;

const Safety = () => {
  const { t } = useTranslation("legal");
  return (
    <LegalPage title={t("safety.title")}>
      <h2>{t("safety.danger.title")}</h2>
      <p>
        <Trans t={t} i18nKey="safety.danger.body" />
      </p>

      <h2>{t("safety.helplines.title")}</h2>
      <h3>{t("safety.helplines.india")}</h3>
      <ul data-testid="helplines-india">
        <li>
          <Trans t={t} i18nKey="safety.helplines.cyberCrime" components={{ cybercrime: external("https://cybercrime.gov.in") }} />
        </li>
        <li>
          <Trans t={t} i18nKey="safety.helplines.childline" />
        </li>
      </ul>
      <h3>{t("safety.helplines.us")}</h3>
      <ul data-testid="helplines-us">
        <li>
          <Trans t={t} i18nKey="safety.helplines.lifeline" />
        </li>
        <li>
          <Trans t={t} i18nKey="safety.helplines.cyberTipline" components={{ cybertip: external("https://report.cybertip.org") }} />
        </li>
      </ul>
      <h3>{t("safety.helplines.elsewhere")}</h3>
      <p>{t("safety.helplines.elsewhereBody")}</p>

      <h2>{t("safety.sextortion.title")}</h2>
      <ul>
        <li>{t("safety.sextortion.doNotPay")}</li>
        <li>{t("safety.sextortion.stopReplying")}</li>
        <li>{t("safety.sextortion.report")}</li>
        <li>
          <Trans
            t={t}
            i18nKey="safety.sextortion.takeItDown"
            components={{ takeItDown: external("https://takeitdown.ncmec.org"), stopNcii: external("https://stopncii.org") }}
          />
        </li>
        <li>
          <Trans t={t} i18nKey="safety.sextortion.takedown" components={{ takedown: <Link to="/takedown" /> }} />
        </li>
      </ul>

      <h2>{t("safety.measures.title")}</h2>
      <ul>
        <li>{t("safety.measures.ageCheck")}</li>
        <li>{t("safety.measures.botCheck")}</li>
        <li>{t("safety.measures.blur")}</li>
        <li>{t("safety.measures.filters")}</li>
        <li>{t("safety.measures.reporting")}</li>
      </ul>
      <p>{t("safety.measures.outro")}</p>
    </LegalPage>
  );
};

export default Safety;
