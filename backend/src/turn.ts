/**
 * ICE server list handed to clients in the session:hello ack.
 *
 * TURN credentials follow the coturn REST API (`use-auth-secret`):
 *   username   = "<unix expiry seconds>:<deviceId>"
 *   credential = base64(HMAC-SHA1(TURN_SECRET, username))
 * so credentials expire on their own and the secret never leaves the server.
 */
import { createHmac } from "node:crypto";
import type { Config } from "./config";
import type { IceServer } from "./protocol";

export function turnCredential(secret: string, username: string): string {
  return createHmac("sha1", secret).update(username).digest("base64");
}

export function buildIceServers(
  config: Pick<Config, "stunUrls" | "turnUrls" | "turnSecret" | "turnUsername" | "turnCredential" | "turnTtlSeconds">,
  deviceId: string,
  nowMs: number = Date.now(),
): IceServer[] {
  const servers: IceServer[] = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length === 0) return servers;

  if (config.turnSecret) {
    const expiry = Math.floor(nowMs / 1000) + config.turnTtlSeconds;
    const username = `${expiry}:${deviceId}`;
    servers.push({ urls: config.turnUrls, username, credential: turnCredential(config.turnSecret, username) });
  } else if (config.turnUsername && config.turnCredential) {
    servers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnCredential });
  }
  return servers;
}
