/**
 * One Redis-backed server in its own process, for the crash test in
 * test/integration/redis.test.ts. Prints its port on stdout, then runs
 * until killed. Env: REDIS_URL, TEST_PREFIX, TEST_ADAPTER_KEY.
 */
import { createLogger } from "../../src/logger";
import { connectRedisAdapter } from "../../src/realtime/redisAdapter";
import { createServer } from "../../src/server";
import { RedisStore } from "../../src/store/RedisStore";
import { testConfig } from "../helpers";

async function main(): Promise<void> {
  const url = process.env.REDIS_URL!;
  const logger = createLogger("silent");
  const store = await RedisStore.connect(url, { prefix: process.env.TEST_PREFIX! });
  const adapter = await connectRedisAdapter(url, logger, process.env.TEST_ADAPTER_KEY!);
  const config = testConfig({ heartbeatIntervalMs: 50, instanceTtlMs: 200 });
  const server = createServer(config, { store, logger, configureIo: adapter.install });
  const port = await server.listen(0, "127.0.0.1");
  process.stdout.write(`${port}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
