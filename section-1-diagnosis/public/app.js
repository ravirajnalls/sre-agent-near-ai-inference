"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SEV_CLASS = { SEV1: "sev1", SEV2: "sev2", SEV3: "sev3" };

// --- boot -------------------------------------------------------------------

async function boot() {
  await refreshHealth();
  await loadScenarios();
  $("btn-telemetry").addEventListener("click", () => run("telemetry"));
  $("btn-triage").addEventListener("click", () => run("triage"));
  $("btn-bundle").addEventListener("click", () => run("bundle"));
  $("btn-chat").addEventListener("click", ask);
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") ask();
  });
}

async function refreshHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    setDot("dot-key", h.keyConfigured);
    setDot("dot-collector", h.collector === "ok");
    setDot("dot-jaeger", h.jaeger === "ok");
    setDot("dot-prom", h.prometheus === "ok");
    $("model-badge").textContent = `${h.tier} · ${h.model}`;
    $("model-badge").classList.add("ok");
  } catch {
    setDot("dot-key", false);
    setDot("dot-jaeger", false);
    setDot("dot-prom", false);
  }
}

function setDot(id, ok) {
  const el = $(id);
  el.className = `dot ${ok ? "on" : "off"}`;
}

// --- scenarios ---------------------------------------------------------------

async function loadScenarios() {
  try {
    const list = await (await fetch("/api/scenarios")).json();
    $("scenarios").innerHTML = list
      .map(
        (s) => `
        <button class="btn seedbtn" data-id="${esc(s.id)}">
          <span class="sev ${SEV_CLASS[s.severity] || "sev3"}">${esc(s.severity)}</span> ${esc(s.id)}
        </button>`,
      )
      .join("");
    for (const b of document.querySelectorAll(".seedbtn")) {
      b.addEventListener("click", () => seedScenario(b.dataset.id));
    }
  } catch {
    $("scenarios").innerHTML = '<p class="muted">unavailable</p>';
  }
}

async function seedScenario(id) {
  toast(`simulating ${id} …`);
  try {
    const r = await (await fetch("/api/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: id }),
    })).json();
    if (r.error) throw new Error(r.error);
    $("service").value = r.suggestedService || $("service").value;
    toast(`simulated ${r.scenario}: ${r.tracesPushed} traces pushed through the collector — now Fetch telemetry or Triage privately`);
    await refreshHealth();
  } catch (e) {
    toast(`seed failed: ${e.message}`);
  }
}

// --- runs --------------------------------------------------------------------

