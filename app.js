import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDocs, setDoc, deleteDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { getSunTimes } from "./sun.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

const ALLOWED_EMAILS = ["mike@snowbies.com", "amy@snowbies.com"];

const DRIVES_COL = "drives";
const META_DOC = doc(db, "meta", "active");
const META_CONFIG = doc(db, "meta", "config");
const SCHEMA_VERSION = 1;

const state = { drives: [], active: null, config: null };

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtDateInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function fmtTimeInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function combineDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, day] = dateStr.split("-").map(Number);
  const [h, min] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, day, h, min, 0, 0);
}
function fmtDisplayDate(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fmtDisplayTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function round1(n) { return Math.round(n * 10) / 10; }

function splitDayNight(startMs, endMs, lat, lon) {
  if (endMs <= startMs) return { day: 0, night: 0 };
  let dayMs = 0, nightMs = 0;
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= endMs) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const segStart = Math.max(startMs, dayStart.getTime());
    const segEnd = Math.min(endMs, dayEnd.getTime());
    if (segEnd > segStart) {
      const { sunrise, sunset } = getSunTimes(dayStart, lat, lon);
      const sunriseMs = sunrise.getTime();
      const sunsetMs = sunset.getTime();
      const dLo = Math.max(segStart, sunriseMs);
      const dHi = Math.min(segEnd, sunsetMs);
      const dayPortion = Math.max(0, dHi - dLo);
      dayMs += dayPortion;
      nightMs += (segEnd - segStart) - dayPortion;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return { day: dayMs / 60000, night: nightMs / 60000 };
}

function migrateEntry(e) {
  if (!e.schemaVersion) {
    e.schemaVersion = SCHEMA_VERSION;
    if (e.supervisor === undefined) e.supervisor = "";
    if (e.notes === undefined) e.notes = "";
  }
  return e;
}

function computeTotals() {
  let day = 0, night = 0;
  state.drives.forEach((d) => {
    day += d.dayMinutes || 0;
    night += d.nightMinutes || 0;
  });
  return { day, night, total: day + night };
}

function supervisorLabel(d) {
  if (d.supervisor === "other") return d.supervisorName ? d.supervisorName : "Other adult";
  if (d.supervisor === "mike") return "Mike";
  if (d.supervisor === "amy") return "Amy";
  return d.supervisor || "";
}

function setSyncStatus(text) {
  const el = document.getElementById("sync-status");
  if (el) el.textContent = text;
}

async function saveDrive(entry) {
  await setDoc(doc(db, DRIVES_COL, entry.id), entry);
}
async function deleteDrive(id) {
  await deleteDoc(doc(db, DRIVES_COL, id));
}
async function saveConfig(lat, lon, label) {
  await setDoc(META_CONFIG, { lat, lon, label: label || "" });
}
async function saveActive() {
  if (state.active) {
    await setDoc(META_DOC, state.active);
  } else {
    await setDoc(META_DOC, { empty: true });
  }
}

function openSetupModal() {
  if (document.getElementById("setup-modal")) return;
  const html =
    '<div class="modal-overlay" id="setup-modal">' +
      '<div class="modal-box">' +
        '<div style="margin-bottom:1rem;"><h2>Set your location</h2></div>' +
        '<div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">Day and night hours are calculated using local sunrise and sunset. Set your home location so drives are classified correctly. This is stored in your shared database—both phones will use it.</div>' +
        '<div class="field-group">' +
          '<label class="field-label">Location name (optional)</label>' +
          '<input id="setup-label" placeholder="Home">' +
        '</div>' +
        '<button id="setup-geolocate" class="btn-primary" style="margin-bottom:10px;">Use current location</button>' +
        '<div style="text-align:center; font-size:12px; color:var(--text-muted); margin: 4px 0 10px;">— or enter coordinates manually —</div>' +
        '<div class="two-col">' +
          '<div class="field-group">' +
            '<label class="field-label">Latitude</label>' +
            '<input type="number" id="setup-lat" placeholder="39.6347" step="any">' +
          '</div>' +
          '<div class="field-group">' +
            '<label class="field-label">Longitude</label>' +
            '<input type="number" id="setup-lon" placeholder="-84.2880" step="any">' +
          '</div>' +
        '</div>' +
        '<button id="setup-manual-save" class="btn-primary">Save location</button>' +
      '</div>' +
    '</div>';
  document.getElementById("modal-root").innerHTML = html;

  document.getElementById("setup-geolocate").addEventListener("click", () => {
    const btn = document.getElementById("setup-geolocate");
    btn.textContent = "Getting location…";
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const label = (document.getElementById("setup-label").value.trim()) || "Home";
      await saveConfig(pos.coords.latitude, pos.coords.longitude, label);
    }, () => {
      btn.textContent = "Use current location";
      btn.disabled = false;
      alert("Could not get your location. Enter latitude and longitude manually.");
    });
  });

  document.getElementById("setup-manual-save").addEventListener("click", async () => {
    const lat = parseFloat(document.getElementById("setup-lat").value);
    const lon = parseFloat(document.getElementById("setup-lon").value);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      alert("Enter a valid latitude (−90 to 90) and longitude (−180 to 180).");
      return;
    }
    const label = (document.getElementById("setup-label").value.trim()) || "Home";
    await saveConfig(lat, lon, label);
  });
}

