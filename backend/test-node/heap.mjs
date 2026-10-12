// Runs the BUILT shedding heap budget (dist/shed/LoadMonitor.js) under Node
// with the NODE_OPTIONS the deployments set (render.yaml, docker-compose.yml)
// and proves the budget follows --max-old-space-size, not the host's memory.
// Run with: bun run build && bun run test:node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;

test("NODE_OPTIONS=--max-old-space-size=320 bounds the shedding heap budget", () => {
  const script = `
    const { heapLimitBytes } = require(${JSON.stringify(join(root, "dist/shed/LoadMonitor.js"))});
    const v8 = require("node:v8");
    process.stdout.write(JSON.stringify({
      budget: heapLimitBytes(undefined),
      v8Limit: v8.getHeapStatistics().heap_size_limit,
      container: process.constrainedMemory?.() ?? 0,
    }));
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=320" },
    encoding: "utf8",
  });
  const { budget, v8Limit, container } = JSON.parse(out);
  // heap_size_limit is old space plus young generation: 320 MB and a bit.
  assert.ok(v8Limit > 320 * MB && v8Limit < 400 * MB, `heap_size_limit ${v8Limit / MB} MB`);
  assert.ok(budget > 0 && budget <= v8Limit, `budget ${budget / MB} MB`);
  if (container === 0) assert.equal(budget, v8Limit);
});
