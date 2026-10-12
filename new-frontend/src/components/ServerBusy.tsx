import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface ServerBusyProps {
  /** Local time of the next automatic attempt. */
  retryAt: number;
  className?: string;
}

/**
 * "Busy, retrying" while the server refuses us for load. The title is the
 * live status; the per-second countdown is hidden from screen readers so it
 * is not announced every second.
 */
export const ServerBusy: React.FC<ServerBusyProps> = ({ retryAt, className }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [retryAt]);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div data-testid="server-busy" className={className}>
      <p role="status" className="font-semibold">
        {t("serverBusy.title")}
      </p>
      <p aria-hidden="true" className="text-sm opacity-80">
        {seconds > 0 ? t("serverBusy.retryIn", { seconds }) : t("serverBusy.retrying")}
      </p>
    </div>
  );
};