function openSettingsModal() {
  const cfg = state.config;
  const body =
    '<div class="field-group">' +
      '<label class="field-label">Location name</label>' +
      '<input id="cfg-label" value="' + (cfg ? cfg.label || "" : "").replace(/"/g, "&quot;") + '" placeholder="Home">' +
    '</div>' +
    '<button id="cfg-geolocate" class="btn-primary" style="margin-bottom:10px;">Use current location</button>' +
    '<div style="text-align:center; font-size:12px; color:var(--text-muted); margin: 4px 0 10px;">— or enter coordinates manually —</div>' +
    '<div class="two-col">' +
      '<div class="field-group">' +
        '<label class="field-label">Latitude</label>' +
        '<input type="number" id="cfg-lat" value="' + (cfg ? cfg.lat : "") + '" step="any">' +
      '</div>' +
      '<div class="field-group">' +
        '<label class="field-label">Longitude</label>' +
        '<input type="number" id="cfg-lon" value="' + (cfg ? cfg.lon : "") + '" step="any">' +
      '</div>' +
    '</div>' +
    '<button id="cfg-save" class="btn-primary" style="margin-bottom:8px;">Save location</button>';
  document.getElementById("modal-root").innerHTML = modalShell("Location settings", body);
  attachCloseHandler();

  document.getElementById("cfg-geolocate").addEventListener("click", () => {
    const btn = document.getElementById("cfg-geolocate");
    btn.textContent = "Getting location…";
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const label = (document.getElementById("cfg-label").value.trim()) || "Home";
      await saveConfig(pos.coords.latitude, pos.coords.longitude, label);
      closeModal();
    }, () => {
      btn.textContent = "Use current location";
      btn.disabled = false;
      alert("Could not get your location. Enter latitude and longitude manually.");
    });
  });

  document.getElementById("cfg-save").addEventListener("click", async () => {
    const lat = parseFloat(document.getElementById("cfg-lat").value);
    const lon = parseFloat(document.getElementById("cfg-lon").value);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      alert("Enter a valid latitude (−90 to 90) and longitude (−180 to 180).");
      return;
    }
    const label = (document.getElementById("cfg-label").value.trim()) || "Home";
    await saveConfig(lat, lon, label);
    closeModal();
  });
}

function listenForConfig() {
  onSnapshot(META_CONFIG, (snap) => {
    const data = snap.exists() ? snap.data() : null;
    state.config = (data && data.lat != null && data.lon != null) ? data : null;
    if (!state.config) {
      openSetupModal();
    } else if (document.getElementById("setup-modal")) {
      document.getElementById("modal-root").innerHTML = "";
    }
  }, (err) => {
    console.error(err);
  });
}

function listenForChanges() {
  onSnapshot(collection(db, DRIVES_COL), (snap) => {
    state.drives = snap.docs.map((d) => migrateEntry(d.data()));
    setSyncStatus("");
    render();
  }, (err) => {
    console.error(err);
    setSyncStatus("Connection error. Check your network.");
  });

  onSnapshot(META_DOC, (snap) => {
    const data = snap.data();
    state.active = data && !data.empty ? data : null;
    render();
  }, (err) => {
    console.error(err);
  });
}

