import { describe, expect, test } from "bun:test";
import { buildIceServers, turnCredential } from "../../src/turn";

const base = {
  stunUrls: ["stun:stun.example.com:3478"],
  turnUrls: [] as string[],
  turnTtlSeconds: 43200,
};

describe("turnCredential", () => {
  test("matches a known coturn REST vector", () => {
    // printf '%s' "1700043200:6f1c..." | openssl dgst -sha1 -hmac "s3cret" -binary | base64
    expect(turnCredential("s3cret", "1700043200:6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11")).toBe(
      "02NTbU6xMq+jx6qEQZfp7G3Efd8=",
    );
  });
});

describe("buildIceServers", () => {
  test("STUN only when no TURN is configured", () => {
    expect(buildIceServers(base, "dev")).toEqual([{ urls: ["stun:stun.example.com:3478"] }]);
  });

  test("ephemeral TURN credentials from the shared secret", () => {
    const servers = buildIceServers(
      { ...base, turnUrls: ["turn:turn.example.com:3478"], turnSecret: "s3cret" },
      "6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11",
      1_700_000_000_000,
    );
    expect(servers[1]).toEqual({
      urls: ["turn:turn.example.com:3478"],
      username: "1700043200:6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11",
      credential: "02NTbU6xMq+jx6qEQZfp7G3Efd8=",
    });
  });

  test("static TURN credentials", () => {
    const servers = buildIceServers(
      { ...base, turnUrls: ["turn:t:3478"], turnUsername: "u", turnCredential: "p" },
      "dev",
    );
    expect(servers[1]).toEqual({ urls: ["turn:t:3478"], username: "u", credential: "p" });
  });
});