async function run(mode) {
  const service = $("service").value.trim() || "checkout";
  const sinceMinutes = Number($("since").value);
  const maxTraces = Number($("maxtraces").value);

  if (mode === "telemetry") {
    renderTelemetryBusy();
    try {
      const t = await post("/api/telemetry", { service, sinceMinutes, maxTraces });
      if (t.error) throw new Error(t.error);
      renderTelemetry(t);
    } catch (e) {
      $("telemetry").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
    return;
  }

  const body =
    mode === "bundle"
      ? { bundle: $("bundle").value }
      : { service, sinceMinutes, maxTraces };

  renderReportBusy(mode === "bundle");
  const btn = mode === "bundle" ? $("btn-bundle") : $("btn-triage");
  btn.disabled = true;
  try {
    const r = await post("/api/triage", body);
    if (r.error) {
      // A failed attestation/signature check still shows WHICH check failed.
      if (r.verification) renderPrivacy({ privacy: { verification: r.verification, scope: "Stopped: verification failed, so the report was withheld." } });
      throw new Error(r.error);
    }
    if (r.telemetry) renderTelemetry(r.telemetry);
    renderReport(r);
    renderPrivacy(r);
    startChat(r.chatContext);
    $("report-meta").textContent = r.privacy?.modelMs
      ? `${r.privacy.model} · ${(r.privacy.modelMs / 1000).toFixed(1)}s in the TEE`
      : "";
  } catch (e) {
    $("report").innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// --- render: telemetry ---------------------------------------------------------

function renderTelemetryBusy() {
  $("telemetry").innerHTML = '<p class="muted">querying jaeger + prometheus …</p>';
}

function renderTelemetry(t) {
  const q = t.queries || {};
  const spanRows = (t.errorSpans || [])
    .slice(0, 30)
    .map(
      (s) => `<tr>
        <td>${esc(s.service)}</td>
        <td>${esc(s.operation)}</td>
        <td class="mono">${s.statusCode ?? "—"}</td>
        <td class="mono">${s.durationMs} ms</td>
        <td>${esc(s.exceptionType || "")}${s.exceptionMessage ? ` — ${esc(s.exceptionMessage)}` : ""}</td>
      </tr>`,
    )
    .join("");

  const metrics = (t.metrics || [])
    .map(
      (m) => `<div class="metric">
        <code>${esc(m.query)}</code>
        ${m.series.length ? "" : '<span class="muted">no series</span>'}
        ${m.series
          .map(
            (s) =>
              `<div class="series"><span class="labels">${Object.entries(s.labels || {})
                .filter(([k]) => k !== "__name__")
                .map(([k, v]) => `${esc(k)}=${esc(v)}`)
                .join(" ")}</span><span class="value mono">${esc(s.lastValue)}</span></div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");

  $("telemetry-meta").textContent = `${t.service} · last ${t.sinceMinutes} min · ${t.traceCount} error traces`;
  $("telemetry").innerHTML = `
    ${q.jaeger ? `<code class="query">${esc(q.jaeger)}</code>` : ""}
    ${q.jaegerError ? `<p class="err">jaeger: ${esc(q.jaegerError)}</p>` : ""}
    ${spanRows ? `<table class="spans"><thead><tr><th>service</th><th>operation</th><th>status</th><th>dur</th><th>exception</th></tr></thead><tbody>${spanRows}</tbody></table>` : '<p class="muted">no error spans found in this window — try a wider window or seed an incident.</p>'}
    <div class="metrics">${metrics}</div>`;
}

// --- render: report -------------------------------------------------------------

function renderReportBusy(bundleMode) {
  $("report").innerHTML = bundleMode
    ? '<p class="muted">sending the bundle into the Confidential TEE …</p>'
    : '<p class="muted">assembling evidence and consulting the Confidential TEE … the model reasons first, so this can take up to a minute or two.</p>';
}

function renderReport(r) {
  if (!r.report) {
    $("report").innerHTML = `
      <p class="err">The model did not return clean JSON — raw reply:</p>
      <pre class="raw">${esc(r.rawText || "(empty response)")}</pre>`;
    return;
  }
  const rep = r.report;
  const sev = `<span class="sev ${SEV_CLASS[rep.severity] || "sev3"}">${esc(rep.severity || "SEV?")}</span>`;
  const conf = Math.round((rep.rootCause?.confidence ?? 0) * 100);

  const evidence = (rep.rootCause?.evidence || [])
    .map((e) => `<li>${esc(e)}</li>`)
    .join("");

  const blast = (rep.blastRadius?.services || [])
    .map((s) => `<span class="chip">${esc(s)}</span>`)
    .join("");

  const actions = (rep.nextActions || [])
    .slice()
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map(
      (a) => `<li>
        <div class="action"><span class="prio mono">#${esc(a.priority)}</span> ${esc(a.action)}</div>
        ${a.command ? `<code class="cmd">${esc(a.command)}</code>` : ""}
        ${a.why ? `<div class="why">${esc(a.why)}</div>` : ""}
      </li>`,
    )
    .join("");

  const alternates = (rep.alternates || [])
    .map((a) => `<li><b>${esc(a.summary)}</b> <span class="muted">— ${esc(a.whyLessLikely || "")}</span></li>`)
    .join("");

  const followUps = (rep.followUps || []).map((f) => `<li>${esc(f)}</li>`).join("");

  $("report").innerHTML = `
    <div class="roothead">${sev}
      <div class="rc">${esc(rep.rootCause?.summary || "")}</div>
      <div class="confbar"><div class="fill" style="width:${conf}%"></div></div>
      <div class="muted">confidence ${conf}%</div>
    </div>
    ${evidence ? `<h3>evidence</h3><ul class="ev">${evidence}</ul>` : ""}
    ${blast ? `<h3>blast radius</h3><div class="chips">${blast}</div><p>${esc(rep.blastRadius?.summary || "")}</p>` : ""}
    ${renderAction(r.actionCheck)}
    ${actions ? `<h3>next actions</h3><ol class="actions">${actions}</ol>` : ""}
    ${alternates ? `<h3>alternates</h3><ul class="alts">${alternates}</ul>` : ""}
    ${followUps ? `<h3>follow-ups</h3><ul class="fu">${followUps}</ul>` : ""}`;
}

// --- render: privacy -------------------------------------------------------------

function renderChecks(title, checks) {
  const icon = { pass: "✓", fail: "✗", warn: "!", skip: "–" };
  const rows = (checks || [])
    .map(
      (c) => `<li class="chk ${esc(c.status)}"><span class="mono">${icon[c.status] || "?"}</span> <b>${esc(c.name)}</b>
        <span class="muted">${esc(c.detail || "")}</span></li>`,
    )
    .join("");
  return `<h3>${esc(title)}</h3><ul class="checks">${rows}</ul>`;
}

function renderAction(ac) {
  if (!ac) return "";
  const a = ac.action;
  const badge =
    ac.status === "valid"
      ? '<span class="vbadge ok">on the fixed list · valid</span>'
      : '<span class="vbadge bad">rejected by the runtime</span>';
  const body = a
    ? `<code class="cmd">${esc(a.type)} ${esc(a.namespace)}/${esc(a.target)} ${esc(JSON.stringify(a.params))}</code>`
    : `<ul class="checks">${(ac.reasons || []).map((x) => `<li class="chk fail"><span class="mono">✗</span> ${esc(x)}</li>`).join("")}</ul>`;
  return `<h3>proposed fix (one action, fixed list)</h3><div>${badge}</div>${body}
    <p class="muted">Not applied. In Section 2 a valid action goes to the NEAR contract, which approves, parks or rejects it; only the executor can change the cluster.</p>`;
}

function renderFlow(r) {
  const p = r.privacy || {};
  const v = p.verification || {};
  const sigs = v.signatures || [];
  const st = (ok) => (ok === true ? "ok" : ok === false ? "bad" : "idle");
  const steps = [
    ["1", "Masked on your side", p.redaction ? `${p.redaction.totals.collector} in collector · ${p.redaction.totals.server} in server` : "—", p.redaction ? true : null],
    ["2", "TEE attested", v.attestation ? `fresh nonce ${esc((v.attestation.nonce || "").slice(0, 10))}…` : "—", v.attestation ? v.attestation.verified : null],
    ["3", "Inference inside the TEE", p.model ? `${esc(p.model)} · ${((p.modelMs || 0) / 1000).toFixed(1)}s` : "—", p.model ? true : null],
    ["4", "Reply signed by the TEE key", sigs.length ? `${sigs.filter((x) => x.verified).length}/${sigs.length} signature(s) verified` : "—", sigs.length ? sigs.every((x) => x.verified) : null],
    ["5", "Fix checked against the list", r.actionCheck ? esc(r.actionCheck.status) : "—", r.actionCheck ? r.actionCheck.status === "valid" : null],
  ];
  return `<h3>how this request went through the TEE</h3><div class="flow">${steps
    .map(([n, t, d, ok]) => `<div class="fstep ${st(ok)}"><span class="fn mono">${n}</span><b>${t}</b><span class="muted">${d}</span></div>`)
    .join('<span class="farrow">→</span>')}</div>`;
}

function renderRaw(r) {
  const p = r.privacy || {};
  const v = p.verification || {};
  const block = (title, obj) => (obj == null ? "" : `<h3>${esc(title)}</h3><pre class="raw">${esc(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2))}</pre>`);
  return `<details class="rawbox"><summary>raw evidence: model reply, attestation report, signatures</summary>
    ${block("model reply text (exactly what the TEE returned and signed)", p.rawModelContent)}
    ${block("attestation: our nonce and each TEE node's report", v.attestation ? { nonce: v.attestation.nonce, report_sha256: v.attestation.reportSha256, nodes: v.attestation.nodes } : null)}
    ${(v.signatures || []).map((x, i) => block(`reply signature #${i + 1}`, x.raw)).join("")}
  </details>`;
}

function renderPrivacy(r) {
  const p = r.privacy || {};
  const v = p.verification;
  let attest = "";
  if (v) {
    const a = v.attestation || {};
    const badge = a.verified
      ? '<span class="vbadge ok">attestation verified</span>'
      : `<span class="vbadge bad">NOT verified · mode ${esc(v.mode)}</span>`;
    attest += `<div>${badge}</div>
      ${renderChecks("attestation (before any data was sent)", a.checks)}
      ${(v.signatures || []).map((s, i) => renderChecks(`reply signature #${i + 1}`, s.checks)).join("")}
      ${a.reportSha256 ? `<p class="muted mono">attestation report sha256 ${esc(a.reportSha256)}</p>` : ""}`;
  }
  if (p.redaction) {
    const rd = p.redaction;
    const kinds = [...new Set([...Object.keys(rd.collector || {}), ...Object.keys(rd.server || {})])].sort();
    const rows = kinds
      .map((k) => `<tr><td class="mono">${esc(k)}</td><td>${esc(rd.collector?.[k] || 0)}</td><td>${esc(rd.server?.[k] || 0)}</td></tr>`)
      .join("");
    attest =
      `<h3>redaction manifest (kinds and counts, never values)</h3>` +
      (kinds.length
        ? `<table class="spans"><thead><tr><th>kind</th><th>masked in collector</th><th>masked in server</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">no secrets matched any rule in this evidence.</p>') +
      (rd.totals?.server
        ? '<p class="muted">The server had to mask some values itself: they reached it unmasked (paste mode, or a pattern the collector missed).</p>'
        : "") +
      attest;
  }
  attest = renderFlow(r) + attest;
  if (p.model) {
    attest += `<h3>response metadata</h3><pre class="raw">${esc(
      JSON.stringify({ model: p.model, responseId: p.responseId, usage: p.usage, modelMs: p.modelMs, attempts: p.attempts }, null, 2),
    )}</pre>`;
  }

  $("privacy").innerHTML = `
    <div class="tiers">
      <div class="tier active">
        <b>${esc(p.tier || "Confidential TEE")}</b>
        <p>NEAR's own GPUs — prompt and output hidden from everyone, NEAR included.</p>
      </div>
      <div class="tier">
        <b>Incognito (not used)</b>
        <p>Provider servers; only the gateway is in a TEE.</p>
      </div>
      <div class="tier">
        <b>Normal chatbot (not used)</b>
        <p>Your incident evidence would be stored on the provider's servers.</p>
      </div>
    </div>
    ${attest}
    <p class="scope">${esc(p.scope || "")}</p>
    ${renderRaw(r)}`;
}

// --- chat ------------------------------------------------------------------------
// The browser holds the (already masked) incident context and the history; the
// server keeps nothing between messages.

let chatContext = null;
let chatHistory = [];

function startChat(ctx) {
  chatContext = ctx || null;
  chatHistory = [];
  const on = Boolean(chatContext);
  $("chat-input").disabled = !on;
  $("btn-chat").disabled = !on;
  $("chat-log").innerHTML = on
    ? '<p class="muted">Ask a follow-up question about this incident.</p>'
    : '<p class="muted">The report did not parse, so there is no context to chat about. Run the triage again.</p>';
}

function verifyBadge(v) {
  if (!v) return "";
  const ok = v.attestation?.verified && (v.signatures || []).every((s) => s.verified);
  const failed = [...(v.attestation?.checks || []), ...(v.signatures || []).flatMap((s) => s.checks || [])]
    .filter((c) => c.status === "fail")
    .map((c) => c.name);
  return ok
    ? '<span class="vbadge ok">attested · signature verified</span>'
    : `<span class="vbadge bad">NOT verified · mode ${esc(v.mode)}${failed.length ? " · " + esc(failed.join(", ")) : ""}</span>`;
}

function addMsg(role, html) {
  if (!chatHistory.length && $("chat-log").querySelector(".muted")) $("chat-log").innerHTML = "";
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = html;
  $("chat-log").appendChild(div);
  div.scrollIntoView({ block: "nearest" });
  return div;
}

async function ask() {
  const q = $("chat-input").value.trim();
  if (!q || !chatContext) return;
  $("chat-input").value = "";
  $("btn-chat").disabled = true;
  const mine = addMsg("user", esc(q));
  const pending = addMsg("agent", '<span class="muted">masking → attesting → asking the TEE model …</span>');
  try {
    const r = await post("/api/chat", { context: chatContext, history: chatHistory, question: q });
    if (r.error) {
      pending.innerHTML = `<p class="err">${esc(r.error)}</p>${verifyBadge(r.verification)}`;
      return;
    }
    // Show the question as the model saw it (masked), so a pasted secret is visibly gone.
    if (r.question !== q) mine.innerHTML = `${esc(r.question)} <span class="muted">(masked before sending)</span>`;
    const masked = r.privacy?.redaction?.totals?.server || 0;
    pending.innerHTML = `<div class="answer">${esc(r.answer)}</div>
      <div class="msgmeta">${verifyBadge(r.privacy?.verification)}
        <span class="muted mono">${esc(r.privacy?.model || "")} · ${((r.privacy?.modelMs || 0) / 1000).toFixed(1)}s${masked ? ` · ${masked} value(s) masked` : ""}</span></div>`;
    chatHistory.push({ role: "user", content: r.question }, { role: "assistant", content: r.answer });
  } catch (e) {
    pending.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally {
    $("btn-chat").disabled = false;
    $("chat-input").focus();
  }
}

// --- toast -----------------------------------------------------------------------

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

boot();