function render() {
  const totals = computeTotals();
  document.getElementById("total-all").textContent = round1(totals.total / 60) + (totals.total >= 3000 ? " ⭐" : "");
  document.getElementById("total-day").textContent = round1(totals.day / 60);
  document.getElementById("total-night").textContent = round1(totals.night / 60) + (totals.night >= 600 ? " ⭐" : "");

  const banner = document.getElementById("active-banner");
  const startSection = document.getElementById("start-section");
  if (state.active) {
    banner.style.display = "block";
    startSection.style.display = "none";
    const startD = new Date(state.active.startTime);
    document.getElementById("active-detail").textContent =
      "Started " + fmtDisplayDate(startD) + " at " + fmtDisplayTime(startD) +
      (state.active.supervisor ? " \u00b7 " + supervisorLabel(state.active) : "");
  } else {
    banner.style.display = "none";
    startSection.style.display = "block";
  }

  const sorted = state.drives.slice().sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));
  document.getElementById("log-count").textContent = sorted.length ? sorted.length + " entries" : "";
  const listEl = document.getElementById("log-list");
  if (!sorted.length) {
    listEl.innerHTML = '<div style="text-align:center; padding:2rem 0; color:var(--text-muted); font-size:14px;">No drives logged yet</div>';
    return;
  }
  listEl.innerHTML = sorted.map((d) => {
    const dateLabel = d.startTime ? fmtDisplayDate(new Date(d.startTime)) : fmtDisplayDate(new Date(d.manualDate));
    let timeLabel = "";
    if (d.startTime && d.endTime) {
      timeLabel = fmtDisplayTime(new Date(d.startTime)) + " \u2013 " + fmtDisplayTime(new Date(d.endTime));
    } else if (d.manualMinutes !== undefined) {
      timeLabel = d.manualClass === "night" ? "Night entry" : "Day entry";
    }
    const totalMin = (d.dayMinutes || 0) + (d.nightMinutes || 0);
    const hrs = round1(totalMin / 60);
    const dayHrs = round1((d.dayMinutes || 0) / 60);
    const nightHrs = round1((d.nightMinutes || 0) / 60);
    return '<div class="log-row" data-id="' + d.id + '">' +
      '<div style="display:flex; justify-content:space-between; align-items:baseline;">' +
        '<span style="font-weight:500; font-size:14px;">' + dateLabel + "</span>" +
        '<span style="font-size:14px; font-weight:500;">' + hrs + " hr</span>" +
      "</div>" +
      '<div style="font-size:13px; color:var(--text-secondary); margin-top:2px;">' + timeLabel + (d.supervisor ? " \u00b7 " + supervisorLabel(d) : "") + "</div>" +
      '<div style="font-size:12px; color:var(--text-muted); margin-top:4px;">Day ' + dayHrs + "h \u00b7 Night " + nightHrs + "h" + (d.notes ? " \u00b7 " + d.notes : "") + "</div>" +
    "</div>";
  }).join("");

  listEl.querySelectorAll(".log-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-id");
      const entry = state.drives.find((d) => d.id === id);
      if (entry) openEditModal(entry);
    });
  });
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

function modalShell(titleText, bodyHtml) {
  return '<div class="modal-overlay" id="modal-overlay">' +
    '<div class="modal-box">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">' +
        "<h2>" + titleText + "</h2>" +
        '<button id="modal-close" aria-label="Close" style="border:none; padding:0; width:44px; height:44px; font-size:18px; flex-shrink:0;">\u2715</button>' +
      "</div>" +
      bodyHtml +
    "</div>" +
  "</div>";
}

function supervisorFieldHtml(prefix, val, otherName) {
  return '<div class="field-group">' +
    '<label class="field-label">Supervisor</label>' +
    '<select id="' + prefix + '-supervisor">' +
      '<option value="mike"' + (val === "mike" ? " selected" : "") + ">Mike</option>" +
      '<option value="amy"' + (val === "amy" ? " selected" : "") + ">Amy</option>" +
      '<option value="other"' + (val === "other" ? " selected" : "") + ">Other adult</option>" +
    "</select>" +
    '<input id="' + prefix + '-supervisor-name" placeholder="Name" value="' + (otherName || "").replace(/"/g, "&quot;") + '" style="margin-top:6px; display:' + (val === "other" ? "block" : "none") + ';">' +
  "</div>";
}

function wireSupervisorToggle(prefix) {
  const sel = document.getElementById(prefix + "-supervisor");
  const nameInput = document.getElementById(prefix + "-supervisor-name");
  sel.addEventListener("change", () => {
    nameInput.style.display = sel.value === "other" ? "block" : "none";
  });
}

function readSupervisor(prefix) {
  const sel = document.getElementById(prefix + "-supervisor").value;
  const name = document.getElementById(prefix + "-supervisor-name").value.trim();
  return { supervisor: sel, supervisorName: sel === "other" ? name : "" };
}

function attachCloseHandler() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
}

