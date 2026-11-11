// Call trace: a per-request list of every outbound call to NEAR AI Cloud and
// NVIDIA NRAS, plus the local checks between them, so the UI can show (live and
// as a replay) exactly which calls a triage or chat turn made.
//
// Zero retention: entries hold method, path, status, timings, byte counts and a
// one-line summary (nonce prefix, chat id, model, signer address). Never prompts,
// evidence, model output or the API key. A trace lives in memory only while its
// request runs, plus a few seconds so the browser's last poll can read it.

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();
const live = new Map(); // traceId → trace, only while the request runs (+ grace)

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function newTrace(id) {
  const trace = { id: ID_RE.test(String(id || "")) ? String(id) : null, t0: Date.now(), entries: [] };
  if (trace.id) live.set(trace.id, trace);
  return trace;
}

export const runWithTrace = (trace, fn) => als.run(trace, fn);

export function endTrace(trace) {
  if (trace.id) setTimeout(() => live.delete(trace.id), 15_000).unref?.();
}

export const getLiveTrace = (id) => live.get(String(id));

/** Snapshot for JSON: offsets relative to the request start. */
export function snapshot(trace) {
  return trace ? { startedAt: new Date(trace.t0).toISOString(), entries: trace.entries.map((e) => ({ ...e })) } : null;
}

/**
 * Start an outbound call entry. Returns a handle whose fields can be filled in:
 * end({ status, resBytes }) and .got = "short result summary".
 */
export function traceCall({ to, method, path, label, sent, reqBytes = 0 }) {
  const trace = als.getStore();
  const started = Date.now();
  const entry = {
    kind: "call", to, method, path, label, sent: sent || null, reqBytes,
    atMs: trace ? started - trace.t0 : 0, ms: null, status: "pending", resBytes: null, got: null,
  };
  trace?.entries.push(entry);
  return {
    entry,
    end({ status, resBytes = 0 }) {
      entry.ms = Date.now() - started;
      entry.status = status;
      entry.resBytes = resBytes;
    },
    set got(v) { entry.got = v == null ? null : String(v).slice(0, 160); },
  };
}

/** A step done locally on the server (masking, a check). */
export function traceLocal(label, detail, ok = true) {
  const trace = als.getStore();
  if (!trace) return;
  trace.entries.push({ kind: "local", label, detail: detail ? String(detail).slice(0, 160) : null, ok, atMs: Date.now() - trace.t0 });
}
