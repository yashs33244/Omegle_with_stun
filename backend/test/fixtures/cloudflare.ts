/**
 * A fake Cloudflare generate-ice-servers API for tests (no real calls).
 */

/** What generate-ice-servers answers (shape from the Cloudflare docs). */
export const CF_RESPONSE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "cf-user",
      credential: "cf-pass",
    },
  ],
};

interface FakeCall {
  url: string;
  init?: RequestInit;
}

export function fakeCloudflare(opts: { status?: number; body?: unknown } = {}) {
  const calls: FakeCall[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? CF_RESPONSE), { status: opts.status ?? 200 });
  };
  return { fetch, calls };
}