function openStartModal() {
  const now = new Date();
  const body =
    '<div class="field-group">' +
      '<label class="field-label">Start time</label>' +
      '<div class="two-col">' +
        '<input type="date" id="start-date" value="' + fmtDateInput(now) + '">' +
        '<input type="time" id="start-time" value="' + fmtTimeInput(now) + '">' +
      "</div>" +
    "</div>" +
    supervisorFieldHtml("start", "", "") +
    '<div class="field-group">' +
      '<label class="field-label">Notes (optional)</label>' +
      '<input id="start-notes" placeholder="Highway practice, rain, etc.">' +
    "</div>" +
    '<button id="start-confirm" class="btn-primary">Start drive</button>';
  document.getElementById("modal-root").innerHTML = modalShell("Start drive", body);
  attachCloseHandler();
  wireSupervisorToggle("start");
  document.getElementById("start-confirm").addEventListener("click", async () => {
    const dt = combineDateTime(document.getElementById("start-date").value, document.getElementById("start-time").value);
    if (!dt) return;
    const sup = readSupervisor("start");
    state.active = {
      startTime: dt.getTime(),
      supervisor: sup.supervisor,
      supervisorName: sup.supervisorName,
      notes: document.getElementById("start-notes").value.trim()
    };
    await saveActive();
    closeModal();
  });
}

function openStopModal() {
  if (!state.active) return;
  const now = new Date();
  const startNote = (state.active.notes || "").trim();
  const body =
    '<div class="field-group">' +
      '<label class="field-label">End time</label>' +
      '<div class="two-col">' +
        '<input type="date" id="stop-date" value="' + fmtDateInput(now) + '">' +
        '<input type="time" id="stop-time" value="' + fmtTimeInput(now) + '">' +
      "</div>" +
    "</div>" +
    (startNote ? '<div class="field-group"><div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Note from start: ' + startNote.replace(/</g, "&lt;") + '</div></div>' : "") +
    '<div class="field-group">' +
      '<label class="field-label">' + (startNote ? "Closing note (optional)" : "Notes (optional)") + '</label>' +
      '<input id="stop-notes" placeholder="' + (startNote ? "Append to start note…" : "Highway practice, rain, etc.") + '">' +
    "</div>" +
    '<button id="stop-confirm" class="btn-primary">Save and finish drive</button>';
  document.getElementById("modal-root").innerHTML = modalShell("Stop drive", body);
  attachCloseHandler();
  document.getElementById("stop-confirm").addEventListener("click", async () => {
    const dt = combineDateTime(document.getElementById("stop-date").value, document.getElementById("stop-time").value);
    if (!dt) return;
    const endMs = dt.getTime();
    const startMs = state.active.startTime;
    if (endMs <= startMs) { alert("End time must be after start time."); return; }
    const split = splitDayNight(startMs, endMs, state.config.lat, state.config.lon);
    const stopNote = document.getElementById("stop-notes").value.trim();
    const combinedNote = startNote && stopNote ? startNote + " — " + stopNote : startNote || stopNote;
    const entry = {
      id: uid(),
      schemaVersion: SCHEMA_VERSION,
      startTime: startMs,
      endTime: endMs,
      sortTime: startMs,
      dayMinutes: split.day,
      nightMinutes: split.night,
      supervisor: state.active.supervisor,
      supervisorName: state.active.supervisorName,
      notes: combinedNote
    };
    await saveDrive(entry);
    state.active = null;
    await saveActive();
    closeModal();
  });
}

