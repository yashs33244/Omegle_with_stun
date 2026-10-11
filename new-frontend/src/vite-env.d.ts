/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Socket.IO origin of the backend, e.g. https://chizzyapi.itsyash.space */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
