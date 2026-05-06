"use strict";

/* =========================================================================
 * Configuration
 * ========================================================================= */

const CONFIG = {
  // Paste your OAuth 2.0 Client ID here. See README for setup steps.
  GOOGLE_CLIENT_ID: "",
  GOOGLE_SCOPE: "https://www.googleapis.com/auth/calendar.events",
  CALENDAR_ID: "primary",

  WEATHER_URL:
    "https://api.open-meteo.com/v1/forecast" +
    "?latitude=45.5088&longitude=-73.5878" +
    "&current_weather=true" +
    "&hourly=relativehumidity_2m" +
    "&daily=temperature_2m_max,temperature_2m_min" +
    "&timezone=America/Toronto&forecast_days=1",

  WEATHER_REFRESH_MS: 5 * 60 * 1000,
  WEATHER_TAP_DEBOUNCE_MS: 10 * 1000,
  WEATHER_STALE_MS: 6 * 60 * 60 * 1000,

  TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000, // refresh 5 min before expiry

  TIMEZONE: "America/Toronto",
};

/* =========================================================================
 * State
 * ========================================================================= */

const state = {
  viewedYear: 0,
  viewedMonth: 0, // 0-11
  events: [],     // Google Calendar events for the viewed month
  weather: null,
  weatherFetchedAt: 0,
  weatherRefreshing: false,
  lastWeatherTap: 0,
  selectedDateKey: null, // 'YYYY-MM-DD' when day panel open

  auth: {
    tokenClient: null,
    accessToken: null,
    expiresAt: 0,
    refreshTimer: null,
  },
};

/* =========================================================================
 * DOM refs
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

const dom = {
  clockTime: $("clock-time"),
  clockDate: $("clock-date"),

  weather: $("weather"),
  weatherLabel: $("weather-label"),
  weatherTemp: $("weather-temp"),
  weatherDesc: $("weather-desc"),
  weatherHilo: $("weather-hilo"),
  weatherWind: $("weather-wind"),
  weatherHumidity: $("weather-humidity"),

  calTitle: $("cal-title"),
  calPrev: $("cal-prev"),
  calNext: $("cal-next"),
  calGrid: $("cal-grid"),
  calOverlay: $("cal-overlay"),
  calOverlayMsg: $("cal-overlay-msg"),
  calConnect: $("cal-connect"),

  dayPanel: $("day-panel"),
  dayPanelTitle: $("day-panel-title"),
  dayPanelClose: $("day-panel-close"),
  dayAdd: $("day-add"),
  dayEvents: $("day-events"),

  dayForm: $("day-form"),
  formTitle: $("form-title"),
  formAllday: $("form-allday"),
  formStart: $("form-start"),
  formEnd: $("form-end"),
  formTimesRow: $("form-times-row"),
  formColors: document.querySelectorAll(".swatch"),
  formError: $("form-error"),
  formCancel: $("form-cancel"),
  formSave: $("form-save"),
};

/* =========================================================================
 * Utilities
 * ========================================================================= */

function pad2(n) { return String(n).padStart(2, "0"); }

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
}

const lsGet = (k) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
  catch { return null; }
};

const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

/* =========================================================================
 * Clock
 * ========================================================================= */

