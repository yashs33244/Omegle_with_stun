import React from "react";
import { useTranslation } from "react-i18next";

/** What the server's chat guard puts where it hid a link, handle or phone number. */
export const REDACTION_MARK = "[hidden for safety]";

/**
 * Chat text with every hidden part shown as a styled "[hidden for safety]"
 * marker. If the server hid something without leaving the marker, one is appended.
 */
export const RedactedText: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation("safety");
  const parts = text.split(REDACTION_MARK);
  const mark = (key: string) => (
    <span key={key} data-testid="redaction-mark" className="mx-0.5 rounded bg-black/30 px-1 text-xs italic opacity-80">
      {t("redaction.mark")}
    </span>
  );
  if (parts.length === 1) {
    return (
      <>
        {text}
        {mark("end")}
      </>
    );
  }
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && mark(`m${i}`)}
        </React.Fragment>
      ))}
    </>
  );
};
