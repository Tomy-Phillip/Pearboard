"use strict";

/* =========================================================================
 * Configuration
 * ========================================================================= */

const CONFIG = {
  // Proxied by MainActivity (IcsProxy) — the secret iCal address never reaches JS.
  ICS_URL: "/calendar.ics",
  ICS_REFRESH_MS: 10 * 60 * 1000,
  // Backstop for a worker that never answers; the first parse of a real feed
  // takes a few seconds on a Fire TV, so this is far above any honest call.
  WORKER_TIMEOUT_MS: 60 * 1000,

  WEATHER_URL:
    "https://api.open-meteo.com/v1/forecast" +
    "?latitude=45.5088&longitude=-73.5878" +
    "&current_weather=true" +
    "&hourly=temperature_2m,weathercode" +
    "&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset" +
    "&timezone=America/Toronto&forecast_days=2",

  HOURLY_HOURS: 6,
  NOTIF_MAX: 5,

  WEATHER_REFRESH_MS: 5 * 60 * 1000,
  WEATHER_TAP_DEBOUNCE_MS: 10 * 1000,
  WEATHER_STALE_MS: 6 * 60 * 60 * 1000,

  // Auto theme — light during the day, dark at night. Driven by Open-Meteo
  // sunrise/sunset when available, otherwise these fixed hours.
  THEME_AUTO: true,
  THEME_DAY_START: 7,   // hour, fallback only
  THEME_DAY_END: 19,    // hour, fallback only
};

/* =========================================================================
 * State
 * ========================================================================= */

const state = {
  viewedYear: 0,
  viewedMonth: 0, // 0-11
  events: [],      // occurrences overlapping the 42-day grid of the viewed month
  todayEvents: [], // today's occurrences, for the "Aujourd'hui" list
  hasCalendar: false, // the worker holds a successfully parsed feed
  icsFetchedAt: 0,
  icsOffline: false,
  focusedDateKey: null, // 'YYYY-MM-DD' of the D-pad focused cell
  refreshSeq: 0,   // drops worker replies for a month we've already left
  weather: null,
  weatherFetchedAt: 0,
  weatherRefreshing: false,
  lastWeatherTap: 0,
  selectedDateKey: null, // 'YYYY-MM-DD' when day panel open

  // Theme tracking — derived from sunrise/sunset (or fixed hour fallback).
  sunrise: null,  // ISO string
  sunset: null,   // ISO string
  appliedTheme: null,
};

/* =========================================================================
 * DOM refs
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

const dom = {
  clockTime: $("clock-time"),
  clockDate: $("clock-date"),

  weather: $("weather"),
  weatherTemp: $("weather-temp"),
  weatherDesc: $("weather-desc"),
  weatherMax: $("weather-max"),
  weatherMin: $("weather-min"),
  weatherIcon: $("weather-icon"),
  weatherHourly: $("weather-hourly"),

  notifList: $("notif-list"),

  calTitle: $("cal-title"),
  calStatus: $("cal-status"),
  calPrev: $("cal-prev"),
  calNext: $("cal-next"),
  calGrid: $("cal-grid"),
  calOverlay: $("cal-overlay"),
  calOverlayMsg: $("cal-overlay-msg"),

  dayPanel: $("day-panel"),
  dayPanelTitle: $("day-panel-title"),
  dayPanelClose: $("day-panel-close"),
  dayEvents: $("day-events"),
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
  catch (e) { return null; }
};

// Returns false when the write failed (quota, storage disabled); most callers ignore it.
const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
};

/* =========================================================================
 * Clock
 * ========================================================================= */

