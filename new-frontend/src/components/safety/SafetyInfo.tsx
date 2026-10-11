import React from "react";
import { Trans, useTranslation } from "react-i18next";

const link = "underline underline-offset-2 hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400 rounded";

/**
 * Helplines shown on the first-use safety card and on /safety.
 * Numbers: India 1930 (National Cyber Crime Helpline) and 1098 (Childline);
 * US 988 (Suicide and Crisis Lifeline) and the NCMEC CyberTipline.
 */
export const SafetyHelplines: React.FC<{ className?: string }> = ({ className = "" }) => {
  const { t } = useTranslation("safety");
  return (
    <ul className={`space-y-2 text-sm ${className}`} data-testid="safety-helplines">
      <li>
        <Trans
          t={t}
          i18nKey="helplines.india"
          components={{
            b: <span className="font-semibold" />,
            tel1930: <a className={link} href="tel:1930" />,
            tel1098: <a className={link} href="tel:1098" />,
          }}
        />
      </li>
      <li>
        <Trans
          t={t}
          i18nKey="helplines.us"
          components={{
            b: <span className="font-semibold" />,
            tel988: <a className={link} href="tel:988" />,
            cybertip: <a className={link} href="https://report.cybertip.org" target="_blank" rel="noopener noreferrer" />,
          }}
        />
      </li>
      <li>
        <Trans t={t} i18nKey="helplines.anywhere" components={{ b: <span className="font-semibold" /> }} />
      </li>
    </ul>
  );
};

/** Copy for /safety: what the watermark over the partner's video is, and what it is not. */
export const WatermarkExplainer: React.FC<{ className?: string }> = ({ className = "" }) => {
  const { t } = useTranslation("safety");
  return (
    <div className={`space-y-2 text-sm ${className}`} data-testid="watermark-explainer">
      <h3 className="font-semibold">{t("watermarkExplainer.title")}</h3>
      <p>{t("watermarkExplainer.p1")}</p>
      <p>{t("watermarkExplainer.p2")}</p>
    </div>
  );
};
