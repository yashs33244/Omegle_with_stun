/**
 * Socket.IO handshake gate: every connection must carry a valid session
 * token (auth.sessionToken) from POST /api/session, and must not come from a
 * blocked country, judged both by the country in the token and by the
 * current edge header. Rejections reach the client as connect_error with
 * `data.code` "session_required" or "region_blocked".
 */
import type { Socket } from "socket.io";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { HANDSHAKE_REJECT_CODES } from "./constants";
import { isCountryBlocked, requestCountry, requestIp } from "./geo";
import type { MatchCaps } from "./limits";
import type { TokenSigner } from "./tokens";

export interface HandshakeSession {
  deviceId: string;
  country: string | null;
  /** Epoch ms when the session token expires; the socket is disconnected then (realtime/socket.ts). */
  expiresAt: number;
}

/** The verified session of a socket, or undefined when the gate is off. */
export function handshakeSession(socket: Pick<Socket, "data">): HandshakeSession | undefined {
  const data = socket.data as { session?: HandshakeSession } | undefined;
  return data?.session;
}

export type RejectCode = (typeof HANDSHAKE_REJECT_CODES)[number];

function reject(code: RejectCode): Error & { data: { code: RejectCode } } {
  return Object.assign(new Error(code), { data: { code } });
}

export interface HandshakeDeps {
  tokens: TokenSigner;
  flags: FlagsReader;
  trustCloudflare: boolean;
  proxyIpHeader: string | null;
  caps: MatchCaps;
  logger: Logger;
  onReject?: (code: RejectCode) => void;
  now?: () => number;
}

export function sessionHandshake(deps: HandshakeDeps) {
  const now = deps.now ?? Date.now;
  return (socket: Socket, next: (err?: Error) => void): void => {
    const fail = (code: RejectCode) => {
      deps.onReject?.(code);
      next(reject(code));
    };
    const auth = socket.handshake.auth as { sessionToken?: unknown } | undefined;
    const token = deps.tokens.verifySession(auth?.sessionToken, now());
    if (!token) return fail("session_required");
    const flags = deps.flags.current();
    const edgeCountry = requestCountry(socket.handshake.headers, deps.trustCloudflare);
    if (isCountryBlocked(token.country, flags) || isCountryBlocked(edgeCountry, flags)) return fail("region_blocked");

    const session: HandshakeSession = { deviceId: token.deviceId, country: edgeCountry ?? token.country, expiresAt: token.exp };
    (socket.data as { session?: HandshakeSession }).session = session;
    const ip = requestIp(socket.handshake.headers, socket.handshake.address, deps.proxyIpHeader);
    deps.caps.bindIp(token.deviceId, ip).then(
      () => next(),
      (err: unknown) => {
        // The cap is a backstop; a store hiccup must not lock everyone out.
        deps.logger.warn({ err }, "could not bind device to ip for match caps");
        next();
      },
    );
  };
}