function tickClock() {
  const now = new Date();
  // Reference layout shows HH:MM (no seconds) — easier to read at a glance
  // and lets us run the layout big without a wide third digit pair.
  dom.clockTime.textContent = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  dom.clockDate.textContent = new Intl.DateTimeFormat("fr-CA", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(now);
  // Re-evaluate theme + refresh notifications on every minute boundary.
  // Cheap; theme only restyles when the result actually changes, and
  // notifications re-render quickly from in-memory state.todayEvents.
  if (now.getSeconds() === 0) {
    applyTheme();
    renderCalendarStatus();
    // Midnight: "today" moved — recompute today's list and the red square.
    if (now.getHours() === 0 && now.getMinutes() === 0) refreshEventsFromCalendar();
    else renderNotifications();
  }
}

function startClock() {
  tickClock();
  const drift = 1000 - (Date.now() % 1000);
  setTimeout(() => {
    tickClock();
    setInterval(tickClock, 1000);
  }, drift);
}

function applyTheme() {
  if (!CONFIG.THEME_AUTO) return;
  const now = new Date();
  let isDay;
  if (state.sunrise && state.sunset) {
    const sr = new Date(state.sunrise);
    const ss = new Date(state.sunset);
    isDay = now >= sr && now < ss;
  } else {
    const h = now.getHours();
    isDay = h >= CONFIG.THEME_DAY_START && h < CONFIG.THEME_DAY_END;
  }
  const next = isDay ? "light" : "dark";
  if (next !== state.appliedTheme) {
    document.documentElement.dataset.theme = next;
    state.appliedTheme = next;
  }
}

/* =========================================================================
 * Weather
 * ========================================================================= */

/* WMO weather code → inline SVG icon. Inline so it's offline-resilient
 * and themeable; each icon picks its own colors to stay distinct on dark bg. */
const WEATHER_ICONS = {
  sunny: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="11" fill="#ffd166"/>
      <g stroke="#ffb547" stroke-width="3" stroke-linecap="round">
        <line x1="32" y1="6"  x2="32" y2="13"/>
        <line x1="32" y1="51" x2="32" y2="58"/>
        <line x1="6"  y1="32" x2="13" y2="32"/>
        <line x1="51" y1="32" x2="58" y2="32"/>
        <line x1="13.7" y1="13.7" x2="18.6" y2="18.6"/>
        <line x1="45.4" y1="45.4" x2="50.3" y2="50.3"/>
        <line x1="13.7" y1="50.3" x2="18.6" y2="45.4"/>
        <line x1="45.4" y1="18.6" x2="50.3" y2="13.7"/>
      </g>
    </svg>`,
  partlyCloudy: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="22" cy="22" r="8" fill="#ffd166"/>
      <g stroke="#ffb547" stroke-width="2.4" stroke-linecap="round">
        <line x1="22" y1="6"  x2="22" y2="11"/>
        <line x1="6"  y1="22" x2="11" y2="22"/>
        <line x1="10.7" y1="10.7" x2="14.2" y2="14.2"/>
        <line x1="29.3" y1="10.7" x2="33"   y2="14.2"/>
      </g>
      <path d="M19 46c-5 0-9-4-9-9 0-5 4-8 8-9 1-7 7-12 14-12 8 0 14 6 14 14h2c5 0 9 4 9 9s-4 7-9 7H19z"
            fill="#7d8aa8"/>
    </svg>`,
  cloudy: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 50c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#9aa6c4"/>
    </svg>`,
  fog: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 36c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#9aa6c4" opacity="0.85"/>
      <g stroke="#c8d0e4" stroke-width="3" stroke-linecap="round">
        <line x1="10" y1="46" x2="54" y2="46"/>
        <line x1="6"  y1="54" x2="48" y2="54"/>
      </g>
    </svg>`,
  rain: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 38c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#7d8aa8"/>
      <g stroke="#6aa8ff" stroke-width="3" stroke-linecap="round">
        <line x1="20" y1="46" x2="17" y2="58"/>
        <line x1="32" y1="46" x2="29" y2="58"/>
        <line x1="44" y1="46" x2="41" y2="58"/>
      </g>
    </svg>`,
  snow: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 38c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#9aa6c4"/>
      <g fill="#e8f1ff">
        <circle cx="20" cy="52" r="2.6"/>
        <circle cx="32" cy="56" r="2.6"/>
        <circle cx="44" cy="52" r="2.6"/>
      </g>
    </svg>`,
  thunder: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 36c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#5e6a85"/>
      <polygon points="32,40 24,52 30,52 26,62 40,46 33,46 37,40" fill="#ffb547"/>
    </svg>`,
};

function pickWeatherIcon(code) {
  if (code === 0) return "sunny";
  if (code === 1 || code === 2) return "partlyCloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunder";
  return "cloudy";
}

const WMO = {
  0: "Ciel dégagé",
  1: "Plutôt dégagé", 2: "Partiellement nuageux", 3: "Couvert",
  45: "Brouillard", 48: "Brouillard givrant",
  51: "Bruine légère", 53: "Bruine", 55: "Bruine forte",
  56: "Bruine verglaçante", 57: "Bruine verglaçante forte",
  61: "Pluie légère", 63: "Pluie", 65: "Pluie forte",
  66: "Pluie verglaçante", 67: "Pluie verglaçante forte",
  71: "Neige légère", 73: "Neige", 75: "Neige forte",
  77: "Grains de neige",
  80: "Averses", 81: "Averses fortes", 82: "Averses violentes",
  85: "Averses de neige", 86: "Averses de neige fortes",
  95: "Orage",
  96: "Orage avec grêle", 99: "Orage violent avec grêle",
};

function renderWeather(payload, opts = {}) {
  if (!payload) {
    dom.weatherTemp.textContent = "—°";
    dom.weatherTemp.style.removeProperty("--temp-color");
    dom.weatherTemp.style.removeProperty("--temp-glow");
    dom.weatherDesc.textContent = "Hors ligne";
    dom.weatherMax.textContent = "—°";
    dom.weatherMin.textContent = "—°";
    dom.weatherIcon.innerHTML = "";
    if (dom.weatherHourly) dom.weatherHourly.innerHTML = "";
    return;
  }
  const cw = payload.current_weather || {};
  const daily = payload.daily || {};

  const temp = Math.round(cw.temperature);
  const code = cw.weathercode;
  const hi = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null;
  const lo = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null;

  dom.weatherTemp.textContent = `${temp}°`;
  const [tempColor, tempGlow] = tempPalette(temp);
  dom.weatherTemp.style.setProperty("--temp-color", tempColor);
  dom.weatherTemp.style.setProperty("--temp-glow", tempGlow);
  const desc = WMO[code] != null ? WMO[code] : "—";
  dom.weatherDesc.innerHTML = opts.stale
    ? `<span class="stale-dot"></span>${desc}`
    : desc;
  dom.weatherMax.textContent = hi != null ? `${hi}°` : "—°";
  dom.weatherMin.textContent = lo != null ? `${lo}°` : "—°";
  dom.weatherIcon.innerHTML = WEATHER_ICONS[pickWeatherIcon(code)] || "";

  renderHourly(payload.hourly);

  state.sunrise = (daily.sunrise && daily.sunrise[0]) || null;
  state.sunset  = (daily.sunset && daily.sunset[0])   || null;
  applyTheme();
}

function renderHourly(hourly) {
  if (!dom.weatherHourly) return;
  if (!hourly || !hourly.time || !hourly.temperature_2m) {
    dom.weatherHourly.innerHTML = "";
    return;
  }
  // Find current hour index in the hourly.time array (ISO strings without TZ).
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}`;
  let idx = hourly.time.findIndex(t => t.startsWith(nowKey));
  if (idx === -1) idx = 0;

  const count = CONFIG.HOURLY_HOURS;
  const slice = [];
  for (let i = 0; i < count; i++) {
    const j = idx + i;
    if (j >= hourly.time.length) break;
    slice.push({
      time: hourly.time[j],
      temp: Math.round(hourly.temperature_2m[j]),
      code: hourly.weathercode ? hourly.weathercode[j] : 0,
    });
  }

  dom.weatherHourly.innerHTML = slice.map(h => {
    // Open-Meteo's hourly.time is `YYYY-MM-DDTHH:MM` in the requested timezone.
    const hh = h.time.slice(11, 13);
    const label = `${Number(hh)}h`;
    const icon = WEATHER_ICONS[pickWeatherIcon(h.code)] || "";
    return `
      <div class="weather-hour">
        <span class="weather-hour-time">${label}</span>
        <span class="weather-hour-icon">${icon}</span>
        <span class="weather-hour-temp">${h.temp}°</span>
      </div>
    `;
  }).join("");
}

function tempPalette(t) {
  if (t <= -10) return ["#7fd8ff", "rgba(127,216,255,0.45)"];
  if (t <= 0) return ["#a3c4ff", "rgba(163,196,255,0.40)"];
  if (t <= 10) return ["#cfd9ff", "rgba(207,217,255,0.30)"];
  if (t <= 20) return ["#ffffff", "rgba(255,255,255,0.20)"];
  if (t <= 26) return ["#ffd47a", "rgba(255,212,122,0.40)"];
  if (t <= 32) return ["#ffa86a", "rgba(255,168,106,0.50)"];
  return ["#ff7a5e", "rgba(255,122,94,0.55)"];
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
 * Calendar worker — parses and expands the iCal feed off the UI thread
 * ========================================================================= */

let calendarWorker = null;
const workerPending = new Map(); // id → { resolve, reject, timer }
let workerNextId = 1;

// The worker itself broke (script failed to load, crashed, stopped answering),
// as opposed to the worker rejecting a bad feed. Shown as "Erreur du calendrier".
function workerFailure(message) {
  const err = new Error(message);
  err.workerFailure = true;
  return err;
}

// Drops a broken worker so the next call starts a fresh one. The fresh worker
// holds no feed, so the calendar counts as not loaded until the next fetch.
function recycleCalendarWorker(err) {
  if (calendarWorker) {
    calendarWorker.terminate();
    calendarWorker = null;
  }
  state.hasCalendar = false;
  workerPending.forEach((p) => {
    clearTimeout(p.timer);
    p.reject(err);
  });
  workerPending.clear();
}

function getCalendarWorker() {
  if (calendarWorker) return calendarWorker;
  calendarWorker = new Worker("calendar-worker.js");
  calendarWorker.onmessage = (e) => {
    const msg = e.data;
    const p = workerPending.get(msg.id);
    if (!p) return;
    workerPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "worker_error"));
  };
  calendarWorker.onerror = (e) => {
    console.warn("[calendar] worker error:", e.message || e);
    recycleCalendarWorker(workerFailure("worker_error: " + (e.message || "unknown")));
  };
  return calendarWorker;
}