function openFixActiveModal() {
  if (!state.active) return;
  const startD = new Date(state.active.startTime);
  const body =
    '<div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">Started ' + fmtDisplayDate(startD) + " at " + fmtDisplayTime(startD) + ". Close this out by entering when it actually ended, or just enter a total duration if you do not remember the exact time.</div>" +
    '<div style="display:flex; gap:8px; margin-bottom:14px;">' +
      '<button id="fix-mode-time" style="flex:1;">Enter end time</button>' +
      '<button id="fix-mode-duration" style="flex:1;">Enter duration</button>' +
    "</div>" +
    '<div id="fix-body"></div>';
  document.getElementById("modal-root").innerHTML = modalShell("Forgot to stop this drive", body);
  attachCloseHandler();

  const fixStartNote = (state.active.notes || "").trim();
  function showTimeMode() {
    const now = new Date();
    document.getElementById("fix-body").innerHTML =
      '<div class="field-group">' +
        '<label class="field-label">End time</label>' +
        '<div class="two-col">' +
          '<input type="date" id="fix-date" value="' + fmtDateInput(now) + '">' +
          '<input type="time" id="fix-time" value="' + fmtTimeInput(now) + '">' +
        "</div>" +
      "</div>" +
      (fixStartNote ? '<div class="field-group"><div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Note from start: ' + fixStartNote.replace(/</g, "&lt;") + '</div></div>' : "") +
      '<div class="field-group">' +
        '<label class="field-label">' + (fixStartNote ? "Closing note (optional)" : "Notes (optional)") + '</label>' +
        '<input id="fix-notes" placeholder="' + (fixStartNote ? "Append to start note…" : "Highway practice, rain, etc.") + '">' +
      "</div>" +
      '<button id="fix-confirm" class="btn-primary">Save and close drive</button>';
    document.getElementById("fix-confirm").addEventListener("click", async () => {
      const dt = combineDateTime(document.getElementById("fix-date").value, document.getElementById("fix-time").value);
      if (!dt) return;
      const endMs = dt.getTime();
      const startMs = state.active.startTime;
      if (endMs <= startMs) { alert("End time must be after start time."); return; }
      const split = splitDayNight(startMs, endMs, state.config.lat, state.config.lon);
      const fixStopNote = document.getElementById("fix-notes").value.trim();
      const fixCombinedNote = fixStartNote && fixStopNote ? fixStartNote + " — " + fixStopNote : fixStartNote || fixStopNote;
      const entry = {
        id: uid(), schemaVersion: SCHEMA_VERSION,
        startTime: startMs, endTime: endMs, sortTime: startMs,
        dayMinutes: split.day, nightMinutes: split.night,
        supervisor: state.active.supervisor, supervisorName: state.active.supervisorName,
        notes: fixCombinedNote
      };
      await saveDrive(entry);
      state.active = null;
      await saveActive();
      closeModal();
    });
  }
  function showDurationMode() {
    document.getElementById("fix-body").innerHTML =
      '<div class="field-group">' +
        '<label class="field-label">Total minutes driven</label>' +
        '<input type="number" id="fix-minutes" min="1" placeholder="45">' +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">Classify as</label>' +
        '<select id="fix-class"><option value="day">Day</option><option value="night">Night</option></select>' +
      "</div>" +
      (fixStartNote ? '<div class="field-group"><div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Note from start: ' + fixStartNote.replace(/</g, "&lt;") + '</div></div>' : "") +
      '<div class="field-group">' +
        '<label class="field-label">' + (fixStartNote ? "Closing note (optional)" : "Notes (optional)") + '</label>' +
        '<input id="fix-notes-dur" placeholder="' + (fixStartNote ? "Append to start note…" : "Highway practice, rain, etc.") + '">' +
      "</div>" +
      '<button id="fix-confirm-dur" class="btn-primary">Save and close drive</button>';
    document.getElementById("fix-confirm-dur").addEventListener("click", async () => {
      const mins = parseInt(document.getElementById("fix-minutes").value, 10);
      if (!mins || mins <= 0) { alert("Enter a valid number of minutes."); return; }
      const cls = document.getElementById("fix-class").value;
      const fixDurNote = document.getElementById("fix-notes-dur").value.trim();
      const fixDurCombined = fixStartNote && fixDurNote ? fixStartNote + " — " + fixDurNote : fixStartNote || fixDurNote;
      const entry = {
        id: uid(), schemaVersion: SCHEMA_VERSION,
        manualDate: state.active.startTime, sortTime: state.active.startTime,
        manualMinutes: mins, manualClass: cls,
        dayMinutes: cls === "day" ? mins : 0,
        nightMinutes: cls === "night" ? mins : 0,
        supervisor: state.active.supervisor, supervisorName: state.active.supervisorName,
        notes: fixDurCombined
      };
      await saveDrive(entry);
      state.active = null;
      await saveActive();
      closeModal();
    });
  }
  document.getElementById("fix-mode-time").addEventListener("click", showTimeMode);
  document.getElementById("fix-mode-duration").addEventListener("click", showDurationMode);
  showTimeMode();
}

