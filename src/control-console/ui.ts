export const CONTROL_CONSOLE_CSS = `
:root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
body { margin: 0; background: #0f141b; color: #e6edf3; }
header { display: flex; gap: 16px; align-items: center; padding: 12px 20px; background: #161d27; border-bottom: 1px solid #2a3441; }
a { color: #8ab4ff; } header a { text-decoration: none; }
main { max-width: 1180px; margin: 0 auto; padding: 20px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 10px; border-bottom: 1px solid #2a3441; text-align: left; vertical-align: top; }
th { color: #9aa7b8; font-weight: 500; }
button, input, select { background: #233042; color: #e6edf3; border: 1px solid #46566d; border-radius: 5px; padding: 6px 10px; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .45; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #293648; }
.meta { color: #9aa7b8; font-size: 13px; }
.error { display: none; padding: 10px; margin-bottom: 12px; border-radius: 5px; background: #542929; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.form-grid { display: grid; grid-template-columns: 220px minmax(220px, 420px); gap: 10px; align-items: center; }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;

export function queuePage(): string {
  return page("Queue", "queue");
}

export function settingsPage(): string {
  return page("Settings", "settings");
}

function page(title: string, view: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} — Conductor</title>
<link rel="stylesheet" href="/assets/console.css"></head>
<body data-view="${view}"><header><a href="/queue">Queue</a><a href="/settings">Settings</a><span id="runtime-meta" class="meta">Connecting…</span></header>
<main><div id="error" class="error" role="alert"></div><h1>${title}</h1><div id="app" aria-live="polite"></div></main>
<script src="/assets/console.js" defer></script></body></html>`;
}

