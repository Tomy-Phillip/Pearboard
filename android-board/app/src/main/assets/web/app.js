"use strict";

/* =========================================================================
 * Configuration
 * ========================================================================= */

// Written by app/build.gradle.kts into config.js: calendar names/colors, rotation.
// The secret iCal addresses stay in Kotlin (IcsProxy serves /calendar/<n>.ics).
const BOARD = window.PEARBOARD || { rotation: "none", calendars: [] };
const CALENDARS = BOARD.calendars; // [{ name, color }], index = calId

const CONFIG = {
  ICS_REFRESH_MS: 10 * 60 * 1000,
  // Backstop for a worker that never answers; the first parse of a real feed
  // takes a few seconds on a Fire TV, so this is far above any honest call.
  WORKER_TIMEOUT_MS: 60 * 1000,

  // No key or click for this long: close the day panel and go back to today's month.
  IDLE_RESET_MS: 5 * 60 * 1000,

  WEATHER_URL:
    "https://api.open-meteo.com/v1/forecast" +
    "?latitude=45.4042&longitude=-71.8929" + // Sherbrooke
    "&current_weather=true" +
    "&hourly=temperature_2m,weathercode" +
    "&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset" +
    "&timezone=America/Toronto&forecast_days=2",

  // Night mode: dark between sunset and sunrise (from the weather feed), or
  // outside these hours while no forecast has arrived yet.
  NIGHT_FALLBACK_START: 19,
  NIGHT_FALLBACK_END: 7,

  // Hours from now shown under the weather ("Maint.", +2 h, …).
  HOURLY_OFFSETS: [0, 2, 4, 6, 8],
  // Cards in "Événements du jour" (two rows of two).
  TODAY_MAX: 4,

  WEATHER_REFRESH_MS: 5 * 60 * 1000,
  WEATHER_TAP_DEBOUNCE_MS: 10 * 1000,
  WEATHER_STALE_MS: 6 * 60 * 60 * 1000,
};

/* =========================================================================
 * State
 * ========================================================================= */

const state = {
  view: "month",   // "month" | "week"
  viewedYear: 0,
  viewedMonth: 0, // 0-11
  events: [],      // occurrences overlapping the visible range, all calendars
  todayEvents: [], // today's occurrences, for "Événements du jour"
  // Per calendar (same index as CALENDARS):
  //   loaded: the worker holds a parsed feed; tried: a fetch has finished;
  //   problem: null | "offline" | "missing" (404) | "error" (worker broke);
  //   fetchedAt: when the feed the worker holds was downloaded.
  cals: CALENDARS.map(() => ({ loaded: false, tried: false, problem: null, fetchedAt: 0 })),
  focusedDateKey: null, // 'YYYY-MM-DD' of the D-pad focused cell
  todayKey: null,       // 'YYYY-MM-DD' of today, to notice the date changing
  lastInputAt: 0,       // Date.now() of the last keydown/click, for the idle reset
  refreshSeq: 0,   // drops worker replies for a range we've already left
  weather: null,
  weatherFetchedAt: 0,
  weatherRefreshing: false,
  lastWeatherTap: 0,
  selectedDateKey: null, // 'YYYY-MM-DD' when day panel open
};

/* =========================================================================
 * DOM refs
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

const dom = {
  clockTime: $("clock-time"),
  clockWeekday: $("clock-weekday"),
  clockDay: $("clock-day"),

  weather: $("weather"),
  weatherRange: $("weather-range"),
  weatherTemp: $("weather-temp"),
  weatherDesc: $("weather-desc"),
  weatherIcon: $("weather-icon"),
  weatherHourly: $("weather-hourly"),

  calTitle: $("cal-title"),
  calStatus: $("cal-status"),
  calGrid: $("cal-grid"),
  calLegend: $("cal-legend"),
  calOverlay: $("cal-overlay"),
  calOverlayMsg: $("cal-overlay-msg"),
  viewWeek: $("view-week"),
  viewMonth: $("view-month"),

  todayMeta: $("today-meta"),
  todayList: $("today-list"),

  dayPanel: $("day-panel"),
  dayPanelTitle: $("day-panel-title"),
  dayPanelClose: $("day-panel-close"),
  dayEvents: $("day-events"),
};

/* =========================================================================
 * Utilities
 * ========================================================================= */

