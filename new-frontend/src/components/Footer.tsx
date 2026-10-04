import { Link } from "react-router-dom";

const LEGAL_LINKS = [
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
  { to: "/guidelines", label: "Guidelines" },
  { to: "/safety", label: "Safety" },
  { to: "/grievance", label: "Grievances" },
  { to: "/law-enforcement", label: "Law enforcement" },
  { to: "/takedown", label: "Report content" },
] as const;

/** Legal and safety links, shown on every screen outside a call. */
export const Footer: React.FC<{ tone?: "dark" | "light"; className?: string }> = ({ tone = "dark", className = "" }) => (
  <footer
    data-testid="site-footer"
    className={`text-xs px-4 py-3 ${tone === "dark" ? "text-gray-300" : "text-gray-600"} ${className}`}
  >
    <nav aria-label="Legal and safety">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {LEGAL_LINKS.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="underline underline-offset-2 hover:no-underline">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  </footer>
);
