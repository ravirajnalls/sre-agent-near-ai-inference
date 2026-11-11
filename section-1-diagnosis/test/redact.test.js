// Feeds known FAKE secrets through the server-side redactor (redact.js) and checks
// that none survive. The collector applies the same patterns; see README for the
// pipeline check against a running collector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactEvidence } from "../redact.js";

const SECRETS = {
  connection_string: "postgres://auth_rw:Winter2026!@auth-db.prod:5432/auth",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0LTQ0MTIifQ.ZmFrZS1zaWduYXR1cmUtZm9yLWRlbW8",
  bearer_token: "Bearer abcdEFGH1234ijklMNOP",
  api_key: "sk_live_51FAKEfakeFAKEfake00000000",
  credential: "AUTH_DB_PASSWORD=Winter2026!",
  email: "jane.doe@example.com",
};

test("every planted secret is masked, by kind, with no value left", () => {
  const evidence = { traces: [{ spans: Object.values(SECRETS).map((s) => ({ exception: { message: `boom ${s} end` } })) }] };
  const { masked, manifest } = redactEvidence(evidence);
  const out = JSON.stringify(masked);
  for (const [kind, value] of Object.entries(SECRETS)) {
    assert.ok(!out.includes(value), `${kind} leaked`);
    assert.ok(out.includes(`[REDACTED:${kind}]`), `${kind} placeholder missing`);
    assert.equal(manifest.server[kind], 1, `${kind} not counted`);
  }
  assert.ok(!JSON.stringify(manifest).includes("Winter2026"), "manifest must never hold values");
});

test("collector placeholders are counted, not re-masked", () => {
  const { masked, manifest } = redactEvidence({ m: "user [REDACTED:email] failed" });
  assert.equal(masked.m, "user [REDACTED:email] failed");
  assert.deepEqual(manifest.collector, { email: 1 });
  assert.equal(manifest.totals.server, 0);
});

test("ordinary incident text is left alone", () => {
  const msg = "connect timed out calling payments:5432 after 3 attempts; pool exhausted: maxTotal=50";
  assert.equal(redactEvidence({ msg }).masked.msg, msg);
});