export const CONTROL_CONSOLE_JS = `
"use strict";
const state = { session: null, snapshot: null, settingsDirty: false };
const app = document.getElementById("app");
const errorBox = document.getElementById("error");
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
function showError(message) { errorBox.textContent = message || ""; errorBox.style.display = message ? "block" : "none"; }
async function json(url, init) { const response = await fetch(url, init); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = { error: text || "Non-JSON response" }; } if (!response.ok) throw Object.assign(new Error(body.error || response.statusText), { status: response.status, body }); return body; }
async function session() { if (!state.session) state.session = await json("/api/v1/session"); return state.session; }
async function mutate(route, payload) { const current = await session(); try { return await json(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, csrfToken: current.csrfToken, idempotencyKey: crypto.randomUUID() }) }); } catch (error) { if (error.status === 403) state.session = null; throw error; } }
function formatElapsed(ms) { if (ms === null || ms === undefined) return "—"; const seconds = Math.floor(ms / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); return (hours ? hours + "h " : "") + (minutes ? minutes + "m " : "") + (seconds % 60) + "s"; }
function cell(row, value, className) { const td = element("td", value, className); row.appendChild(td); return td; }
function action(label, enabled, run) { const button = element("button", label); button.disabled = !enabled; button.addEventListener("click", async () => { button.disabled = true; try { showError(""); await run(); await refresh(); } catch (error) { showError(error.message); } finally { button.disabled = false; } }); return button; }
function renderQueue(snapshot) { app.replaceChildren(); const actions = element("div", undefined, "actions"); const model = snapshot.model; const queueControl = snapshot.runtime.dispatcher.controlAuthority; actions.append(action("Load model", !!model && ["offline", "error", "wrong-model"].includes(model.state), () => mutate("/api/v1/model/load", { expectedRevision: model.revision }))); actions.append(action("Unload model", !!model && model.canUnload && ["ready", "error"].includes(model.state), () => mutate("/api/v1/model/unload", { expectedRevision: model.revision }))); app.append(actions); if (!queueControl) app.append(element("p", "Queue mutations are owned by another Conductor dispatcher process.", "meta")); app.append(element("p", model ? "Model: " + model.state + (model.failure ? " — " + model.failure.message : "") : "Model service is not configured", "meta")); const rows = snapshot.queue.items; if (!rows.length) { app.append(element("p", "The durable queue is empty.", "meta")); return; } const table = element("table"); const head = element("thead"); const hr = element("tr"); ["Job", "Objective", "Phase", "Attempt", "Updated", "Active", "Actions"].forEach((name) => cell(hr, name)); head.append(hr); table.append(head); const body = element("tbody"); rows.forEach((item) => { const row = element("tr"); cell(row, item.jobId); cell(row, item.objective); const phase = cell(row, ""); phase.append(element("span", item.phase + (item.attemptStatus ? " (" + item.attemptStatus + ")" : ""), "badge")); cell(row, item.attemptId || "—", "meta"); cell(row, item.updatedAt, "meta"); cell(row, formatElapsed(item.activeElapsedMs)); const controls = cell(row, ""); if (["queued", "dispatching", "running"].includes(item.status)) controls.append(action("Cancel", queueControl, () => mutate("/api/v1/queue/cancel", { jobId: item.jobId, expectedRevision: item.revision }))); if (["completed", "failed", "needs-input", "cancelled"].includes(item.status)) controls.append(action("Retry", queueControl, () => mutate("/api/v1/queue/retry", { jobId: item.jobId, expectedRevision: item.revision }))); body.append(row); }); table.append(body); app.append(table); }
function labeled(grid, label, control) { grid.append(element("label", label)); grid.append(control); }
function renderSettings(snapshot) {
  app.replaceChildren();
  const settings = snapshot.settings.effective;
  const grid = element("div", undefined, "form-grid");
  const host = element("select");
  ["127.0.0.1", "localhost", "::1"].forEach((value) => { const option = element("option", value); option.value = value; option.selected = value === settings.console.host; host.append(option); });
  const port = element("input"); port.type = "number"; port.min = "1"; port.max = "65535"; port.value = String(settings.console.port);
  const concurrency = element("input"); concurrency.type = "number"; concurrency.min = "1"; concurrency.max = "32"; concurrency.value = String(settings.dispatcherConcurrency || snapshot.runtime.dispatcher.maxConcurrent);
  const model = element("select");
  const selectedModelId = settings.modelServiceId || (snapshot.model && snapshot.model.profileId);
  const empty = element("option", "Not configured"); empty.value = ""; model.append(empty);
  snapshot.runtime.availableModelProfiles.forEach((value) => { const option = element("option", value); option.value = value; option.selected = value === selectedModelId; model.append(option); });
  const include = element("input"); include.type = "checkbox"; include.checked = settings.includeModelState !== false;
  const markDirty = () => { state.settingsDirty = true; };
  [host, port, concurrency, model, include].forEach((control) => { control.addEventListener("input", markDirty); control.addEventListener("change", markDirty); });
  labeled(grid, "Console host", host); labeled(grid, "Console port", port); labeled(grid, "Dispatcher concurrency (restart)", concurrency); labeled(grid, "Model profile", model); labeled(grid, "Show model state", include);
  app.append(grid);
  app.append(action("Save settings", true, async () => {
    await mutate("/api/v1/settings", { expectedRevision: snapshot.settings.revision, settings: { ...settings, console: { host: host.value, port: Number(port.value) }, dispatcherConcurrency: Number(concurrency.value), modelServiceId: model.value || undefined, includeModelState: include.checked } });
    state.settingsDirty = false;
  }));
  const policy = snapshot.runtime.policies;
  app.append(element("h2", "Effective runtime policy"));
  const pre = element("pre", JSON.stringify({ dispatcher: snapshot.runtime.dispatcher, model: snapshot.model && snapshot.model.expected, policy, resources: snapshot.runtime.resourceProfile.limits, provenance: snapshot.settings.provenance }, null, 2)); app.append(pre);
  app.append(element("p", "Settings changes apply to future eligible transitions; console bind changes require restart.", "meta"));
}
function render(snapshot) { state.snapshot = snapshot; document.getElementById("runtime-meta").textContent = "Conductor " + snapshot.runtime.conductorVersion + " · lease " + snapshot.queue.lease.state; if (document.body.dataset.view === "settings") { if (!state.settingsDirty) renderSettings(snapshot); } else renderQueue(snapshot); }
async function refresh() { try { render(await json("/api/v1/snapshot")); showError(""); } catch (error) { showError(error.message); } }
refresh(); const events = new EventSource("/api/v1/events"); events.addEventListener("snapshot", (event) => { try { render(JSON.parse(event.data)); showError(""); } catch (error) { showError(String(error)); } }); events.onerror = () => { showError("Live updates disconnected; reconnecting…"); };
`;
