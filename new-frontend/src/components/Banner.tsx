import { Megaphone } from "lucide-react";

/** Operator banner (flags.banner_message), from /api/config and live server:banner events. */
export const Banner: React.FC<{ message: string | null }> = ({ message }) => {
  if (!message) return null;
  return (
    <div
      role="status"
      data-testid="server-banner"
      className="sticky top-0 z-[60] bg-yellow-400 text-black text-sm font-medium px-4 py-2 flex items-center justify-center gap-2 border-b-2 border-black"
    >
      <Megaphone className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="text-center">{message}</span>
    </div>
  );
};