function tickClock() {
  const now = new Date();
  dom.clockTime.textContent =
    pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
  dom.clockDate.textContent = new Intl.DateTimeFormat("en-CA", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(now);
}

function startClock() {
  tickClock();
  const drift = 1000 - (Date.now() % 1000);
  setTimeout(() => {
    tickClock();
    setInterval(tickClock, 1000);
  }, drift);
}

/* =========================================================================
 * Weather
 * ========================================================================= */

const WMO = {
  0: "Clear",
  1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers", 81: "Heavy rain showers", 82: "Violent rain showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
};

function renderWeather(payload, opts = {}) {
  if (!payload) {
    dom.weatherTemp.textContent = "—°";
    dom.weatherDesc.textContent = "Offline";
    dom.weatherLabel.innerHTML = `Weather <span style="color:var(--muted)">· offline</span>`;
    dom.weatherHilo.textContent = "—/—";
    dom.weatherWind.textContent = "—";
    dom.weatherHumidity.textContent = "—";
    return;
  }
  const cw = payload.current_weather || {};
  const daily = payload.daily || {};
  const hourly = payload.hourly || {};

  const temp = Math.round(cw.temperature);
  const code = cw.weathercode;
  const wind = Math.round(cw.windspeed);
  const hi = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null;
  const lo = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null;

  let humidity = "—";
  if (hourly.time && hourly.relativehumidity_2m) {
    const nowKey = new Date().toISOString().slice(0, 13);
    let idx = hourly.time.findIndex(t => t.startsWith(nowKey));
    if (idx === -1) idx = 0;
    humidity = `${hourly.relativehumidity_2m[idx]}%`;
  }

  dom.weatherTemp.textContent = `${temp}°`;
  dom.weatherDesc.textContent = WMO[code] ?? "—";
  dom.weatherHilo.textContent = (hi != null && lo != null) ? `${hi}°/${lo}°` : "—/—";
  dom.weatherWind.textContent = `${wind} km/h`;
  dom.weatherHumidity.textContent = humidity;

  dom.weatherLabel.innerHTML = opts.stale
    ? `<span class="stale-dot"></span>Weather`
    : `Weather`;
}

async function fetchWeather() {
  state.weatherRefreshing = true;
  dom.weather.classList.add("is-refreshing");
  try {
    const r = await fetch(CONFIG.WEATHER_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const payload = await r.json();
    state.weather = payload;
    state.weatherFetchedAt = Date.now();
    lsSet("weather_last", { payload, fetchedAt: state.weatherFetchedAt });
    renderWeather(payload, { stale: false });
  } catch (err) {
    console.warn("[weather] fetch failed:", err);
    const cached = lsGet("weather_last");
    if (cached && Date.now() - cached.fetchedAt < CONFIG.WEATHER_STALE_MS) {
      renderWeather(cached.payload, { stale: true });
    } else {
      renderWeather(null);
    }
  } finally {
    state.weatherRefreshing = false;
    dom.weather.classList.remove("is-refreshing");
  }
}

function startWeather() {
  const cached = lsGet("weather_last");
  if (cached) {
    state.weather = cached.payload;
    state.weatherFetchedAt = cached.fetchedAt;
    const stale = Date.now() - cached.fetchedAt > CONFIG.WEATHER_REFRESH_MS;
    renderWeather(cached.payload, { stale });
  }
  fetchWeather();
  setInterval(fetchWeather, CONFIG.WEATHER_REFRESH_MS);

  dom.weather.addEventListener("click", () => {
    const now = Date.now();
    if (state.weatherRefreshing) return;
    if (now - state.lastWeatherTap < CONFIG.WEATHER_TAP_DEBOUNCE_MS) return;
    state.lastWeatherTap = now;
    fetchWeather();
  });
}

/* =========================================================================
 * Google auth (GIS token model)
 * ========================================================================= */

function isTokenValid() {
  return state.auth.accessToken && Date.now() < state.auth.expiresAt - 30_000;
}

function persistToken() {
  lsSet("gcal_auth", {
    accessToken: state.auth.accessToken,
    expiresAt: state.auth.expiresAt,
  });
}

function loadPersistedToken() {
  const saved = lsGet("gcal_auth");
  if (saved && saved.accessToken && saved.expiresAt > Date.now()) {
    state.auth.accessToken = saved.accessToken;
    state.auth.expiresAt = saved.expiresAt;
    return true;
  }
  return false;
}

function clearToken() {
  state.auth.accessToken = null;
  state.auth.expiresAt = 0;
  lsSet("gcal_auth", null);
  if (state.auth.refreshTimer) {
    clearTimeout(state.auth.refreshTimer);
    state.auth.refreshTimer = null;
  }
}

function scheduleSilentRefresh() {
  if (state.auth.refreshTimer) clearTimeout(state.auth.refreshTimer);
  const delay = Math.max(60_000, state.auth.expiresAt - Date.now() - CONFIG.TOKEN_REFRESH_BEFORE_MS);
  state.auth.refreshTimer = setTimeout(() => {
    requestToken({ silent: true }).catch(err => {
      console.warn("[auth] silent refresh failed:", err);
    });
  }, delay);
}

function ensureTokenClient() {
  if (state.auth.tokenClient) return state.auth.tokenClient;
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    throw new Error("Google Identity Services script not loaded yet");
  }
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    throw new Error("CONFIG.GOOGLE_CLIENT_ID is empty — see README for setup");
  }

  state.auth.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: CONFIG.GOOGLE_SCOPE,
    callback: () => {}, // overridden per-call
  });
  return state.auth.tokenClient;
}

