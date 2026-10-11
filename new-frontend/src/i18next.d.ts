import "i18next";
import type { resources } from "@/lib/i18n";

// Keys are checked against the English resources, so a typo fails typecheck.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: (typeof resources)["en"];
    returnNull: false;
  }
}
