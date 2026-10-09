"use strict";
let csrf = "";
let offset = 0;
let currentList = [];
let lastActivationCode = "";

const el = id => document.getElementById(id);
function syncMessagingMode(prefix = "") {
  const managed = el(prefix + "messaging-managed").checked;
  ["jid", "password", "websocket"].forEach(field => {
    el(prefix + "messaging-" + field).disabled = managed;
  });
}
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
      if (d.state === "active" || d.state === "locked") {
        const edit = document.createElement("button");
        edit.textContent = "Edit";
        edit.addEventListener("click", () => openDeviceEditor(d.id).catch(error => note(error.message)));
        bar.append(edit);
      }
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
async function openDeviceEditor(deviceId) {
  const d = await api("devices/" + encodeURIComponent(deviceId));
  el("edit-device-id").value = d.id;
  el("edit-extension").value = d.extension || "";
  el("edit-display-name").value = d.display_name || "";
  el("edit-branding-name").value = d.branding_name || "VoiceHost";
  el("edit-telephony-mode").value = d.telephony_mode || "randy_managed";
  el("edit-sip-user").value = d.sip_username || "";
  el("edit-sip-password").value = "";
  el("edit-sip-realm").value = d.sip_realm || "";
  el("edit-sip-proxy").value = d.sip_proxy || "";
  el("edit-messaging-enabled").checked = d.messaging_enabled === true;
  el("edit-messaging-managed").checked = d.messaging_managed === true;
  syncMessagingMode("edit-");
  el("edit-messaging-jid").value = d.messaging_jid || "";
  el("edit-messaging-websocket").value = d.messaging_websocket || "wss://ejabberd.voicehost.io/websocket";
  el("edit-messaging-password").value = "";
  el("edit-messaging-state").textContent = d.messaging_managed
    ? "Automatic account: " + (d.messaging_account?.status || (d.messaging_enabled ? "pending" : "disabled")) +
      ". Active phones: " + (d.messaging_account?.active_devices || 0) +
      (d.messaging_account?.error ? ". " + d.messaging_account.error : "")
    : d.messaging_password_configured
    ? "A messaging password is configured. Blank keeps it for the same account and server."
    : "No messaging password is configured.";
  el("edit-ldap-enabled").checked = d.ldap_enabled === true;
  el("edit-ldap-ou").value = d.ldap_ou || "";
  el("edit-ldap-uid").value = d.ldap_uid || "";
  el("edit-ldap-password").value = "";
  el("edit-device-meta").textContent =
    d.id + " · version " + d.configuration_version + " · " + d.state;
  el("edit-password-state").textContent = d.sip_password_configured
    ? "A SIP password is configured. Leave the field blank to retain it."
    : "No SIP password is currently configured.";
  el("edit-ldap-state").textContent = d.ldap_password_configured
    ? "An LDAP password is configured. Leave the field blank to retain it. Server: " +
      d.ldap_server + ":" + d.ldap_port
    : "No LDAP password is currently configured.";
  el("device-editor").showModal();
}

async function saveDeviceEditor() {
  const deviceId = el("edit-device-id").value;
  const mode = el("edit-telephony-mode").value;
  const body = {
    extension: el("edit-extension").value.trim(),
    display_name: el("edit-display-name").value.trim() || null,
    branding_name: el("edit-branding-name").value.trim() || "VoiceHost",
    connection_strategy: mode === "direct_janus" ? "direct_janus" : "managed_mobile",
    telephony_mode: mode,
    sip_username: el("edit-sip-user").value.trim() || null,
    sip_password: el("edit-sip-password").value || null,
    sip_realm: el("edit-sip-realm").value.trim() || null,
    sip_proxy: el("edit-sip-proxy").value.trim() || null,
    messaging_enabled: el("edit-messaging-enabled").checked,
    messaging_managed: el("edit-messaging-managed").checked,
    messaging_jid: el("edit-messaging-managed").checked ? null : el("edit-messaging-jid").value.trim() || null,
    messaging_password: el("edit-messaging-managed").checked ? null : el("edit-messaging-password").value || null,
    messaging_websocket: el("edit-messaging-managed").checked ? null : el("edit-messaging-websocket").value.trim() || null,
    ldap_enabled: el("edit-ldap-enabled").checked,
    ldap_ou: el("edit-ldap-ou").value.trim() || null,
    ldap_uid: el("edit-ldap-uid").value.trim() || null,
    ldap_password: el("edit-ldap-password").value || null
  };
  if (!body.extension) throw new Error("Extension is required.");
  if (body.ldap_enabled && (!body.ldap_ou || !body.ldap_uid)) {
    throw new Error("LDAP OU and UID are required when LDAP is enabled.");
  }
  const result = await api("devices/" + encodeURIComponent(deviceId) + "/configuration", {
    method: "PUT",
    body: JSON.stringify(body)
  });
  el("device-editor").close();
  note("Configuration saved as version " + result.configuration_version +
       ". The device will apply it on its next check-in.", true);
  await loadDevices();
  await loadOverview();
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
  el("edit-close").addEventListener("click", () => el("device-editor").close());
  el("edit-cancel").addEventListener("click", () => el("device-editor").close());
  el("messaging-managed").addEventListener("change", () => syncMessagingMode());
  el("edit-messaging-managed").addEventListener("change", () => syncMessagingMode("edit-"));
  el("device-edit-form").addEventListener("submit", async event => {
    event.preventDefault();
    try { await saveDeviceEditor(); } catch (error) { note(error.message); }
  });
  el("activation-form").addEventListener("submit", async event => {
    event.preventDefault();
    const body = {
      extension:el("extension").value.trim(),display_name:el("display-name").value.trim() || null,
      branding_name:el("branding-name").value.trim() || "VoiceHost",
      expires_in:Number(el("expires").value),
      connection_strategy:el("telephony-mode").value === "direct_janus" ? "direct_janus" : "managed_mobile",
      telephony_mode:el("telephony-mode").value,
      sip_username:el("sip-user").value.trim() || null,
      sip_password:el("sip-password").value || null,
      sip_realm:el("sip-realm").value.trim() || "hpbx.sipconvergence.co.uk",
      sip_proxy:el("sip-proxy").value.trim() || null,
      messaging_enabled: el("messaging-enabled").checked,
    messaging_managed: el("messaging-managed").checked,
    messaging_jid: el("messaging-managed").checked ? null : el("messaging-jid").value.trim() || null,
    messaging_password: el("messaging-managed").checked ? null : el("messaging-password").value || null,
    messaging_websocket: el("messaging-managed").checked ? null : el("messaging-websocket").value.trim() || null,
    ldap_enabled:el("ldap-enabled").checked,
      ldap_ou:el("ldap-ou").value.trim() || null,
      ldap_uid:el("ldap-uid").value.trim() || null,
      ldap_password:el("ldap-password").value || null
    };
    if (body.ldap_enabled && (!body.ldap_ou || !body.ldap_uid || !body.ldap_password)) {
      note("LDAP OU, UID and password are required when LDAP is enabled.");
      return;
    }
    try {
      const result = await api("activations", {method:"POST",body:JSON.stringify(body)});
      lastActivationCode = result.code;
      el("activation-code").textContent = result.code;
      el("activation-expiry").textContent = "Expires " + new Date(result.expires_at).toLocaleString();
      el("activation-result").hidden = false;
      el("sip-password").value = "";
      el("messaging-password").value = "";
      el("ldap-password").value = "";
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