function requestToken({ silent }) {
  return new Promise((resolve, reject) => {
    let client;
    try { client = ensureTokenClient(); }
    catch (e) { reject(e); return; }

    client.callback = (resp) => {
      if (resp && resp.access_token) {
        state.auth.accessToken = resp.access_token;
        const ttl = (resp.expires_in ? Number(resp.expires_in) : 3600) * 1000;
        state.auth.expiresAt = Date.now() + ttl;
        persistToken();
        scheduleSilentRefresh();
        showCalendarOverlay(false);
        resolve(resp.access_token);
      } else {
        reject(new Error(resp?.error || "No access token returned"));
      }
    };

    try {
      client.requestAccessToken({ prompt: silent ? "" : "consent" });
    } catch (e) {
      reject(e);
    }
  });
}

function showCalendarOverlay(show, msg) {
  if (!show) {
    dom.calOverlay.classList.add("hidden");
    return;
  }
  dom.calOverlayMsg.textContent = msg || "Connect Google Calendar";
  dom.calOverlay.classList.remove("hidden");
}

async function gcalFetch(url, opts = {}, retried = false) {
  if (!isTokenValid()) {
    try { await requestToken({ silent: true }); }
    catch { /* fall through to overlay below */ }
  }
  if (!isTokenValid()) {
    showCalendarOverlay(true);
    throw new Error("not_authenticated");
  }

  const headers = {
    ...(opts.headers || {}),
    Authorization: `Bearer ${state.auth.accessToken}`,
  };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const resp = await fetch(url, { ...opts, headers });
  if (resp.status === 401 && !retried) {
    clearToken();
    try { await requestToken({ silent: true }); }
    catch { showCalendarOverlay(true); throw new Error("not_authenticated"); }
    return gcalFetch(url, opts, true);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`gcal ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/* =========================================================================
 * Calendar — month grid + Google Calendar events
 * ========================================================================= */

function monthLabel(y, m) {
  return new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric" })
    .format(new Date(y, m, 1));
}

function classifyEventColor(ev) {
  // Google colorIds 9=blueberry, 10=basil(green), 5=banana(yellow). We map our
  // three offered colors to these. Fallback for events created elsewhere: blue.
  switch (ev.colorId) {
    case "9": return "blue";
    case "10": return "green";
    case "5": return "amber";
    case "11": return "amber"; // tomato → amber-ish
    case "2": return "green";  // sage
    default: return "default";
  }
}

function eventStart(ev) {
  if (ev.start?.dateTime) return new Date(ev.start.dateTime);
  if (ev.start?.date) {
    const [y, m, d] = ev.start.date.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return null;
}

function eventEnd(ev) {
  if (ev.end?.dateTime) return new Date(ev.end.dateTime);
  if (ev.end?.date) {
    // All-day end is exclusive in GCal: subtract 1ms so it stays on the last day.
    const [y, m, d] = ev.end.date.split("-").map(Number);
    return new Date(new Date(y, m - 1, d).getTime() - 1);
  }
  return null;
}

function eventsForDay(day) {
  const dayStart = startOfDay(day);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return state.events
    .filter(ev => {
      const s = eventStart(ev);
      const e = eventEnd(ev) || s;
      if (!s) return false;
      return s < dayEnd && e >= dayStart;
    })
    .sort((a, b) => {
      const as = eventStart(a)?.getTime() || 0;
      const bs = eventStart(b)?.getTime() || 0;
      return as - bs;
    });
}

function renderCalendar() {
  const y = state.viewedYear;
  const m = state.viewedMonth;
  dom.calTitle.textContent = monthLabel(y, m);

  const firstOfMonth = new Date(y, m, 1);
  const startWeekday = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(y, m, 1 - startWeekday);
  const today = new Date();

  dom.calGrid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);

    const cell = document.createElement("button");
    cell.className = "cal-cell";
    cell.type = "button";
    if (cellDate.getMonth() !== m) cell.classList.add("is-othermonth");
    if (isSameDay(cellDate, today)) cell.classList.add("is-today");
    cell.dataset.date = dateKey(cellDate);

    const num = document.createElement("div");
    num.className = "cal-cell-num";
    num.textContent = String(cellDate.getDate());
    cell.appendChild(num);

    const evs = eventsForDay(cellDate);
    if (evs.length) {
      const dots = document.createElement("div");
      dots.className = "cal-event-dots";
      const visible = evs.slice(0, 3);
      for (const ev of visible) {
        const dot = document.createElement("span");
        dot.className = `dot dot--${classifyEventColor(ev)}`;
        dots.appendChild(dot);
      }
      if (evs.length > 3) {
        const more = document.createElement("span");
        more.className = "cal-event-more";
        more.textContent = `+${evs.length - 3}`;
        dots.appendChild(more);
      }
      cell.appendChild(dots);
    }

    cell.addEventListener("click", () => openDayPanel(cellDate));
    dom.calGrid.appendChild(cell);
  }
}

async function fetchEventsForViewedMonth() {
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    showCalendarOverlay(true, "Set GOOGLE_CLIENT_ID in app.js");
    return;
  }
  const timeMin = new Date(state.viewedYear, state.viewedMonth, 1).toISOString();
  const timeMax = new Date(state.viewedYear, state.viewedMonth + 1, 1).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events`
    + `?timeMin=${encodeURIComponent(timeMin)}`
    + `&timeMax=${encodeURIComponent(timeMax)}`
    + `&singleEvents=true&orderBy=startTime&maxResults=250`;

  try {
    const data = await gcalFetch(url);
    state.events = data.items || [];
    renderCalendar();
    if (state.selectedDateKey) {
      const [y, m, d] = state.selectedDateKey.split("-").map(Number);
      renderDayPanelEvents(new Date(y, m - 1, d));
    }
  } catch (err) {
    if (err.message === "not_authenticated") return;
    console.warn("[calendar] fetch failed:", err);
  }
}

function changeMonth(delta) {
  let m = state.viewedMonth + delta;
  let y = state.viewedYear;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  state.viewedMonth = m;
  state.viewedYear = y;
  state.events = [];
  renderCalendar();
  fetchEventsForViewedMonth();
}

/* =========================================================================
 * Day panel + add-event form
 * ========================================================================= */

function formatDayPanelTitle(d) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "long", month: "long", day: "numeric",
  }).format(d);
}