function openManualModal() {
  const now = new Date();
  const body =
    '<div style="display:flex; gap:8px; margin-bottom:14px;">' +
      '<button id="manual-mode-time" style="flex:1;">Start and end time</button>' +
      '<button id="manual-mode-duration" style="flex:1;">Date and minutes</button>' +
    "</div>" +
    '<div id="manual-body"></div>';
  document.getElementById("modal-root").innerHTML = modalShell("Add past drive", body);
  attachCloseHandler();

  function showTimeMode() {
    document.getElementById("manual-body").innerHTML =
      '<div class="field-group">' +
        '<label class="field-label">Start</label>' +
        '<div class="two-col">' +
          '<input type="date" id="m-start-date" value="' + fmtDateInput(now) + '">' +
          '<input type="time" id="m-start-time" value="08:00">' +
        "</div>" +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">End</label>' +
        '<div class="two-col">' +
          '<input type="date" id="m-end-date" value="' + fmtDateInput(now) + '">' +
          '<input type="time" id="m-end-time" value="08:30">' +
        "</div>" +
      "</div>" +
      supervisorFieldHtml("m", "", "") +
      '<div class="field-group">' +
        '<label class="field-label">Notes (optional)</label>' +
        '<input id="m-notes" placeholder="Highway practice, rain, etc.">' +
      "</div>" +
      '<button id="m-confirm-time" class="btn-primary">Save drive</button>';
    wireSupervisorToggle("m");
    document.getElementById("m-confirm-time").addEventListener("click", async () => {
      const startDt = combineDateTime(document.getElementById("m-start-date").value, document.getElementById("m-start-time").value);
      const endDt = combineDateTime(document.getElementById("m-end-date").value, document.getElementById("m-end-time").value);
      if (!startDt || !endDt || endDt.getTime() <= startDt.getTime()) { alert("End must be after start."); return; }
      const split = splitDayNight(startDt.getTime(), endDt.getTime(), state.config.lat, state.config.lon);
      const sup = readSupervisor("m");
      const entry = {
        id: uid(), schemaVersion: SCHEMA_VERSION,
        startTime: startDt.getTime(), endTime: endDt.getTime(), sortTime: startDt.getTime(),
        dayMinutes: split.day, nightMinutes: split.night,
        supervisor: sup.supervisor, supervisorName: sup.supervisorName,
        notes: document.getElementById("m-notes").value.trim()
      };
      await saveDrive(entry);
      closeModal();
    });
  }
  function showDurationMode() {
    document.getElementById("manual-body").innerHTML =
      '<div class="field-group">' +
        '<label class="field-label">Date</label>' +
        '<input type="date" id="m-date" value="' + fmtDateInput(now) + '">' +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">Total minutes driven</label>' +
        '<input type="number" id="m-minutes" min="1" placeholder="45">' +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">Classify as</label>' +
        '<select id="m-class"><option value="day">Day</option><option value="night">Night</option></select>' +
      "</div>" +
      supervisorFieldHtml("m", "", "") +
      '<div class="field-group">' +
        '<label class="field-label">Notes (optional)</label>' +
        '<input id="m-notes" placeholder="Highway practice, rain, etc.">' +
      "</div>" +
      '<button id="m-confirm-dur" class="btn-primary">Save drive</button>';
    wireSupervisorToggle("m");
    document.getElementById("m-confirm-dur").addEventListener("click", async () => {
      const dateVal = document.getElementById("m-date").value;
      const mins = parseInt(document.getElementById("m-minutes").value, 10);
      if (!dateVal) { alert("Enter a date."); return; }
      if (!mins || mins <= 0) { alert("Enter a valid number of minutes."); return; }
      const cls = document.getElementById("m-class").value;
      const sup = readSupervisor("m");
      const dt = combineDateTime(dateVal, "12:00");
      const entry = {
        id: uid(), schemaVersion: SCHEMA_VERSION,
        manualDate: dt.getTime(), sortTime: dt.getTime(),
        manualMinutes: mins, manualClass: cls,
        dayMinutes: cls === "day" ? mins : 0,
        nightMinutes: cls === "night" ? mins : 0,
        supervisor: sup.supervisor, supervisorName: sup.supervisorName,
        notes: document.getElementById("m-notes").value.trim()
      };
      await saveDrive(entry);
      closeModal();
    });
  }
  document.getElementById("manual-mode-time").addEventListener("click", showTimeMode);
  document.getElementById("manual-mode-duration").addEventListener("click", showDurationMode);
  showTimeMode();
}

