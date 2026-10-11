import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

const LEGAL_LINKS = [
  { to: "/terms", label: "footer.terms" },
  { to: "/privacy", label: "footer.privacy" },
  { to: "/guidelines", label: "footer.guidelines" },
  { to: "/safety", label: "footer.safety" },
  { to: "/grievance", label: "footer.grievance" },
  { to: "/law-enforcement", label: "footer.lawEnforcement" },
  { to: "/takedown", label: "footer.takedown" },
] as const;

/** Legal and safety links plus the language switcher, shown on every screen outside a call. */
export const Footer: React.FC<{ tone?: "dark" | "light"; className?: string }> = ({ tone = "dark", className = "" }) => {
  const { t } = useTranslation();
  return (
    <footer
      data-testid="site-footer"
      className={`text-xs px-4 py-3 ${tone === "dark" ? "text-gray-300" : "text-gray-600"} ${className}`}
    >
      <nav aria-label={t("footer.nav")}>
        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          {LEGAL_LINKS.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className="underline underline-offset-2 hover:no-underline">
                {t(l.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex justify-center mt-2">
        <LanguageSwitcher tone={tone} />
      </div>
    </footer>
  );
};
