import React from "react";

const link = "underline underline-offset-2 hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400 rounded";

/**
 * Helplines shown on the first-use safety card and on /safety.
 * Numbers: India 1930 (National Cyber Crime Helpline) and 1098 (Childline);
 * US 988 (Suicide and Crisis Lifeline) and the NCMEC CyberTipline.
 */
export const SafetyHelplines: React.FC<{ className?: string }> = ({ className = "" }) => (
  <ul className={`space-y-2 text-sm ${className}`} data-testid="safety-helplines">
    <li>
      <span className="font-semibold">India:</span> cyber crime helpline{" "}
      <a className={link} href="tel:1930">
        1930
      </a>{" "}
      (or cybercrime.gov.in), Childline{" "}
      <a className={link} href="tel:1098">
        1098
      </a>
    </li>
    <li>
      <span className="font-semibold">United States:</span> call or text{" "}
      <a className={link} href="tel:988">
        988
      </a>{" "}
      if you are in crisis. Report the sexual exploitation of a child to the NCMEC CyberTipline at{" "}
      <a className={link} href="https://report.cybertip.org" target="_blank" rel="noopener noreferrer">
        report.cybertip.org
      </a>{" "}
      or 1-800-843-5678.
    </li>
    <li>
      <span className="font-semibold">Anywhere:</span> if you are in danger right now, call your local emergency number.
    </li>
  </ul>
);

/** Copy for /safety: what the watermark over the partner's video is, and what it is not. */
export const WatermarkExplainer: React.FC<{ className?: string }> = ({ className = "" }) => (
  <div className={`space-y-2 text-sm ${className}`} data-testid="watermark-explainer">
    <h3 className="font-semibold">The code over the video</h3>
    <p>
      During a call, a faint code (like &quot;chizzy 7K3P-9QX2&quot;) shows over the other person&apos;s video. It is made
      from that call&apos;s id, not from anything about you. If a recording of a call turns up later, the code helps us
      find which call it came from when you report it.
    </p>
    <p>
      It discourages recording, but it does not stop it. Anyone can record their screen or film it with another
      device, so only show on camera what you would be fine with a stranger keeping.
    </p>
  </div>
);
