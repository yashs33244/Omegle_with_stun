import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { cn } from "@/lib/utils";

const LEGAL_LINKS = [
  { to: "/terms", label: "footer.terms" },
  { to: "/privacy", label: "footer.privacy" },
  { to: "/guidelines", label: "footer.guidelines" },
  { to: "/safety", label: "footer.safety" },
  { to: "/grievance", label: "footer.grievance" },
  { to: "/law-enforcement", label: "footer.lawEnforcement" },
  { to: "/takedown", label: "footer.takedown" },
] as const;

/**
 * Legal and safety links plus the language switcher, shown on every screen
 * outside a call. Four links per row (two rows), each a 44 px tap target.
 */
export const Footer: React.FC<{ tone?: "dark" | "light"; className?: string }> = ({ tone = "dark", className = "" }) => {
  const { t } = useTranslation();
  return (
    <footer
      data-testid="site-footer"
      className={cn(
        "text-xs px-2 pt-2 pb-[max(var(--safe-bottom),0.5rem)]",
        tone === "dark" ? "text-gray-300" : "text-gray-600",
        className,
      )}
    >
      <nav aria-label={t("footer.nav")}>
        <ul className="grid grid-cols-4 gap-x-1 max-w-lg mx-auto">
          {LEGAL_LINKS.map((l) => (
            <li key={l.to} className="flex">
              <Link
                to={l.to}
                className={cn(
                  "flex min-h-tap w-full items-center justify-center rounded-lg px-1 text-center leading-tight underline underline-offset-2",
                  tone === "dark" ? "hover:bg-white/10 hover:no-underline" : "hover:bg-black/5 hover:no-underline",
                )}
              >
                {t(l.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-1 flex justify-center">
        <LanguageSwitcher tone={tone} />
      </div>
    </footer>
  );
};