function callWorker(msg) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = getCalendarWorker();
    } catch (e) {
      reject(workerFailure("worker_start: " + e));
      return;
    }
    const id = workerNextId++;
    const timer = setTimeout(() => {
      console.warn("[calendar] worker timed out on", msg.type);
      recycleCalendarWorker(workerFailure("worker_timeout"));
    }, CONFIG.WORKER_TIMEOUT_MS);
    workerPending.set(id, { resolve, reject, timer });
    worker.postMessage(Object.assign({ id }, msg));
  });
}

/* =========================================================================
 * Calendar data — iCal feed via MainActivity's /calendar.ics proxy
 * ========================================================================= */

function showCalendarOverlay(show, msg) {
  if (!show) {
    dom.calOverlay.classList.add("hidden");
    return;
  }
  dom.calOverlayMsg.textContent = msg || "Chargement du calendrier…";
  dom.calOverlay.classList.remove("hidden");
}

function gridRange(y, m) {
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()); // Sunday on or before the 1st
  const end = new Date(start);
  end.setDate(end.getDate() + 42);
  return [start, end];
}

function parseDateKey(key) {
  const p = key.split("-").map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

/* Renders right away from what we have (month changes stay instant), then asks
 * the worker for the viewed grid and today, and re-renders when it answers. */
function refreshEventsFromCalendar() {
  const seq = ++state.refreshSeq;
  renderCalendar();
  renderNotifications();
  if (!state.hasCalendar) return;

  const grid = gridRange(state.viewedYear, state.viewedMonth);
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  requestExpansion(seq, [
    [grid[0].getTime(), grid[1].getTime()],
    [today.getTime(), tomorrow.getTime()],
  ]);
}

/* Latest wins: at most one "between" is in flight. Holding a direction key on a
 * slow device would otherwise queue an expansion per month skimmed past; instead
 * only the newest request waits, and goes out when the in-flight one returns. */
const expansion = { busy: false, next: null }; // next: { seq, ranges }

function requestExpansion(seq, ranges) {
  if (expansion.busy) {
    expansion.next = { seq, ranges };
    return;
  }
  expansion.busy = true;
  callWorker({ type: "between", ranges }).then((result) => {
    if (seq !== state.refreshSeq) return; // a newer refresh (month change) superseded us
    state.events = result[0];
    state.todayEvents = result[1];
    renderCalendar();
    renderNotifications();
    if (state.selectedDateKey) renderDayPanelEvents(parseDateKey(state.selectedDateKey));
  }, (err) => {
    console.warn("[calendar] expansion failed:", err);
    if (err.workerFailure) showCalendarOverlay(true, "Erreur du calendrier");
  }).then(() => {
    expansion.busy = false;
    const next = expansion.next;
    expansion.next = null;
    // After a worker failure there's no feed to expand; the next fetch reloads one.
    if (next && state.hasCalendar) requestExpansion(next.seq, next.ranges);
  });
}

// Rejects on an invalid feed and leaves the previously loaded calendar in place.
// Resolves with whether the text differs from what the worker already held.
function loadIcsText(text, fetchedAt) {
  return callWorker({ type: "load", text }).then((result) => {
    state.hasCalendar = true;
    state.icsFetchedAt = fetchedAt;
    renderCalendarStatus();
    refreshEventsFromCalendar();
    return result.changed;
  });
}

function formatAge(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

function renderCalendarStatus() {
  if (!state.icsOffline) {
    dom.calStatus.classList.add("hidden");
    return;
  }
  dom.calStatus.textContent = state.icsFetchedAt
    ? `Hors ligne · mis à jour il y a ${formatAge(Date.now() - state.icsFetchedAt)}`
    : "Hors ligne";
  dom.calStatus.classList.remove("hidden");
}

async function fetchCalendar() {
  try {
    const r = await fetch(CONFIG.ICS_URL, { cache: "no-store" });
    if (r.status === 404) {
      // IcsProxy answers 404 when no ICAL_URL was set at build time.
      showCalendarOverlay(true, "Calendrier non configuré — voir README");
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const fetchedAt = Date.now();
    const changed = await loadIcsText(text, fetchedAt);
    // The feed can be several MB: rewrite it only when it changed, and keep the
    // timestamp under its own small key so the offline age stays right.
    if (changed && !lsSet("ics_text", text)) {
      console.warn("[calendar] could not cache the feed (storage full?)");
    }
    lsSet("ics_fetched_at", fetchedAt);
    state.icsOffline = false;
    showCalendarOverlay(false);
  } catch (err) {
    console.warn("[calendar] fetch failed:", err);
    if (err.workerFailure) {
      if (!state.hasCalendar) showCalendarOverlay(true, "Erreur du calendrier");
    } else {
      state.icsOffline = true;
      if (state.hasCalendar) showCalendarOverlay(false);
      else showCalendarOverlay(true, "Calendrier hors ligne");
    }
  } finally {
    renderCalendarStatus();
  }
}

function startCalendar() {
  // Show the last good feed right away; the fresh fetch replaces it when it lands.
  // The first fetch waits for the cached load to settle, so an offline start
  // doesn't flash "Calendrier hors ligne" before the cached calendar shows.
  const cachedText = lsGet("ics_text");
  const cachedLoaded = cachedText
    ? loadIcsText(cachedText, lsGet("ics_fetched_at") || 0)
      .then(() => showCalendarOverlay(false))
      .catch((err) => console.warn("[calendar] cached feed unusable:", err))
    : Promise.resolve();
  cachedLoaded.then(fetchCalendar);
  setInterval(fetchCalendar, CONFIG.ICS_REFRESH_MS);
}

/* =========================================================================
 * Calendar — month grid
 * ========================================================================= */

function monthLabel(y, m) {
  const s = new Intl.DateTimeFormat("fr-CA", { month: "long", year: "numeric" })
    .format(new Date(y, m, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function classifyEventColor(ev) {
  // iCal feeds don't carry Google's per-event colorId, so every event uses
  // the red accent of the reference layout.
  return "red";
}

function eventStart(ev) {
  const s = ev.start || {};
  if (s.dateTime) return new Date(s.dateTime);
  if (s.date) {
    const [y, m, d] = s.date.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return null;
}

function eventEnd(ev) {
  const e = ev.end || {};
  if (e.dateTime) return new Date(e.dateTime);
  if (e.date) {
    // All-day end is exclusive in GCal: subtract 1ms so it stays on the last day.
    const [y, m, d] = e.date.split("-").map(Number);
    return new Date(new Date(y, m - 1, d).getTime() - 1);
  }
  return null;
}

function eventStartMs(ev) {
  const s = eventStart(ev);
  return s ? s.getTime() : 0;
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
    .sort((a, b) => eventStartMs(a) - eventStartMs(b));
}

function renderCalendar() {
  const y = state.viewedYear;
  const m = state.viewedMonth;
  dom.calTitle.textContent = monthLabel(y, m);

  const gridStart = gridRange(y, m)[0];
  const today = new Date();

  // Short month labels for the inline marker on the first day of next month.
  const monthShort = (d) => {
    const s = new Intl.DateTimeFormat("fr-CA", { month: "short" }).format(d);
    // Trim trailing dot ("mai." → "mai") and capitalize.
    const trimmed = s.replace(/\.$/, "");
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  };

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

    const numRow = document.createElement("div");
    numRow.className = "cal-cell-num-row";

    const num = document.createElement("div");
    num.className = "cal-cell-num";
    num.textContent = String(cellDate.getDate());
    numRow.appendChild(num);

    // Inline next-month marker on day 1 of the next month (and on day 1 of
    // the current month when it's not the first cell of the grid).
    const isFirstOfMonth = cellDate.getDate() === 1;
    if (isFirstOfMonth && i > 0) {
      const lbl = document.createElement("span");
      lbl.className = "cal-cell-month";
      lbl.textContent = monthShort(cellDate);
      numRow.appendChild(lbl);
    }
    cell.appendChild(numRow);

    const evs = eventsForDay(cellDate);
    if (evs.length) {
      const list = document.createElement("div");
      list.className = "cal-event-list";
      const showAll = evs.length <= 3;
      const visibleCount = showAll ? evs.length : 2;
      for (const ev of evs.slice(0, visibleCount)) {
        const bar = document.createElement("div");
        bar.className = `cal-event-bar bar--${classifyEventColor(ev)}`;
        bar.textContent = ev.summary || "(sans titre)";
        bar.title = ev.summary || "";
        list.appendChild(bar);
      }
      if (!showAll) {
        const more = document.createElement("div");
        more.className = "cal-event-more";
        more.textContent = `+${evs.length - visibleCount} autres`;
        list.appendChild(more);
      }
      cell.appendChild(list);
    }

    cell.addEventListener("click", () => {
      state.focusedDateKey = cell.dataset.date;
      openDayPanel(cellDate);
    });
    dom.calGrid.appendChild(cell);
  }
  focusCell(state.focusedDateKey);
}

function renderNotifications() {
  if (!dom.notifList) return;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const upcoming = state.todayEvents
    .filter(ev => {
      const s = eventStart(ev);
      const e = eventEnd(ev) || s;
      if (!s) return false;
      // Show events that occur today and haven't ended yet.
      return s < tomorrow && e >= now;
    })
    .sort((a, b) => eventStartMs(a) - eventStartMs(b))
    .slice(0, CONFIG.NOTIF_MAX);

  if (!upcoming.length) {
    dom.notifList.innerHTML = `<div class="notif-empty">Aucun événement aujourd'hui</div>`;
    return;
  }

  dom.notifList.innerHTML = upcoming.map(ev => {
    const color = classifyEventColor(ev);
    const time = ev.start && ev.start.date
      ? "Toute la journée"
      : (() => {
          const s = eventStart(ev);
          return `${pad2(s.getHours())}:${pad2(s.getMinutes())}`;
        })();
    const title = (ev.summary || "(sans titre)").replace(/</g, "&lt;");
    return `
      <div class="notif notif--${color}">
        <span class="notif-time">${time}</span>
        <span class="notif-title">${title}</span>
      </div>
    `;
  }).join("");
}

// Switches the grid to another month; set state.focusedDateKey first.
function showMonth(y, m) {
  state.viewedYear = y;
  state.viewedMonth = m;
  state.events = []; // don't paint last month's events on the new grid while the worker answers
  refreshEventsFromCalendar(); // re-renders the grid, which restores focus
}

function changeMonth(delta) {
  const first = new Date(state.viewedYear, state.viewedMonth + delta, 1);
  state.focusedDateKey = dateKey(first);
  showMonth(first.getFullYear(), first.getMonth());
}

/* =========================================================================
 * Day panel
 * ========================================================================= */

function formatDayPanelTitle(d) {
  const s = new Intl.DateTimeFormat("fr-CA", {
    weekday: "long", month: "long", day: "numeric",
  }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatEventTime(ev) {
  if (ev.start && ev.start.date) return "Toute la journée";
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
    empty.textContent = "Aucun événement.";
    dom.dayEvents.appendChild(empty);
    return;
  }
  for (const ev of evs) {
    const row = document.createElement("div");
    row.className = "day-event";
    row.innerHTML = `
      <span class="day-event-stripe stripe--${classifyEventColor(ev)}"></span>
      <span class="day-event-time">${formatEventTime(ev)}</span>
      <span class="day-event-title">${(ev.summary || "(sans titre)").replace(/</g, "&lt;")}</span>
    `;
    dom.dayEvents.appendChild(row);
  }
}

function openDayPanel(d) {
  state.selectedDateKey = dateKey(d);
  dom.dayPanelTitle.textContent = formatDayPanelTitle(d);
  renderDayPanelEvents(d);
  dom.dayPanel.classList.remove("hidden");
  // Force reflow before adding is-open so the transform animates from 100%.
  void dom.dayPanel.offsetHeight;
  dom.dayPanel.classList.add("is-open");
}

function closeDayPanel() {
  dom.dayPanel.classList.remove("is-open");
  setTimeout(() => {
    if (isDayPanelOpen()) return; // reopened (quick OK-OK) before the slide-out ended
    dom.dayPanel.classList.add("hidden");
    state.selectedDateKey = null;
    focusCell(state.focusedDateKey);
  }, 220);
}

/* =========================================================================
 * Remote control (D-pad) — arrows move a day/week, OK opens, Back closes
 * ========================================================================= */

const KEY_STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

// Some old WebViews report e.key as "Unidentified" for remote keys; fall back on keyCode.
const KEY_CODES = { 13: "Enter", 27: "Escape", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown" };

function keyName(e) {
  if (e.key && e.key !== "Unidentified") return e.key;
  return KEY_CODES[e.keyCode] || "";
}

function isStepKey(key) {
  return Object.prototype.hasOwnProperty.call(KEY_STEPS, key);
}

function isDayPanelOpen() {
  return dom.dayPanel.classList.contains("is-open");
}

function focusCell(key) {
  const cell = key && dom.calGrid.querySelector(`[data-date="${key}"]`);
  if (cell) cell.focus({ preventScroll: true });
}

function moveFocus(days) {
  const d = parseDateKey(state.focusedDateKey);
  d.setDate(d.getDate() + days);
  state.focusedDateKey = dateKey(d);
  if (d.getMonth() !== state.viewedMonth || d.getFullYear() !== state.viewedYear) {
    showMonth(d.getFullYear(), d.getMonth());
  } else {
    focusCell(state.focusedDateKey);
  }
}

function onKeyDown(e) {
  const key = keyName(e);
  if (isDayPanelOpen()) {
    if (key === "Enter" || key === "Escape") {
      e.preventDefault();
      closeDayPanel();
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      dom.dayEvents.scrollTop += key === "ArrowUp" ? -120 : 120;
    } else if (isStepKey(key)) {
      e.preventDefault();
    }
    return;
  }
  if (isStepKey(key)) {
    // preventDefault also stops the WebView's own spatial navigation.
    e.preventDefault();
    moveFocus(KEY_STEPS[key]);
  } else if (key === "Enter") {
    // preventDefault stops the focused <button> from also firing a click.
    e.preventDefault();
    openDayPanel(parseDateKey(state.focusedDateKey));
  }
}

// Called by MainActivity on the remote's Back key. Returns true when consumed.
window.pearboardBack = function () {
  if (!isDayPanelOpen()) return false;
  closeDayPanel();
  return true;
};

/* =========================================================================
 * Wire up UI events
 * ========================================================================= */

function wireEvents() {
  dom.calPrev.addEventListener("click", () => changeMonth(-1));
  dom.calNext.addEventListener("click", () => changeMonth(1));
  dom.dayPanelClose.addEventListener("click", closeDayPanel);
  document.addEventListener("keydown", onKeyDown);
}

/* =========================================================================
 * Boot
 * ========================================================================= */

function init() {
  const now = new Date();
  state.viewedYear = now.getFullYear();
  state.viewedMonth = now.getMonth();
  state.focusedDateKey = dateKey(now);

  applyTheme();            // pick a theme from the fallback hours immediately
  startClock();
  startWeather();
  wireEvents();
  showCalendarOverlay(true);
  refreshEventsFromCalendar(); // empty grid + list until the feed arrives
  startCalendar();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
