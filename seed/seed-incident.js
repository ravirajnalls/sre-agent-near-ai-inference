#!/usr/bin/env node
// Emit a synthetic incident into Jaeger + Prometheus.
// Usage: npm run seed -- payment-db-down   (default: payment-db-down)

import { loadEnv } from "../env.js";
loadEnv();

import { SCENARIOS, seedScenario } from "./scenarios.js";

const id = process.argv[2] || "payment-db-down";
if (!SCENARIOS[id]) {
  console.error(`Unknown scenario '${id}'. Available: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
try {
  const result = await seedScenario(id);
  console.log(
    `Seeded '${result.scenario}' (${result.severity}) — ${result.tracesPushed} traces to Jaeger, ${result.metricPushes} metric pushes to Prometheus. Query service '${result.suggestedService}'.`,
  );
} catch (e) {
  console.error(`Seed failed: ${e.message}`);
  console.error("Is the telemetry stack up? Try: docker compose up -d");
  process.exit(1);
}
