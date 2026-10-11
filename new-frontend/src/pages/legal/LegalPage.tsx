import { useEffect } from "react";
import { Link } from "react-router-dom";
import { FileWarning } from "lucide-react";
import { Footer } from "@/components/Footer";

/** Placeholder the lawyer or owner must fill in before launch. */
export const Todo: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <mark className="bg-yellow-200 px-1 rounded" data-testid="legal-todo">
    [TODO: {children}]
  </mark>
);

const prose =
  "[&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-8 [&_h2]:mb-2 [&_h3]:font-bold [&_h3]:mt-4 [&_p]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_li]:my-1 [&_a]:underline [&_table]:w-full [&_table]:my-4 [&_table]:text-sm [&_th]:text-left [&_th]:border-b-2 [&_th]:border-black [&_th]:py-1 [&_th]:pr-2 [&_td]:border-b [&_td]:border-gray-300 [&_td]:py-1 [&_td]:pr-2 [&_td]:align-top";

export interface LegalPageProps {
  title: string;
  /** Shown under the title, e.g. "Last updated: draft of October 2026". */
  updated?: string;
  children: React.ReactNode;
}

/** Shell for legal and safety pages. Every one is a DRAFT until the lawyer signs it off. */
export const LegalPage: React.FC<LegalPageProps> = ({ title, updated = "Draft of October 2026", children }) => {
  // The document title comes from RouteMeta (src/lib/seo.ts).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [title]);

  return (
    <div className="min-h-screen bg-gray-100 text-black flex flex-col">
      <header className="bg-gray-900 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold text-yellow-400">
            Chizzy
          </Link>
          <Link to="/" className="text-sm text-gray-200 underline">
            Back to Chizzy
          </Link>
        </div>
      </header>
      <main className="flex-1 px-4 py-8">
        <article className="max-w-3xl mx-auto bg-white border-2 border-black rounded-lg p-6 md:p-10 shadow-md">
          <div
            role="note"
            data-testid="legal-draft-notice"
            className="flex items-start gap-3 bg-yellow-100 border-2 border-yellow-500 rounded p-3 mb-6 text-sm"
          >
            <FileWarning className="w-5 h-5 shrink-0 text-yellow-700" aria-hidden="true" />
            <p>
              <strong>Draft, pending legal review.</strong> This page is a template. It is not final and may change
              before Chizzy launches publicly.
            </p>
          </div>
          <h1 className="text-3xl font-bold">{title}</h1>
          <p className="text-sm text-gray-600 mt-1">{updated}</p>
          <div className={prose}>{children}</div>
        </article>
      </main>
      <Footer tone="light" />
    </div>
  );
};
