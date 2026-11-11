#!/usr/bin/env node
// Emit a synthetic incident into Jaeger + Prometheus.
// Usage: npm run seed -- payment-db-down   (default: payment-db-down)
// Resets the telemetry stores first unless --keep is passed (resets make
// reseeding idempotent: no out-of-order or duplicate traces).

import { loadEnv } from "../env.js";
loadEnv();

import { execSync } from "node:child_process";
import { SCENARIOS, seedScenario } from "./scenarios.js";

const keep = process.argv.includes("--keep");
const id = process.argv.slice(2).find((a) => !a.startsWith("--")) || "payment-db-down";
if (!SCENARIOS[id]) {
  console.error(`Unknown scenario '${id}'. Available: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
if (!keep) {
  try {
    // Jaeger all-in-one keeps traces in memory: restart clears them.
    execSync("docker compose restart jaeger", { stdio: "ignore" });
    // Prometheus TSDB lives in an anonymous volume (the image declares
    // VOLUME /prometheus): recreate with --renew-anon-volumes or compose will
    // silently reuse the old TSDB and every reseed becomes "out of order".
    execSync("docker compose up -d --force-recreate --renew-anon-volumes prometheus", { stdio: "ignore" });
    await sleep(6000);
    console.log("Reset telemetry stores (jaeger restarted, prometheus recreated).");
  } catch {
    console.warn("Could not reset stores via docker — seeding on top of existing data.");
  }
}
try {
  const result = await seedScenario(id);
  console.log(
    `Seeded '${result.scenario}' (${result.severity}) — ${result.tracesPushed} traces to Jaeger, ${result.metricPushes} metric push to Prometheus. Query service '${result.suggestedService}'.`,
  );
} catch (e) {
  console.error(`Seed failed: ${e.message}`);
  console.error("Is the telemetry stack up? Try: docker compose up -d");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