function formatEventTime(ev) {
  if (ev.start?.date) return "All day";
  const s = eventStart(ev);
  const e = eventEnd(ev);
  const fmt = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${fmt(s)} – ${fmt(e)}`;
}

function renderDayPanelEvents(d) {
  const evs = eventsForDay(d);
  dom.dayEvents.innerHTML = "";
  if (!evs.length) {
    const empty = document.createElement("div");
    empty.className = "day-empty";
    empty.textContent = "No events.";
    dom.dayEvents.appendChild(empty);
    return;
  }
  for (const ev of evs) {
    const row = document.createElement("div");
    row.className = "day-event";
    row.innerHTML = `
      <span class="day-event-stripe stripe--${classifyEventColor(ev)}"></span>
      <span class="day-event-time">${formatEventTime(ev)}</span>
      <span class="day-event-title">${(ev.summary || "(untitled)").replace(/</g, "&lt;")}</span>
    `;
    dom.dayEvents.appendChild(row);
  }
}

function openDayPanel(d) {
  state.selectedDateKey = dateKey(d);
  dom.dayPanelTitle.textContent = formatDayPanelTitle(d);
  hideForm();
  renderDayPanelEvents(d);
  dom.dayPanel.classList.remove("hidden");
  // Force reflow before adding is-open so the transform animates from 100%.
  void dom.dayPanel.offsetHeight;
  dom.dayPanel.classList.add("is-open");
}

function closeDayPanel() {
  dom.dayPanel.classList.remove("is-open");
  setTimeout(() => {
    dom.dayPanel.classList.add("hidden");
    state.selectedDateKey = null;
    hideForm();
  }, 220);
}

function showForm() {
  dom.dayEvents.classList.add("hidden");
  dom.dayAdd.classList.add("hidden");
  dom.dayForm.classList.remove("hidden");

  // Defaults
  const now = new Date();
  const startHour = now.getHours();
  const startMinute = now.getMinutes() < 30 ? 30 : 0;
  const startBase = new Date(now);
  if (startMinute === 0) startBase.setHours(startHour + 1);
  startBase.setMinutes(startMinute, 0, 0);

  // If the selected day is in the future, default to 09:00.
  let start = startBase;
  if (state.selectedDateKey) {
    const [y, m, d] = state.selectedDateKey.split("-").map(Number);
    const sel = new Date(y, m - 1, d);
    if (sel > startOfDay(new Date())) {
      start = new Date(y, m - 1, d, 9, 0, 0);
    }
  }
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  dom.formStart.value = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
  dom.formEnd.value = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
  dom.formTitle.value = "";
  dom.formAllday.checked = false;
  dom.formTimesRow.classList.remove("hidden");
  dom.formError.classList.add("hidden");
  selectSwatch("blue");
  setTimeout(() => dom.formTitle.focus(), 50);
}

function hideForm() {
  dom.dayForm.classList.add("hidden");
  dom.dayEvents.classList.remove("hidden");
  dom.dayAdd.classList.remove("hidden");
}

function selectSwatch(color) {
  dom.formColors.forEach(s => {
    s.classList.toggle("is-selected", s.dataset.color === color);
  });
}

function selectedColor() {
  const sel = Array.from(dom.formColors).find(s => s.classList.contains("is-selected"));
  return sel ? sel.dataset.color : "blue";
}

function colorToGoogleId(color) {
  return { blue: "9", green: "10", amber: "5" }[color] || "9";
}

function showFormError(msg) {
  dom.formError.textContent = msg;
  dom.formError.classList.remove("hidden");
}

async function submitForm(e) {
  e.preventDefault();
  if (!state.selectedDateKey) return;

  const title = dom.formTitle.value.trim();
  if (!title) { showFormError("Title is required."); return; }

  const allDay = dom.formAllday.checked;
  const [y, mo, d] = state.selectedDateKey.split("-").map(Number);
  let start, end;

  if (allDay) {
    start = { date: state.selectedDateKey };
    const next = new Date(y, mo - 1, d + 1);
    end = { date: dateKey(next) };
  } else {
    const [sh, sm] = dom.formStart.value.split(":").map(Number);
    const [eh, em] = dom.formEnd.value.split(":").map(Number);
    const startD = new Date(y, mo - 1, d, sh, sm, 0);
    const endD = new Date(y, mo - 1, d, eh, em, 0);
    if (endD <= startD) { showFormError("End time must be after start time."); return; }
    start = { dateTime: startD.toISOString(), timeZone: CONFIG.TIMEZONE };
    end   = { dateTime: endD.toISOString(),   timeZone: CONFIG.TIMEZONE };
  }

  const body = {
    summary: title,
    start, end,
    colorId: colorToGoogleId(selectedColor()),
  };

  dom.formSave.disabled = true;
  dom.formError.classList.add("hidden");

  try {
    const created = await gcalFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events`,
      { method: "POST", body: JSON.stringify(body) }
    );
    state.events.push(created);
    renderCalendar();
    const sel = new Date(y, mo - 1, d);
    renderDayPanelEvents(sel);
    hideForm();
  } catch (err) {
    if (err.message === "not_authenticated") {
      showFormError("Sign in expired — reconnect on the calendar.");
    } else {
      console.warn("[calendar] create failed:", err);
      showFormError("Couldn't save — check connection.");
    }
  } finally {
    dom.formSave.disabled = false;
  }
}