// Not padStart: it only arrived in Chrome 57, and the API 25 WebView can be Chrome 55.
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateKey(key) {
  const p = key.split("-").map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDate(d, opts) { return new Intl.DateTimeFormat("fr-CA", opts).format(d); }

// "8h", "8h30" — the way times are written in Québec.
function formatHour(d) {
  return d.getHours() + "h" + (d.getMinutes() ? pad2(d.getMinutes()) : "");
}

const lsGet = (k) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
};

// Returns false when the write failed (quota, storage disabled); most callers ignore it.
const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
};

const lsRemove = (k) => {
  try { localStorage.removeItem(k); } catch (e) { /* storage disabled */ }
};

/* =========================================================================
 * Calendars (people) — colors, initials, legend
 * ========================================================================= */

function calendarOf(ev) {
  return CALENDARS[ev.calId] || { name: "", color: "" };
}

function colorClass(ev) {
  const color = calendarOf(ev).color;
  return color ? `cal-color--${color}` : "";
}

function renderLegend() {
  const named = CALENDARS.filter((c) => c.name);
  if (!named.length) {
    dom.calLegend.classList.add("hidden");
    return;
  }
  dom.calLegend.innerHTML = named.map((c) => `
    <span class="cal-legend-item cal-color--${c.color}">
      <span class="cal-legend-dot"></span>${escapeHtml(c.name)}
    </span>`).join("");
}

/* =========================================================================
 * Clock
 * ========================================================================= */

function tickClock() {
  const now = new Date();
  dom.clockTime.textContent = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  dom.clockWeekday.textContent = capitalize(formatDate(now, { weekday: "long" }));
  dom.clockDay.textContent = formatDate(now, { day: "numeric", month: "long", year: "numeric" });
  // Compared on every tick rather than at 00:00:00, which a throttled or
  // late timer can skip.
  if (dateKey(now) !== state.todayKey) followDateChange(now);
  if (Date.now() - state.lastInputAt >= CONFIG.IDLE_RESET_MS) resetToToday();
  // Events that just ended leave the today list (which can resize the calendar
  // cells, so the grid re-renders too); the offline age ticks on.
  if (now.getSeconds() === 0) {
    applyTheme();
    renderCalendarStatus();
    renderToday();
    renderCalendar();
  }
}

// "Today" moved (midnight, or the clock was corrected): follow it if the grid
// was showing the old today's month, then recompute today's list and highlight.
function followDateChange(now) {
  const old = state.todayKey ? parseDateKey(state.todayKey) : null;
  state.todayKey = dateKey(now);
  if (old && state.viewedYear === old.getFullYear() && state.viewedMonth === old.getMonth()) {
    if (state.viewedYear !== now.getFullYear() || state.viewedMonth !== now.getMonth()) {
      state.events = []; // last month's events don't belong on the new grid
    }
    state.viewedYear = now.getFullYear();
    state.viewedMonth = now.getMonth();
    state.focusedDateKey = state.todayKey;
  }
  refreshEventsFromCalendar();
}

// Nobody has touched the remote for a while: put the wall display back on
// today's month. Cheap no-op when it's already there, so the clock can call it every second.
function resetToToday() {
  if (isDayPanelOpen()) closeDayPanel(); // refocuses state.focusedDateKey when it's gone
  const now = new Date();
  const key = dateKey(now);
  const onToday = state.view === "month"
    && state.viewedYear === now.getFullYear() && state.viewedMonth === now.getMonth();
  if (onToday && state.focusedDateKey === key) return;
  state.focusedDateKey = key;
  if (onToday) {
    focusCell(key);
  } else {
    state.view = "month";
    showMonth(now.getFullYear(), now.getMonth());
  }
}

