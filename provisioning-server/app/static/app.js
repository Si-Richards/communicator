"use strict";
let csrf = "";
let offset = 0;
let currentList = [];
let lastActivationCode = "";

const el = id => document.getElementById(id);
function note(message, good = false) {
  const target = el("notice");
  if (!target) return;
  target.hidden = false;
  target.className = good ? "notice success" : "notice";
  target.textContent = message;
}
async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { "Accept": "application/json", ...(options.headers || {}) };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = csrf;
  }
  const response = await fetch("/portal/api/" + path, {
    ...options, method, headers, credentials: "same-origin", cache: "no-store"
  });
  if (response.status === 401 && path !== "login") {
    location.replace("/portal/login");
    throw new Error("Your session has expired.");
  }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    const detail = result.detail || result.error || "Request failed (" + response.status + ")";
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return result;
}
function td(value, className = "") {
  const node = document.createElement("td");
  if (className) node.className = className;
  node.textContent = value == null ? "—" : String(value);
  return node;
}
function renderTable(container, items, actions = false) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "muted"; empty.style.padding = "24px";
    empty.textContent = "No devices to display.";
    container.append(empty); return;
  }
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  ["DEVICE", "PLATFORM", "STATUS", "APP", "LAST SEEN", ...(actions ? ["ACTIONS"] : [])]
    .forEach(name => { const th = document.createElement("th"); th.textContent = name; header.append(th); });
  head.append(header); table.append(head);
  const body = document.createElement("tbody");
  items.forEach(d => {
    const row = document.createElement("tr");
    const name = td("", "device-name");
    name.textContent = d.device_name || d.installation_id;
    const sub = document.createElement("span");
    sub.className = "device-sub"; sub.textContent = d.id; name.append(sub);
    row.append(name, td(d.platform), td("", "state-cell"), td(d.app_version + " · " + d.app_build),
      td(d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "Never"));
    const pill = document.createElement("span"); pill.className = "pill " + d.state;
    pill.textContent = d.state;
    row.querySelector(".state-cell").append(pill);
    if (actions) {
      const cell = document.createElement("td"); const bar = document.createElement("div");
      bar.className = "actions";
      const choices = d.state === "active" ? ["locked", "revoked", "retired"]
        : d.state === "locked" ? ["active", "revoked", "retired"] : [];
      choices.forEach(state => {
        const button = document.createElement("button");
        button.textContent = state === "active" ? "Unlock" : state[0].toUpperCase() + state.slice(1);
        if (state === "revoked" || state === "retired") button.className = "danger";
        button.addEventListener("click", async () => {
          if (!confirm("Change " + (d.device_name || d.id) + " to " + state + "?" +
                (["revoked", "retired"].includes(state) ? " Current credentials will be invalidated." : ""))) return;
          try {
            await api("devices/" + encodeURIComponent(d.id) + "/state", {
              method: "POST", body: JSON.stringify({state})
            });
            note("Device state updated to " + state + ".", true);
            await loadDevices(); await loadOverview();
          } catch (error) { note(error.message); }
        });
        bar.append(button);
      });
      cell.append(bar); row.append(cell);
    }
    body.append(row);
  });
  table.append(body); container.append(table);
}
async function loadOverview() {
  const result = await api("overview");
  el("stat-total").textContent = result.devices;
  el("stat-active").textContent = result.by_state.active || 0;
  el("stat-locked").textContent = result.by_state.locked || 0;
  el("stat-pending").textContent = result.pending_activations;
  const recent = await api("devices?limit=6");
  renderTable(el("recent-devices"), recent.items);
}
async function loadDevices() {
  const query = el("device-query").value.trim();
  const state = el("device-state").value;
  const params = new URLSearchParams({limit:"25",offset:String(offset)});
  if (query) params.set("query", query);
  if (state) params.set("state", state);
  const result = await api("devices?" + params.toString());
  currentList = result.items;
  renderTable(el("device-results"), result.items, true);
  el("device-count").textContent = result.total ? (offset + 1) + "–" +
    (offset + result.items.length) + " of " + result.total : "0 devices";
  el("device-prev").disabled = offset === 0;
  el("device-next").disabled = offset + result.items.length >= result.total;
}
const pages = {
  dashboard: ["COMMAND CENTRE", "Overview", "Your device estate at a glance."],
  devices: ["DEVICE ESTATE", "Devices", "Manage registered devices and their access."],
  activations: ["DEVICE ENROLMENT", "Provisioning", "Create single-use activation codes for managed installations."],
  maintenance: ["OPERATIONS", "Maintenance", "Review and safely prune expired credentials."]
};
async function show(view) {
  if (!pages[view]) return;
  document.querySelectorAll(".view").forEach(n => n.hidden = n.id !== view + "-view");
  document.querySelectorAll("[data-view]").forEach(n => n.classList.toggle("active", n.dataset.view === view));
  el("page-eyebrow").textContent = pages[view][0];
  el("page-title").textContent = pages[view][1];
  el("page-subtitle").textContent = pages[view][2];
  el("new-activation").hidden = view === "activations";
  el("notice").hidden = true;
  try {
    if (view === "dashboard") await loadOverview();
    if (view === "devices") await loadDevices();
  } catch (error) { note(error.message); }
}
async function boot() {
  if (el("login-form")) {
    el("login-form").addEventListener("submit", async event => {
      event.preventDefault();
      el("login-error").textContent = "";
      try {
        await api("login", {method:"POST", body:JSON.stringify({password:el("password").value})});
        location.replace("/portal");
      } catch (error) { el("login-error").textContent = error.message; }
    });
    return;
  }
  if (!el("dashboard-view")) return;
  try {
    const result = await api("session");
    csrf = result.csrf;
  } catch (error) { note(error.message); return; }
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => show(button.dataset.view)));
  el("new-activation").addEventListener("click", () => show("activations"));
  el("device-search").addEventListener("click", () => { offset = 0; loadDevices().catch(e => note(e.message)); });
  el("device-query").addEventListener("keydown", event => { if (event.key === "Enter") { offset = 0; loadDevices().catch(e => note(e.message)); } });
  el("device-state").addEventListener("change", () => { offset = 0; loadDevices().catch(e => note(e.message)); });
  el("device-prev").addEventListener("click", () => { offset = Math.max(0, offset - 25); loadDevices().catch(e => note(e.message)); });
  el("device-next").addEventListener("click", () => { offset += 25; loadDevices().catch(e => note(e.message)); });
  el("activation-form").addEventListener("submit", async event => {
    event.preventDefault();
    const body = {
      extension:el("extension").value.trim(),display_name:el("display-name").value.trim() || null,
      expires_in:Number(el("expires").value),
      connection_strategy:el("telephony-mode").value === "direct_janus" ? "direct_janus" : "managed_mobile",
      telephony_mode:el("telephony-mode").value,
      sip_username:el("sip-user").value.trim() || null,
      sip_password:el("sip-password").value || null
    };
    try {
      const result = await api("activations", {method:"POST",body:JSON.stringify(body)});
      lastActivationCode = result.code;
      el("activation-code").textContent = result.code;
      el("activation-expiry").textContent = "Expires " + new Date(result.expires_at).toLocaleString();
      el("activation-result").hidden = false;
      el("sip-password").value = "";
      note("Activation created. Copy the code now; it cannot be retrieved later.", true);
    } catch (error) { note(error.message); }
  });
  el("copy-activation").addEventListener("click", () => navigator.clipboard.writeText(lastActivationCode).then(
    () => note("Activation code copied.", true), () => note("Unable to copy. Select the code manually.")));
  el("maintenance-form").addEventListener("submit", async event => {
    event.preventDefault();
    const body = {retention_days:Number(el("retention").value),dry_run:el("dry-run").checked};
    if (!body.dry_run && !confirm("Permanently delete eligible expired credentials and activations?")) return;
    try {
      const result = await api("maintenance/housekeeping",{method:"POST",body:JSON.stringify(body)});
      el("maintenance-result").hidden = false;
      el("maintenance-result").textContent = JSON.stringify(result,null,2);
      note(result.dry_run ? "Preview complete; nothing was deleted." : "Housekeeping completed.", true);
    } catch (error) { note(error.message); }
  });
  el("logout").addEventListener("click", async () => {
    try { await api("logout", {method:"POST",body:"{}"}); location.replace("/portal/login"); }
    catch (error) { note(error.message); }
  });
  await show("dashboard");
}
document.addEventListener("DOMContentLoaded", boot);
