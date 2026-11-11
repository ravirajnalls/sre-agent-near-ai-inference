// The fixed action list is a security boundary: anything off-list or malformed is rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAction, ACTION_TYPES } from "../prompt.js";

test("the list is exactly the design's six types", () => {
  assert.deepEqual(ACTION_TYPES, ["restart_rollout", "rollback_rollout", "set_image", "set_resources", "scale", "none"]);
});

test("well-formed actions pass and are normalised", () => {
  const r = validateAction({ type: "scale", namespace: "demo-apps", target: "oom-worker", params: { replicas: 2, extra: "x" }, note: "y" });
  assert.equal(r.status, "valid");
  assert.deepEqual(r.action, { type: "scale", namespace: "demo-apps", target: "oom-worker", params: { replicas: 2 } });
});

test("off-list types are rejected", () => {
  for (const type of ["kubectl_exec", "delete_namespace", "RESTART_ROLLOUT", "", undefined]) {
    assert.equal(validateAction({ type, namespace: "demo-apps", target: "x" }).status, "rejected");
  }
  assert.equal(validateAction(null).status, "rejected");
});

test("injection-shaped params are rejected", () => {
  const bad = [
    { type: "set_image", namespace: "demo-apps", target: "web", params: { container: "web", image: "nginx:1.27; rm -rf /" } },
    { type: "restart_rollout", namespace: "demo-apps --all", target: "web" },
    { type: "scale", namespace: "demo-apps", target: "web", params: { replicas: 999 } },
    { type: "set_resources", namespace: "demo-apps", target: "web", params: { container: "web", limits: { memory: "$(id)" } } },
  ];
  for (const a of bad) assert.equal(validateAction(a).status, "rejected", JSON.stringify(a));
});
