/**
 * Socket origin of the backend. Set VITE_API_URL at build time; otherwise
 * dev builds talk to a local backend and production builds to the public API.
 */
export const API_URL: string =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:3004" : "https://chizzyapi.itsyash.space");
