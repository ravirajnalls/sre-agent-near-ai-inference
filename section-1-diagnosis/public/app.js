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
  toast(`seeding ${id} …`);
  try {
    const r = await (await fetch("/api/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: id }),
    })).json();
    if (r.error) throw new Error(r.error);
    $("service").value = r.suggestedService || $("service").value;
    toast(`seeded ${r.scenario} — ${r.tracesPushed} traces, ${r.metricPushes} metric pushes`);
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
    if (r.error) throw new Error(r.error);
    if (r.telemetry) renderTelemetry(r.telemetry);
    renderReport(r);
    renderPrivacy(r);
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
    : '<p class="muted">assembling evidence and consulting the Confidential TEE … this can take ~10–30 seconds.</p>';
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
    ${actions ? `<h3>next actions</h3><ol class="actions">${actions}</ol>` : ""}
    ${alternates ? `<h3>alternates</h3><ul class="alts">${alternates}</ul>` : ""}
    ${followUps ? `<h3>follow-ups</h3><ul class="fu">${followUps}</ul>` : ""}`;
}

// --- render: privacy -------------------------------------------------------------

function renderPrivacy(r) {
  const p = r.privacy || {};
  const attest = p.attestation
    ? `<h3>attestation receipt</h3><pre class="raw">${esc(JSON.stringify(p.attestation, null, 2))}</pre>`
    : `<h3>response metadata</h3>
       <p class="muted">This API response did not carry attestation fields — showing what it did carry. The tier below is the guarantee.</p>
       <pre class="raw">${esc(
         JSON.stringify({ model: p.model, responseId: p.responseId, usage: p.usage, modelMs: p.modelMs, attempts: p.attempts }, null, 2),
       )}</pre>`;

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
    <p class="scope">${esc(p.scope || "")}</p>`;
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