/* Night mode: <html data-theme="dark"> between today's sunset and sunrise in
 * Sherbrooke. The weather feed's daily.sunrise/sunset are local "YYYY-MM-DDTHH:MM"
 * strings (no offset), which Date reads as local time. */
function isNight(now) {
  const daily = state.weather && state.weather.daily;
  const i = daily && daily.time ? daily.time.indexOf(dateKey(now)) : -1;
  if (i !== -1 && daily.sunrise && daily.sunset) {
    return now < new Date(daily.sunrise[i]) || now >= new Date(daily.sunset[i]);
  }
  const h = now.getHours();
  return h >= CONFIG.NIGHT_FALLBACK_START || h < CONFIG.NIGHT_FALLBACK_END;
}

// ?theme=dark|light pins the theme (dev server only; the TV loads index.html bare).
const FORCED_THEME = (/[?&]theme=(light|dark)\b/.exec(location.search) || [])[1];

function applyTheme() {
  const theme = FORCED_THEME || (isNight(new Date()) ? "dark" : "light");
  if (document.documentElement.getAttribute("data-theme") !== theme) {
    document.documentElement.setAttribute("data-theme", theme);
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

/* =========================================================================
 * Weather
 * ========================================================================= */

/* WMO weather code → inline SVG icon. Inline so it's offline-resilient. */
const WEATHER_ICONS = {
  sunny: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="13" fill="#f7c548"/>
      <g stroke="#f7c548" stroke-width="3.5" stroke-linecap="round">
        <line x1="32" y1="5"  x2="32" y2="12"/>
        <line x1="32" y1="52" x2="32" y2="59"/>
        <line x1="5"  y1="32" x2="12" y2="32"/>
        <line x1="52" y1="32" x2="59" y2="32"/>
        <line x1="12.9" y1="12.9" x2="17.9" y2="17.9"/>
        <line x1="46.1" y1="46.1" x2="51.1" y2="51.1"/>
        <line x1="12.9" y1="51.1" x2="17.9" y2="46.1"/>
        <line x1="46.1" y1="17.9" x2="51.1" y2="12.9"/>
      </g>
    </svg>`,
  partlyCloudy: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="15" fill="#f7c548"/>
      <rect x="20" y="30" width="38" height="20" rx="10" fill="#ffffff"/>
    </svg>`,
  cloudy: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 50c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#ffffff"/>
    </svg>`,
  fog: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 36c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#ffffff"/>
      <g stroke="#8fa3b5" stroke-width="3" stroke-linecap="round">
        <line x1="10" y1="46" x2="54" y2="46"/>
        <line x1="6"  y1="54" x2="48" y2="54"/>
      </g>
    </svg>`,
  rain: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 38c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#ffffff"/>
      <g stroke="#3d86d8" stroke-width="3" stroke-linecap="round">
        <line x1="20" y1="46" x2="17" y2="58"/>
        <line x1="32" y1="46" x2="29" y2="58"/>
        <line x1="44" y1="46" x2="41" y2="58"/>
      </g>
    </svg>`,
  snow: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 38c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#ffffff"/>
      <g fill="#8fb8e0">
        <circle cx="20" cy="52" r="2.8"/>
        <circle cx="32" cy="56" r="2.8"/>
        <circle cx="44" cy="52" r="2.8"/>
      </g>
    </svg>`,
  thunder: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 36c-6 0-11-5-11-11 0-6 5-10 10-11 1-7 8-12 16-12 9 0 16 7 16 16 6 0 10 4 10 10s-4 8-10 8H18z"
            fill="#8fa3b5"/>
      <polygon points="32,40 24,52 30,52 26,62 40,46 33,46 37,40" fill="#f7a531"/>
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
    dom.weatherDesc.textContent = "Hors ligne";
    dom.weatherRange.textContent = "";
    dom.weatherIcon.innerHTML = "";
    dom.weatherHourly.innerHTML = "";
    return;
  }
  const cw = payload.current_weather || {};
  const daily = payload.daily || {};

  const code = cw.weathercode;
  const hi = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null;
  const lo = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null;

  dom.weatherTemp.textContent = `${Math.round(cw.temperature)}°`;
  const desc = WMO[code] != null ? WMO[code] : "—";
  dom.weatherDesc.innerHTML = opts.stale ? `<span class="stale-dot"></span>${desc}` : desc;
  dom.weatherRange.textContent = hi != null && lo != null ? `Max ${hi}° · Min ${lo}°` : "";
  dom.weatherIcon.innerHTML = WEATHER_ICONS[pickWeatherIcon(code)] || "";

  renderHourly(payload.hourly);
  applyTheme(); // sunrise/sunset may have just arrived
}

function renderHourly(hourly) {
  if (!hourly || !hourly.time || !hourly.temperature_2m) {
    dom.weatherHourly.innerHTML = "";
    return;
  }
  // Find the current hour in hourly.time (`YYYY-MM-DDTHH:MM` in the requested timezone).
  const now = new Date();
  const nowKey = `${dateKey(now)}T${pad2(now.getHours())}`;
  let idx = hourly.time.findIndex(t => t.startsWith(nowKey));
  if (idx === -1) idx = 0;

  dom.weatherHourly.innerHTML = CONFIG.HOURLY_OFFSETS
    .filter(off => idx + off < hourly.time.length)
    .map(off => {
      const j = idx + off;
      const label = off === 0 ? "Maint." : `${Number(hourly.time[j].slice(11, 13))}h`;
      return `
        <div class="weather-hour">
          <span class="weather-hour-time">${label}</span>
          <span class="weather-hour-temp">${Math.round(hourly.temperature_2m[j])}°</span>
        </div>`;
    }).join("");
}

async function fetchWeather() {
  state.weatherRefreshing = true;
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
 * Calendar worker — parses and expands the iCal feeds off the UI thread
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
// holds no feed, so every calendar counts as not loaded until its next fetch.
function recycleCalendarWorker(err) {
  if (calendarWorker) {
    calendarWorker.terminate();
    calendarWorker = null;
  }
  state.cals.forEach((c) => {
    c.loaded = false;
    c.problem = "error";
  });
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
 * Calendar data — one iCal feed per person via MainActivity's /calendar/<n>.ics
 * ========================================================================= */

function anyCalendarLoaded() {
  return state.cals.some((c) => c.loaded);
}

// Sunday-based getDay() → Monday-first week, as on Québec wall calendars.
function mondayOf(d) {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}

// Whole weeks covering the month: 4 to 6 rows.
function monthRange(y, m) {
  return [mondayOf(new Date(y, m, 1)), addDays(mondayOf(new Date(y, m + 1, 0)), 7)];
}

function visibleRange() {
  if (state.view === "week") {
    const start = mondayOf(parseDateKey(state.focusedDateKey));
    return [start, addDays(start, 7)];
  }
  return monthRange(state.viewedYear, state.viewedMonth);
}

/* Renders right away from what we have (navigation stays instant), then asks
 * the worker for the visible range and today, and re-renders when it answers. */
function refreshEventsFromCalendar() {
  const seq = ++state.refreshSeq;
  // Today first: its card's height decides how tall the calendar cells are.
  renderToday();
  renderCalendar();
  if (!anyCalendarLoaded()) return;

  const range = visibleRange();
  const today = startOfDay(new Date());
  requestExpansion(seq, [
    [range[0].getTime(), range[1].getTime()],
    [today.getTime(), addDays(today, 1).getTime()],
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
    if (seq !== state.refreshSeq) return; // a newer refresh (navigation) superseded us
    state.events = result[0];
    state.todayEvents = result[1];
    renderToday();
    renderCalendar();
    if (state.selectedDateKey) renderDayPanelEvents(parseDateKey(state.selectedDateKey));
  }, (err) => {
    console.warn("[calendar] expansion failed:", err);
    if (err.workerFailure) renderCalendarStatus();
  }).then(() => {
    expansion.busy = false;
    const next = expansion.next;
    expansion.next = null;
    // After a worker failure there's no feed to expand; the next fetch reloads one.
    if (next && anyCalendarLoaded()) requestExpansion(next.seq, next.ranges);
  });
}

// Rejects on an invalid feed and leaves that calendar's previous feed in place.
// Resolves with whether the text differs from what the worker already held.
function loadIcsText(calId, text, fetchedAt) {
  return callWorker({ type: "load", calId, text }).then((result) => {
    const c = state.cals[calId];
    c.loaded = true;
    c.fetchedAt = fetchedAt;
    renderCalendarStatus();
    refreshEventsFromCalendar();
    return result.changed;
  });
}

// localStorage keys for a calendar's last good feed. The name is in the key so
// reordering calendars in local.properties never shows a feed under the wrong person.
function cacheKeys(calId) {
  const base = `ics_${calId}_${CALENDARS[calId].name}`;
  return { text: base + "_text", fetchedAt: base + "_fetched_at" };
}

function formatAge(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

function showCalendarOverlay(show, msg) {
  if (!show) {
    dom.calOverlay.classList.add("hidden");
    return;
  }
  dom.calOverlayMsg.textContent = msg || "Chargement du calendrier…";
  dom.calOverlay.classList.remove("hidden");
}

// The overlay covers the grid until at least one calendar shows; after that,
// calendars that fail show up in the small status line instead.
function renderCalendarStatus() {
  const cals = state.cals;
  if (!cals.length) {
    showCalendarOverlay(true, "Calendrier non configuré — voir README");
  } else if (!anyCalendarLoaded()) {
    if (cals.some((c) => !c.tried)) showCalendarOverlay(true);
    else if (cals.some((c) => c.problem === "error")) showCalendarOverlay(true, "Erreur du calendrier");
    else if (cals.every((c) => c.problem === "missing")) showCalendarOverlay(true, "Calendrier non configuré — voir README");
    else showCalendarOverlay(true, "Calendrier hors ligne");
  } else {
    showCalendarOverlay(false);
  }

  const failing = cals.map((c, i) => i).filter((i) => cals[i].problem);
  if (!anyCalendarLoaded() || !failing.length) {
    dom.calStatus.classList.add("hidden");
    return;
  }
  const names = CALENDARS.length > 1
    ? ` (${failing.map((i) => CALENDARS[i].name || "?").join(", ")})`
    : "";
  const ages = failing.map((i) => cals[i].fetchedAt).filter((t) => t);
  const age = ages.length
    ? ` · mis à jour il y a ${formatAge(Date.now() - Math.min.apply(null, ages))}`
    : "";
  dom.calStatus.textContent = `Hors ligne${names}${age}`;
  dom.calStatus.classList.remove("hidden");
}

async function fetchCalendar(calId) {
  const c = state.cals[calId];
  const keys = cacheKeys(calId);
  try {
    const r = await fetch(`/calendar/${calId}.ics`, { cache: "no-store" });
    if (r.status === 404) {
      // IcsProxy answers 404 when this calendar has no URL in the build.
      c.problem = "missing";
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const fetchedAt = Date.now();
    const changed = await loadIcsText(calId, text, fetchedAt);
    // A feed can be several MB: rewrite it only when it changed, and keep the
    // timestamp under its own small key so the offline age stays right.
    if (changed && !lsSet(keys.text, text)) {
      console.warn("[calendar] could not cache feed", calId, "(storage full?)");
    }
    lsSet(keys.fetchedAt, fetchedAt);
    c.problem = null;
  } catch (err) {
    console.warn("[calendar] fetch failed:", calId, err);
    c.problem = err.workerFailure ? "error" : "offline";
  } finally {
    c.tried = true;
    renderCalendarStatus();
  }
}

function startCalendar() {
  // The single-feed cache of the first landscape version; it only wastes quota now.
  lsRemove("ics_text");
  lsRemove("ics_fetched_at");

  renderCalendarStatus();
  // Show each calendar's last good feed right away; its fresh fetch replaces it
  // when it lands. The first fetch waits for the cached load to settle, so an
  // offline start doesn't flash "Calendrier hors ligne" before the cache shows.
  CALENDARS.forEach((cal, calId) => {
    const keys = cacheKeys(calId);
    const cachedText = lsGet(keys.text);
    const cachedLoaded = cachedText
      ? loadIcsText(calId, cachedText, lsGet(keys.fetchedAt) || 0)
        .catch((err) => console.warn("[calendar] cached feed unusable:", calId, err))
      : Promise.resolve();
    cachedLoaded.then(() => fetchCalendar(calId));
  });
  setInterval(() => CALENDARS.forEach((cal, calId) => fetchCalendar(calId)), CONFIG.ICS_REFRESH_MS);
}

/* =========================================================================
 * Calendar — month and week grids
 * ========================================================================= */

function calendarTitle(range) {
  if (state.view === "month") {
    return capitalize(formatDate(new Date(state.viewedYear, state.viewedMonth, 1), { month: "long", year: "numeric" }));
  }
  const first = range[0];
  const last = addDays(range[1], -1);
  if (first.getMonth() === last.getMonth()) {
    return `${first.getDate()} – ${last.getDate()} ${formatDate(last, { month: "long", year: "numeric" })}`;
  }
  return `${formatDate(first, { day: "numeric", month: "short" })} – ${formatDate(last, { day: "numeric", month: "short", year: "numeric" })}`;
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

function isAllDay(ev) { return !!(ev.start && ev.start.date); }

function sortEvents(evs) {
  // All-day first, then by start time.
  return evs.sort((a, b) => (isAllDay(b) - isAllDay(a)) || (eventStartMs(a) - eventStartMs(b)));
}

function eventsForDay(day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return sortEvents(state.events.filter(ev => {
    const s = eventStart(ev);
    const e = eventEnd(ev) || s;
    if (!s) return false;
    return s < dayEnd && e >= dayStart;
  }));
}

function formatEventTime(ev) {
  if (isAllDay(ev)) return "Toute la journée";
  return `${formatHour(eventStart(ev))}–${formatHour(eventEnd(ev))}`;
}

function eventChip(ev, withTime) {
  const chip = document.createElement("div");
  chip.className = `cal-chip ${colorClass(ev)}`;
  if (withTime && !isAllDay(ev)) {
    const time = document.createElement("span");
    time.className = "cal-chip-time";
    time.textContent = formatHour(eventStart(ev));
    chip.appendChild(time);
  }
  chip.appendChild(document.createTextNode(ev.summary || "(sans titre)"));
  return chip;
}

// How many one-line chips fit under the day number in a month cell.
const MONTH_CELL_HEAD_PX = 58; // padding + number row
const MONTH_CHIP_PX = 38;      // chip + its top margin

function renderCalendar() {
  const range = visibleRange();
  const isWeek = state.view === "week";
  const weeks = Math.round((range[1] - range[0]) / (7 * 24 * 3600 * 1000));

  dom.calTitle.textContent = calendarTitle(range);
  dom.viewWeek.classList.toggle("is-active", isWeek);
  dom.viewMonth.classList.toggle("is-active", !isWeek);
  dom.calGrid.classList.toggle("is-week", isWeek);
  dom.calGrid.style.gridTemplateRows = `repeat(${weeks}, minmax(0, 1fr))`;

  // Measured, not guessed: a 6-week month has shorter cells than a 5-week one.
  const rowPx = (dom.calGrid.clientHeight - 10 * (weeks - 1)) / weeks;
  const maxChips = isWeek ? Infinity : Math.max(1, Math.floor((rowPx - MONTH_CELL_HEAD_PX) / MONTH_CHIP_PX));

  const today = new Date();
  dom.calGrid.innerHTML = "";
  for (let d = new Date(range[0]); d < range[1]; d = addDays(d, 1)) {
    const cellDate = d;
    const cell = document.createElement("button");
    cell.className = "cal-cell";
    cell.type = "button";
    if (!isWeek && cellDate.getMonth() !== state.viewedMonth) cell.classList.add("is-othermonth");
    if (isSameDay(cellDate, today)) cell.classList.add("is-today");
    cell.dataset.date = dateKey(cellDate);

    const head = document.createElement("div");
    head.className = "cal-cell-head";
    const num = document.createElement("div");
    num.className = "cal-cell-num";
    num.textContent = String(cellDate.getDate());
    head.appendChild(num);
    cell.appendChild(head);

    const evs = eventsForDay(cellDate);
    // What doesn't fit is counted as "+N" beside the day number.
    const shown = Math.min(evs.length, maxChips);
    if (evs.length > shown) {
      const more = document.createElement("span");
      more.className = "cal-more";
      more.textContent = `+${evs.length - shown}`;
      head.appendChild(more);
    }
    for (const ev of evs.slice(0, shown)) cell.appendChild(eventChip(ev, isWeek));

    cell.addEventListener("click", () => {
      state.focusedDateKey = cell.dataset.date;
      openDayPanel(cellDate);
    });
    dom.calGrid.appendChild(cell);
  }
  // With the day panel up, focus goes back to the grid when the panel closes.
  if (!isDayPanelOpen()) focusCell(state.focusedDateKey);
}

/* =========================================================================
 * Today's events
 * ========================================================================= */

function todayCard(ev) {
  const cal = calendarOf(ev);
  const avatar = cal.name
    ? `<span class="today-avatar">${escapeHtml(cal.name.charAt(0).toUpperCase())}</span>`
    : "";
  return `
    <div class="today-event ${colorClass(ev)}">
      ${avatar}
      <div class="today-text">
        <div class="today-event-title">${escapeHtml(ev.summary || "(sans titre)")}</div>
        <div class="today-event-time">${formatEventTime(ev)}</div>
      </div>
    </div>`;
}

function renderToday() {
  const now = new Date();
  const all = state.todayEvents;
  const count = all.length;
  dom.todayMeta.textContent = (count ? `${count} événement${count > 1 ? "s" : ""} · ` : "")
    + formatDate(now, { day: "numeric", month: "long" });

  // Only what's still ahead or under way.
  const upcoming = sortEvents(all.filter(ev => {
    const s = eventStart(ev);
    const e = eventEnd(ev) || s;
    return s && e >= now;
  }));

  if (!upcoming.length) {
    const msg = count ? "Plus rien aujourd'hui" : "Aucun événement aujourd'hui";
    dom.todayList.innerHTML = `<div class="today-empty">${msg}</div>`;
    return;
  }
  const fits = upcoming.length <= CONFIG.TODAY_MAX;
  const shown = upcoming.slice(0, fits ? CONFIG.TODAY_MAX : CONFIG.TODAY_MAX - 1);
  dom.todayList.innerHTML = shown.map(todayCard).join("")
    + (fits ? "" : `<div class="today-event today-more">+${upcoming.length - shown.length} autres</div>`);
}

/* =========================================================================
 * Navigation
 * ========================================================================= */

// Switches the grid to another month; set state.focusedDateKey first.
function showMonth(y, m) {
  state.viewedYear = y;
  state.viewedMonth = m;
  state.events = []; // don't paint last month's events on the new grid while the worker answers
  refreshEventsFromCalendar(); // re-renders the grid, which restores focus
}

function toggleView() {
  state.view = state.view === "month" ? "week" : "month";
  const d = parseDateKey(state.focusedDateKey);
  state.viewedYear = d.getFullYear();
  state.viewedMonth = d.getMonth();
  refreshEventsFromCalendar();
}

/* =========================================================================
 * Day panel
 * ========================================================================= */

function renderDayPanelEvents(d) {
  const evs = eventsForDay(d);
  if (!evs.length) {
    dom.dayEvents.innerHTML = `<div class="day-empty">Aucun événement.</div>`;
    return;
  }
  dom.dayEvents.innerHTML = evs.map(ev => `
    <div class="day-event ${colorClass(ev)}">
      <span class="day-event-stripe"></span>
      <span class="day-event-time">${formatEventTime(ev)}</span>
      <span class="day-event-title">${escapeHtml(ev.summary || "(sans titre)")}</span>
    </div>`).join("");
}

function openDayPanel(d) {
  state.selectedDateKey = dateKey(d);
  dom.dayPanelTitle.textContent = capitalize(formatDate(d, { weekday: "long", month: "long", day: "numeric" }));
  renderDayPanelEvents(d);
  dom.dayPanel.classList.remove("hidden");
  // Force reflow before adding is-open so the fade runs.
  void dom.dayPanel.offsetHeight;
  dom.dayPanel.classList.add("is-open");
}

function closeDayPanel() {
  dom.dayPanel.classList.remove("is-open");
  setTimeout(() => {
    if (isDayPanelOpen()) return; // reopened (quick OK-OK) before the fade-out ended
    dom.dayPanel.classList.add("hidden");
    state.selectedDateKey = null;
    focusCell(state.focusedDateKey);
  }, 220);
}

/* =========================================================================
 * Remote control (D-pad) — arrows move a day/week, OK opens, Back closes,
 * Menu or Play/Pause (sent by MainActivity) switches month/week
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

// preventScroll is ignored before Chrome 64 (old Fire TV WebViews); harmless,
// the page never scrolls.
function focusCell(key) {
  const cell = key && dom.calGrid.querySelector(`[data-date="${key}"]`);
  if (cell) cell.focus({ preventScroll: true });
}

function moveFocus(days) {
  const before = visibleRange()[0].getTime();
  const d = addDays(parseDateKey(state.focusedDateKey), days);
  state.focusedDateKey = dateKey(d);
  const monthChanged = d.getMonth() !== state.viewedMonth || d.getFullYear() !== state.viewedYear;
  state.viewedYear = d.getFullYear();
  state.viewedMonth = d.getMonth();
  if (visibleRange()[0].getTime() !== before) {
    if (monthChanged && state.view === "month") state.events = [];
    refreshEventsFromCalendar(); // re-renders the grid, which restores focus
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
  } else if (key === "v" || key === "ContextMenu") {
    // Keyboard stand-ins for the remote's Menu key when working on a PC.
    e.preventDefault();
    toggleView();
  }
}

// Called by MainActivity on the remote's Back key. Returns true when consumed.
window.pearboardBack = function () {
  state.lastInputAt = Date.now(); // Back never reaches the page as a keydown
  if (!isDayPanelOpen()) return false;
  closeDayPanel();
  return true;
};

// Called by MainActivity on the remote's Menu or Play/Pause key.
window.pearboardToggleView = function () {
  state.lastInputAt = Date.now(); // these keys never reach the page as keydowns
  if (isDayPanelOpen()) closeDayPanel();
  toggleView();
};

/* =========================================================================
 * Wire up UI events
 * ========================================================================= */

function wireEvents() {
  dom.dayPanelClose.addEventListener("click", closeDayPanel);
  document.addEventListener("keydown", onKeyDown);
  // Capture phase so the idle timer sees every key and click, whatever handles it.
  const markInput = () => { state.lastInputAt = Date.now(); };
  document.addEventListener("keydown", markInput, true);
  document.addEventListener("click", markInput, true);
}

/* =========================================================================
 * Boot
 * ========================================================================= */

function init() {
  const now = new Date();
  state.viewedYear = now.getFullYear();
  state.viewedMonth = now.getMonth();
  state.focusedDateKey = dateKey(now);
  state.todayKey = dateKey(now);
  state.lastInputAt = Date.now();

  renderLegend();
  applyTheme(); // from the fallback hours until the weather (cached or fresh) arrives
  startClock();
  startWeather();
  wireEvents();
  refreshEventsFromCalendar(); // empty grid + list until the feeds arrive
  startCalendar();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
