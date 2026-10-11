import React from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatSpan } from "./adminShared";

/** Countdown to an SLA deadline: red once overdue, amber in the last 2 hours. */
export const SlaChip: React.FC<{ label: string; dueAt: number; now: number }> = ({ label, dueAt, now }) => {
  const { t } = useTranslation("admin");
  const left = dueAt - now;
  const overdue = left <= 0;
  const tone = overdue
    ? "bg-red-600 text-white border-red-700"
    : left < 2 * 60 * 60 * 1000
      ? "bg-amber-200 text-amber-900 border-amber-400"
      : "bg-gray-100 text-gray-800 border-gray-300";
  return (
    <span
      data-testid="sla-chip"
      data-overdue={overdue ? "true" : "false"}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}: {overdue ? t("sla.overdue", { span: formatSpan(left) }) : t("sla.left", { span: formatSpan(left) })}
    </span>
  );
};

export const Btn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "danger" | "primary" }> = ({
  tone = "default",
  className = "",
  ...props
}) => {
  const tones = {
    default: "border-gray-300 bg-white text-gray-900 hover:bg-gray-100",
    primary: "border-gray-900 bg-gray-900 text-white hover:bg-gray-700",
    danger: "border-red-700 bg-red-600 text-white hover:bg-red-500",
  };
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`}
    />
  );
};

export const Notice: React.FC<{ tone: "ok" | "error"; children: React.ReactNode }> = ({ tone, children }) => (
  <p
    role={tone === "error" ? "alert" : "status"}
    className={`rounded-md px-3 py-2 text-sm ${tone === "error" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-800"}`}
  >
    {children}
  </p>
);

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Radix alert dialog: focus is trapped and Escape cancels. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ open, title, description, confirmLabel, onConfirm, onCancel }) => {
  const { t } = useTranslation("admin");
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-gray-700">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t("ui.cancel")}</AlertDialogCancel>
          <Btn tone="danger" onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
