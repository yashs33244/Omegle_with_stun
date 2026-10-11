/**
 * Builds the billing feature from config and the server's shared pieces:
 * wallet store (memory or Redis, over the MatchStore coin balance), the
 * Razorpay gateway (real, fake for tests, or none) and the service.
 */
import type Redis from "ioredis";
import type { Config } from "../config";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { WalletView } from "../protocol";
import type { MatchStore } from "../store/MatchStore";
import { BillingService } from "./BillingService";
import { FakeRazorpay, RazorpayClient, type FetchFn, type RazorpayGateway } from "./razorpay";
import { MemoryWalletStore, RedisWalletStore, type WalletStore } from "./WalletStore";

export { BillingService, BILLING_STATUS } from "./BillingService";
export type { WalletStore } from "./WalletStore";
export { FAKE_SIGNATURE } from "./razorpay";

export interface BillingFeatureDeps {
  config: Config;
  flags: FlagsReader;
  store: MatchStore;
  logger: Logger;
  /** Shared Redis client in Redis mode; memory otherwise. */
  redis?: Redis;
  /** Outbound HTTP to Razorpay; tests inject a fake. */
  fetch?: FetchFn;
  /** Overrides for tests. */
  walletStore?: WalletStore;
  gateway?: RazorpayGateway | null;
  notify?: (deviceId: string, view: WalletView) => void | Promise<void>;
  now?: () => number;
}

export function createBilling(deps: BillingFeatureDeps): BillingService {
  const { config, logger } = deps;
  const store = deps.walletStore ?? (deps.redis ? new RedisWalletStore(deps.store, deps.redis) : new MemoryWalletStore(deps.store));
  let gateway: RazorpayGateway | null;
  if (deps.gateway !== undefined) gateway = deps.gateway;
  else if (config.razorpayFake) {
    logger.warn("BILLING WARNING: RAZORPAY_FAKE is on; payments are not real");
    gateway = new FakeRazorpay();
  } else if (config.razorpayKeyId && config.razorpayKeySecret) {
    gateway = new RazorpayClient(config.razorpayKeyId, config.razorpayKeySecret, deps.fetch);
  } else {
    logger.info("billing disabled: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set");
    gateway = null;
  }
  if (gateway && !config.razorpayWebhookSecret && !config.razorpayFake) {
    logger.warn("BILLING WARNING: RAZORPAY_WEBHOOK_SECRET is not set; only the Checkout success path credits coins");
  }
  return new BillingService({
    store,
    flags: deps.flags,
    logger,
    initialCoins: config.initialCoins,
    gateway,
    webhookSecret: config.razorpayFake ? (config.razorpayWebhookSecret ?? "fake-webhook-secret") : config.razorpayWebhookSecret,
    notify: deps.notify,
    now: deps.now,
  });
}
