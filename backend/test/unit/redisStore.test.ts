import { randomUUID } from "node:crypto";
import { RedisStore } from "../../src/store/RedisStore";
import { runStoreContract } from "../storeContract";

const url = process.env.REDIS_URL;

runStoreContract("RedisStore", () => RedisStore.connect(url!, { prefix: `test:${randomUUID()}:` }), { skip: !url });