/* =========================================================================
 * Wire up UI events
 * ========================================================================= */

function wireEvents() {
  dom.calPrev.addEventListener("click", () => changeMonth(-1));
  dom.calNext.addEventListener("click", () => changeMonth(1));
  dom.calConnect.addEventListener("click", async () => {
    try {
      await requestToken({ silent: false });
      fetchEventsForViewedMonth();
    } catch (err) {
      console.warn("[auth] connect failed:", err);
    }
  });

  dom.dayPanelClose.addEventListener("click", closeDayPanel);
  dom.dayAdd.addEventListener("click", showForm);
  dom.formCancel.addEventListener("click", hideForm);
  dom.dayForm.addEventListener("submit", submitForm);

  dom.formAllday.addEventListener("change", () => {
    dom.formTimesRow.classList.toggle("hidden", dom.formAllday.checked);
  });

  dom.formColors.forEach(s => {
    s.addEventListener("click", () => selectSwatch(s.dataset.color));
  });
}

/* =========================================================================
 * Boot
 * ========================================================================= */

function init() {
  const now = new Date();
  state.viewedYear = now.getFullYear();
  state.viewedMonth = now.getMonth();

  startClock();
  startWeather();
  wireEvents();
  renderCalendar();

  if (!CONFIG.GOOGLE_CLIENT_ID) {
    showCalendarOverlay(true, "Set GOOGLE_CLIENT_ID in app.js");
    return;
  }

  if (loadPersistedToken()) {
    scheduleSilentRefresh();
    fetchEventsForViewedMonth();
  } else {
    // Try silent acquisition once GIS is ready; if it fails, show overlay.
    waitForGis().then(() => {
      requestToken({ silent: true })
        .then(() => fetchEventsForViewedMonth())
        .catch(() => showCalendarOverlay(true));
    }).catch(() => showCalendarOverlay(true, "Google sign-in script failed to load"));
  }
}

function waitForGis(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("GIS load timeout"));
      setTimeout(poll, 100);
    })();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
