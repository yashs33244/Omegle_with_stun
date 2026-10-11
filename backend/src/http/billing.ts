/**
 * Billing REST routes, mounted at /api/billing (CORS comes from the session
 * router, which handles everything under /api):
 *   GET  /packs    public catalogue: packs, cost per day, Razorpay key id, enabled flags
 *   GET  /wallet   coins and active unlocks           (session)
 *   POST /orders   {packId} -> Razorpay order          (session)
 *   POST /verify   {orderId, paymentId, signature}     (session) credits the pack once
 *   POST /unlock   {feature, days}                     (session) spends coins
 *   POST /webhook  Razorpay payment.captured, raw body + X-Razorpay-Signature
 * "session" routes need `Authorization: Bearer <sessionToken>` from POST /api/session.
 * Bodies are capped at 8 KB (64 KB for the webhook) and validated with the protocol schemas.
 */
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { BILLING_STATUS, type BillingService } from "../billing/BillingService";
import type { Logger } from "../logger";
import {
  billingOrderRequestSchema,
  billingUnlockRequestSchema,
  billingVerifyRequestSchema,
  type BillingError,
  type BillingResponse,
} from "../protocol";
import type { TokenSigner } from "../session/tokens";
import { IpBuckets, jsonErrors, requestIp } from "./public";

export interface BillingApiDeps {
  billing: BillingService;
  tokens: TokenSigner;
  proxyIpHeader: string | null;
  logger: Logger;
  clock?: () => number;
}

function sendError(res: Response, error: BillingError): void {
  res.status(BILLING_STATUS[error]).json({ ok: false, error } satisfies BillingResponse<never>);
}

function send<T>(res: Response, result: BillingResponse<T>): void {
  if (result.ok) res.json(result);
  else sendError(res, result.error);
}

export function billingApiRouter(deps: BillingApiDeps): Router {
  const router = express.Router();
  const json = express.json({ limit: "8kb" });
  const clock = deps.clock ?? Date.now;
  const reads = new IpBuckets({ capacity: 30, refillPerSec: 0.5 }, clock);
  const writes = new IpBuckets({ capacity: 10, refillPerSec: 0.1 }, clock);
  const webhooks = new IpBuckets({ capacity: 60, refillPerSec: 1 }, clock);
  const ipOf = (req: Request) => requestIp(req, deps.proxyIpHeader);

  const noStore: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };

  /** Verifies the bearer session token and stores its deviceId on res.locals. */
  const session: RequestHandler = (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const payload = deps.tokens.verifySession(token, clock());
    if (!payload) {
      res.set("WWW-Authenticate", "Bearer");
      return sendError(res, "session_required");
    }
    res.locals.deviceId = payload.deviceId;
    next();
  };
  const deviceOf = (res: Response) => res.locals.deviceId as string;

  const limited =
    (buckets: IpBuckets): RequestHandler =>
    (req, res, next) => {
      if (!buckets.allow(ipOf(req))) return sendError(res, "rate_limited");
      next();
    };

  router.get("/packs", limited(reads), (_req, res) => {
    res.set("Cache-Control", "public, max-age=30").json(deps.billing.catalogue());
  });

  router.get("/wallet", noStore, limited(reads), session, async (_req, res) => {
    res.json({ ok: true, ...(await deps.billing.walletView(deviceOf(res))) });
  });

  router.post("/orders", noStore, limited(writes), session, json, async (req, res) => {
    if (!deps.billing.enabled) return sendError(res, "billing_disabled");
    const body = billingOrderRequestSchema.safeParse(req.body);
    if (!body.success) return sendError(res, "invalid");
    send(res, await deps.billing.createOrder(deviceOf(res), body.data.packId));
  });

  router.post("/verify", noStore, limited(writes), session, json, async (req, res) => {
    if (!deps.billing.enabled) return sendError(res, "billing_disabled");
    const body = billingVerifyRequestSchema.safeParse(req.body);
    if (!body.success) return sendError(res, "invalid");
    const { orderId, paymentId, signature } = body.data;
    send(res, await deps.billing.verifyCheckout(deviceOf(res), orderId, paymentId, signature));
  });

  router.post("/unlock", noStore, limited(writes), session, json, async (req, res) => {
    const body = billingUnlockRequestSchema.safeParse(req.body);
    if (!body.success) return sendError(res, "invalid");
    send(res, await deps.billing.unlock(deviceOf(res), body.data.feature, body.data.days));
  });

  // Razorpay posts JSON; the MAC covers the raw bytes, so no JSON parser may run first.
  router.post("/webhook", noStore, limited(webhooks), express.raw({ type: () => true, limit: "64kb" }), async (req, res) => {
    if (!deps.billing.webhookEnabled) return sendError(res, "billing_disabled");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const outcome = await deps.billing.handleWebhook(raw, req.get("x-razorpay-signature"));
    switch (outcome) {
      case "credited":
      case "ignored":
        return void res.json({ ok: true, outcome });
      case "bad_signature":
        deps.logger.warn({ ip: ipOf(req) }, "razorpay webhook with a bad signature");
        return sendError(res, "bad_signature");
      case "invalid":
        return sendError(res, "invalid");
      case "order_not_found":
        return sendError(res, "order_not_found");
      case "payment_mismatch":
        return sendError(res, "payment_mismatch");
    }
  });

  router.use((_req, res) => {
    res.status(404).json({ ok: false, error: "not_found" });
  });
  router.use(jsonErrors(deps.logger));
  return router;
}