function openEditModal(entry) {
  const isTimed = !!(entry.startTime && entry.endTime);
  let body = "";
  if (isTimed) {
    const sD = new Date(entry.startTime), eD = new Date(entry.endTime);
    body =
      '<div class="field-group">' +
        '<label class="field-label">Start</label>' +
        '<div class="two-col">' +
          '<input type="date" id="e-start-date" value="' + fmtDateInput(sD) + '">' +
          '<input type="time" id="e-start-time" value="' + fmtTimeInput(sD) + '">' +
        "</div>" +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">End</label>' +
        '<div class="two-col">' +
          '<input type="date" id="e-end-date" value="' + fmtDateInput(eD) + '">' +
          '<input type="time" id="e-end-time" value="' + fmtTimeInput(eD) + '">' +
        "</div>" +
      "</div>";
  } else {
    const mD = new Date(entry.manualDate);
    body =
      '<div class="field-group">' +
        '<label class="field-label">Date</label>' +
        '<input type="date" id="e-m-date" value="' + fmtDateInput(mD) + '">' +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">Total minutes driven</label>' +
        '<input type="number" id="e-m-minutes" min="1" value="' + entry.manualMinutes + '">' +
      "</div>" +
      '<div class="field-group">' +
        '<label class="field-label">Classify as</label>' +
        '<select id="e-m-class">' +
          '<option value="day"' + (entry.manualClass === "day" ? " selected" : "") + ">Day</option>" +
          '<option value="night"' + (entry.manualClass === "night" ? " selected" : "") + ">Night</option>" +
        "</select>" +
      "</div>";
  }
  body += supervisorFieldHtml("e", entry.supervisor, entry.supervisorName);
  body +=
    '<div class="field-group">' +
      '<label class="field-label">Notes (optional)</label>' +
      '<input id="e-notes" value="' + (entry.notes || "").replace(/"/g, "&quot;") + '">' +
    "</div>" +
    '<button id="e-save" class="btn-primary" style="margin-bottom:8px;">Save changes</button>' +
    '<button id="e-delete" class="btn-danger" style="width:100%;">Delete entry</button>';
  document.getElementById("modal-root").innerHTML = modalShell("Edit drive", body);
  attachCloseHandler();
  wireSupervisorToggle("e");

  document.getElementById("e-save").addEventListener("click", async () => {
    const sup = readSupervisor("e");
    entry.supervisor = sup.supervisor;
    entry.supervisorName = sup.supervisorName;
    entry.notes = document.getElementById("e-notes").value.trim();
    if (isTimed) {
      const startDt = combineDateTime(document.getElementById("e-start-date").value, document.getElementById("e-start-time").value);
      const endDt = combineDateTime(document.getElementById("e-end-date").value, document.getElementById("e-end-time").value);
      if (!startDt || !endDt || endDt.getTime() <= startDt.getTime()) { alert("End must be after start."); return; }
      const split = splitDayNight(startDt.getTime(), endDt.getTime(), state.config.lat, state.config.lon);
      entry.startTime = startDt.getTime();
      entry.endTime = endDt.getTime();
      entry.sortTime = startDt.getTime();
      entry.dayMinutes = split.day;
      entry.nightMinutes = split.night;
    } else {
      const dateVal = document.getElementById("e-m-date").value;
      const mins = parseInt(document.getElementById("e-m-minutes").value, 10);
      if (!mins || mins <= 0) { alert("Enter a valid number of minutes."); return; }
      const cls = document.getElementById("e-m-class").value;
      const dt = combineDateTime(dateVal, "12:00");
      entry.manualDate = dt.getTime();
      entry.sortTime = dt.getTime();
      entry.manualMinutes = mins;
      entry.manualClass = cls;
      entry.dayMinutes = cls === "day" ? mins : 0;
      entry.nightMinutes = cls === "night" ? mins : 0;
    }
    await saveDrive(entry);
    closeModal();
  });

  document.getElementById("e-delete").addEventListener("click", async () => {
    if (!confirm("Delete this drive entry? This cannot be undone.")) return;
    await deleteDrive(entry.id);
    closeModal();
  });
}

function exportCsv() {
  const rows = [["Date", "Start time", "End time", "Total minutes", "Day minutes", "Night minutes", "Supervisor", "Notes"]];
  const sorted = state.drives.slice().sort((a, b) => (a.sortTime || 0) - (b.sortTime || 0));
  sorted.forEach((d) => {
    let dateStr, startStr, endStr;
    if (d.startTime && d.endTime) {
      const sD = new Date(d.startTime), eD = new Date(d.endTime);
      dateStr = fmtDateInput(sD);
      startStr = sD.toISOString();
      endStr = eD.toISOString();
    } else {
      dateStr = fmtDateInput(new Date(d.manualDate));
      startStr = "";
      endStr = "";
    }
    const total = Math.round((d.dayMinutes || 0) + (d.nightMinutes || 0));
    rows.push([
      dateStr, startStr, endStr, total,
      Math.round(d.dayMinutes || 0), Math.round(d.nightMinutes || 0),
      supervisorLabel(d), (d.notes || "").replace(/"/g, '""')
    ]);
  });
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "driving-log.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function showSignInScreen() {
  document.getElementById("app-root").style.display = "none";
  document.getElementById("auth-root").innerHTML =
    '<div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:2rem;">' +
      '<div style="text-align:center; max-width:320px; width:100%;">' +
        '<div style="font-size:40px; margin-bottom:1rem;">🚗</div>' +
        '<h1 style="font-size:20px; font-weight:500; margin:0 0 0.5rem;">Driving log</h1>' +
        '<p style="font-size:14px; color:var(--text-secondary); margin:0 0 2rem;">Sign in to track your family\'s supervised driving hours.</p>' +
        '<button id="btn-google-signin" style="display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:12px; font-size:15px;">' +
          '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">' +
            '<path fill="#4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z"/>' +
            '<path fill="#34A853" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 0 1-7.18-2.54H1.83v2.07A8 8 0 0 0 8.98 17z"/>' +
            '<path fill="#FBBC05" d="M4.5 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18l2.67-2.07z"/>' +
            '<path fill="#EA4335" d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.5 7.49a4.77 4.77 0 0 1 4.48-3.3z"/>' +
          '</svg>' +
          'Sign in with Google' +
        '</button>' +
      '</div>' +
    '</div>';
  document.getElementById("btn-google-signin").addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user") {
        alert("Sign-in failed: " + e.message);
      }
    }
  });
}

