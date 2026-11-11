// Attestation + reply-signature checks for NEAR AI Cloud (design steps 4 and 5).
//
// Step 4 — before ANY evidence is sent: fetch the attestation report with a fresh
// 32-byte nonce and check that
//   (a) the report echoes our nonce,
//   (b) the TDX quote's report_data binds the model's signing key and our nonce
//       (report_data[0..32] = signing address, zero-padded; [32..64] = nonce),
//   (c) NVIDIA's attestation service (NRAS) accepts the GPU evidence for our nonce.
// Step 5 — after every reply: fetch the reply signature and check that
//   (d) the signed text carries sha256(our exact request body) and sha256(the response text),
//   (e) the EIP-191 signature recovers to the claimed signing address,
//   (f) that address is one the attestation in step 4 vouched for.
//
// Mirrors the official verifier (github.com/nearai/nearai-cloud-verifier).
// Stated limit: the Intel TDX quote's own signature chain (DCAP collateral) is NOT
// checked in-app; run the official verifier for that. The panel says so.

import { randomBytes, createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { fetchAttestationReport, fetchReplySignature, MODEL } from "./near-client.js";

const NRAS_URL = () => process.env.NRAS_URL || "https://nras.attestation.nvidia.com/v3/attest/gpu";

/** strict (default): any failed check stops the triage. warn: show failures, continue. off: local mode, no checks. */
export function attestationMode() {
  const m = String(process.env.ATTESTATION_MODE || "strict").toLowerCase();
  return ["strict", "warn", "off"].includes(m) ? m : "strict";
}

export class VerificationError extends Error {
  constructor(message, verification) {
    super(message);
    this.verification = verification;
  }
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const strip0x = (s) => String(s || "").replace(/^0x/i, "").toLowerCase();
const check = (name, status, detail) => ({ name, status, detail });

// --- step 4: attestation ----------------------------------------------------

export async function verifyAttestation() {
  const mode = attestationMode();
  if (mode === "off") {
    return {
      mode,
      verified: false,
      nonce: null,
      checks: [check("attestation", "skip", "ATTESTATION_MODE=off — local mode, no attestation was checked")],
      attestedAddresses: [],
    };
  }

  const nonce = randomBytes(32).toString("hex");
  const checks = [];
  let report;
  let reportText;
  try {
    ({ json: report, text: reportText } = await fetchAttestationReport(nonce));
    checks.push(check("report fetched", "pass", `fresh nonce ${nonce.slice(0, 16)}…`));
  } catch (e) {
    checks.push(check("report fetched", "fail", String(e.message).slice(0, 160)));
    return finish({ mode, nonce, checks, attestedAddresses: [] });
  }

  const model = MODEL();
  let entries = Array.isArray(report.model_attestations) ? report.model_attestations : [];
  const named = entries.filter((m) => m.model_name === model);
  if (named.length) entries = named;
  if (!entries.length) {
    checks.push(check("model attestation present", "fail", `no model_attestations entry for ${model}`));
    return finish({ mode, nonce, checks, attestedAddresses: [], reportSha256: sha256hex(reportText) });
  }

  // Each entry is one TEE node that may serve the model. Check them all; a node
  // counts as attested only if every check passes for it.
  const perNode = await Promise.all(entries.slice(0, 8).map((m) => checkNode(m, nonce)));
  const good = perNode.filter((n) => n.ok);
  const attestedAddresses = good.map((n) => n.address);

  checks.push(summarise("nonce echoed in report", perNode, "nonceEchoed"));
  checks.push(summarise("TDX report_data binds signing key + nonce", perNode, "reportData"));
  checks.push(summarise("NVIDIA GPU attestation (NRAS)", perNode, "gpu"));
  checks.push(
    check(
      "Intel TDX quote signature (DCAP)",
      "skip",
      "not checked in-app — run github.com/nearai/nearai-cloud-verifier for the full chain",
    ),
  );

  return finish({ mode, nonce, checks, attestedAddresses, reportSha256: sha256hex(reportText) });
}

async function checkNode(m, nonce) {
  const address = strip0x(m.signing_address);
  const out = { address: address ? `0x${address}` : null, ok: false };

  out.nonceEchoed = strip0x(m.request_nonce) === nonce
    ? { ok: true }
    : { ok: false, why: "request_nonce does not match our nonce" };

  try {
    const rd = tdxReportData(m.intel_quote);
    const addrBytes = Buffer.alloc(32);
    Buffer.from(address, "hex").copy(addrBytes);
    const keyOk = rd.subarray(0, 32).equals(addrBytes);
    const nonceOk = rd.subarray(32, 64).equals(Buffer.from(nonce, "hex"));
    out.reportData = keyOk && nonceOk
      ? { ok: true }
      : { ok: false, why: !keyOk ? "report_data[0..32] ≠ signing address" : "report_data[32..64] ≠ nonce" };
  } catch (e) {
    out.reportData = { ok: false, why: String(e.message).slice(0, 120) };
  }

  out.gpu = await checkGpu(m.nvidia_payload, nonce);
  out.ok = Boolean(address) && out.nonceEchoed.ok && out.reportData.ok && out.gpu.ok;
  return out;
}

/** report_data (64 bytes) from a TDX quote (v4 or v5), hex encoded. */
export function tdxReportData(quoteHex) {
  const q = Buffer.from(strip0x(quoteHex), "hex");
  if (q.length < 632) throw new Error("intel_quote too short to be a TDX quote");
  const version = q.readUInt16LE(0);
  // v4: 48-byte header, then the TD report body; report_data sits at body+520.
  // v5: 48-byte header, then body type (u16) + body size (u32), then the body.
  const bodyStart = version === 5 ? 48 + 6 : 48;
  const off = bodyStart + 520;
  if (q.length < off + 64) throw new Error("intel_quote truncated before report_data");
  return q.subarray(off, off + 64);
}

async function checkGpu(nvidiaPayload, nonce) {
  if (!nvidiaPayload) return { ok: false, why: "no nvidia_payload in report" };
  let payload;
  try {
    payload = typeof nvidiaPayload === "string" ? JSON.parse(nvidiaPayload) : nvidiaPayload;
  } catch {
    return { ok: false, why: "nvidia_payload is not JSON" };
  }
  if (strip0x(payload.nonce) !== nonce) return { ok: false, why: "GPU evidence nonce ≠ our nonce" };
  try {
    const res = await fetch(NRAS_URL(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, why: `NRAS HTTP ${res.status}` };
    const body = await res.json();
    // NRAS answers [["JWT", "<overall token>"], {...per-GPU tokens}]; the overall verdict
    // is a claim in the first token. We read the claim; the JWT's own signature is NVIDIA's.
    const jwt = Array.isArray(body) && Array.isArray(body[0]) ? body[0][1] : null;
    const claims = jwt ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) : {};
    return claims["x-nvidia-overall-att-result"] === true
      ? { ok: true }
      : { ok: false, why: "NRAS overall attestation result is not true" };
  } catch (e) {
    return { ok: false, why: `NRAS unreachable: ${String(e.message).slice(0, 80)}` };
  }
}

function summarise(name, nodes, key) {
  const passed = nodes.filter((n) => n[key]?.ok).length;
  if (passed === nodes.length) return check(name, "pass", `${passed}/${nodes.length} TEE node(s)`);
  const why = nodes.find((n) => !n[key]?.ok)?.[key]?.why || "failed";
  return check(name, passed ? "warn" : "fail", `${passed}/${nodes.length} node(s) pass — ${why}`);
}

function finish({ mode, nonce, checks, attestedAddresses, reportSha256 = null }) {
  const verified = attestedAddresses.length > 0 && !checks.some((c) => c.status === "fail");
  const result = { mode, verified, nonce, checks, attestedAddresses, reportSha256 };
  if (mode === "strict" && !verified) {
    throw new VerificationError(
      "NEAR AI attestation did not verify — no evidence was sent to the model (ATTESTATION_MODE=strict)",
      result,
    );
  }
  return result;
}

// --- step 5: reply signature ------------------------------------------------

export async function verifyReplySignature(reply, attestation) {
  const mode = attestation.mode;
  if (mode === "off") {
    return { mode, verified: false, checks: [check("reply signature", "skip", "ATTESTATION_MODE=off")] };
  }
  const checks = [];
  let sig;
  for (let i = 0; i < 3 && !sig; i++) {
    try {
      sig = await fetchReplySignature(reply.id);
    } catch (e) {
      if (i === 2) checks.push(check("signature fetched", "fail", String(e.message).slice(0, 160)));
      else await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  if (sig) {
    checks.push(check("signature fetched", "pass", `chat ${String(reply.id).slice(0, 24)}`));

    const reqHash = sha256hex(reply.requestBody);
    const resHash = sha256hex(reply.responseText);
    const parts = String(sig.text || "").split(":");
    const [sReq, sRes] = parts.length === 3 ? parts.slice(1) : parts;
    checks.push(
      parts.length >= 2 && parts.length <= 3 && sReq === reqHash && sRes === resHash
        ? check("signed hashes match this request + reply", "pass", `req ${reqHash.slice(0, 12)}… res ${resHash.slice(0, 12)}…`)
        : check("signed hashes match this request + reply", "fail", "signed text does not carry our request/response hashes"),
    );

    let recovered = null;
    try {
      recovered = recoverEip191(String(sig.text), sig.signature);
    } catch (e) {
      checks.push(check("signature recovers to signing address", "fail", String(e.message).slice(0, 120)));
    }
    if (recovered) {
      const claimed = `0x${strip0x(sig.signing_address)}`;
      checks.push(
        recovered === claimed
          ? check("signature recovers to signing address", "pass", recovered)
          : check("signature recovers to signing address", "fail", `recovered ${recovered}, claimed ${claimed}`),
      );
      checks.push(
        attestation.attestedAddresses.includes(recovered)
          ? check("signer is an attested TEE key", "pass", "matches a key bound in the attestation report")
          : check("signer is an attested TEE key", "fail", "signer was not in the verified attestation"),
      );
    }
  }
  const verified = checks.length > 0 && checks.every((c) => c.status === "pass");
  const result = { mode, verified, checks };
  if (mode === "strict" && !verified) {
    throw new VerificationError("Model reply signature did not verify — report discarded (ATTESTATION_MODE=strict)", result);
  }
  return result;
}

/** EIP-191 personal_sign recovery → lowercase 0x address. */
export function recoverEip191(text, signatureHex) {
  const sig = Buffer.from(strip0x(signatureHex), "hex");
  if (sig.length !== 65) throw new Error("signature is not 65 bytes");
  const msg = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg]));
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest);
  const raw = pub.toRawBytes(false).subarray(1);
  return `0x${Buffer.from(keccak_256(raw).subarray(-20)).toString("hex")}`;
}