function showWrongAccountScreen(user) {
  document.getElementById("app-root").style.display = "none";
  document.getElementById("auth-root").innerHTML =
    '<div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:2rem;">' +
      '<div style="text-align:center; max-width:380px; width:100%;">' +
        '<div style="font-size:48px; margin-bottom:1rem;">🚧</div>' +
        '<h2 style="font-size:18px; font-weight:500; margin:0 0 0.75rem;">Wrong driver\'s seat</h2>' +
        '<p style="font-size:14px; color:var(--text-secondary); margin:0 0 0.75rem;">You\'re signed in as <strong>' + user.email + '</strong>, but this log is a private Snow family operation — teen driver, worried parents, the whole deal.</p>' +
        '<p style="font-size:14px; color:var(--text-secondary); margin:0 0 1.5rem;">The good news: the code is open source on GitHub. Fork it, set up your own Firebase project, and you too can obsessively log every left turn your teenager makes. 🎉</p>' +
        '<button id="btn-wrong-signout" style="width:100%;">Sign out and try another account</button>' +
      '</div>' +
    '</div>';
  document.getElementById("btn-wrong-signout").addEventListener("click", () => signOut(auth));
}

function showAccountBar(user) {
  const bar = document.getElementById("account-bar");
  bar.innerHTML =
    '<span>' + (user.displayName || user.email) + '</span>' +
    '<span style="color:var(--border-strong);">·</span>' +
    '<button id="btn-signout" style="background:none; border:none; padding:0; font-size:12px; color:var(--text-muted); cursor:pointer; text-decoration:underline; font-family:inherit;">Sign out</button>';
  document.getElementById("btn-signout").addEventListener("click", () => signOut(auth));
  bar.style.display = "flex";
}

let appInitialized = false;
function initApp(user) {
  document.getElementById("auth-root").innerHTML = "";
  document.getElementById("app-root").style.display = "block";
  showAccountBar(user);
  if (appInitialized) return;
  appInitialized = true;
  document.getElementById("btn-start").addEventListener("click", openStartModal);
  document.getElementById("btn-stop-now").addEventListener("click", openStopModal);
  document.getElementById("btn-fix-active").addEventListener("click", openFixActiveModal);
  document.getElementById("btn-manual").addEventListener("click", openManualModal);
  document.getElementById("btn-export").addEventListener("click", exportCsv);
  document.getElementById("btn-settings").addEventListener("click", openSettingsModal);
  listenForConfig();
  listenForChanges();
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    appInitialized = false;
    showSignInScreen();
  } else if (!ALLOWED_EMAILS.includes(user.email)) {
    showWrongAccountScreen(user);
  } else {
    initApp(user);
  }
});
