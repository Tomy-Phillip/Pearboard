"use strict";

/* =========================================================================
 * Configuration
 * ========================================================================= */

const CONFIG = {
  // Paste your OAuth 2.0 Client ID here. See README for setup steps.
  GOOGLE_CLIENT_ID: "20853608947-labdcj4jdph1ec0dg02pn2t3dbjej1hc.apps.googleusercontent.com",
  GOOGLE_SCOPE: "https://www.googleapis.com/auth/calendar.events",
  CALENDAR_ID: "primary",

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

  TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000, // refresh 5 min before expiry

  TIMEZONE: "America/Toronto",

  // Auto theme — light during the day, dark at night. Driven by Open-Meteo
  // sunrise/sunset when available, otherwise these fixed hours.
  THEME_AUTO: true,
  THEME_DAY_START: 7,   // hour, fallback only
  THEME_DAY_END: 19,    // hour, fallback only

  // Auto-reload when update.sh deploys a new commit (it writes version.txt).
  UPDATE_CHECK_MS: 60 * 1000,
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

  // Theme tracking — derived from sunrise/sunset (or fixed hour fallback).
  sunrise: null,  // ISO string
  sunset: null,   // ISO string
  appliedTheme: null,

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
  weatherTemp: $("weather-temp"),
  weatherDesc: $("weather-desc"),
  weatherMax: $("weather-max"),
  weatherMin: $("weather-min"),
  weatherIcon: $("weather-icon"),
  weatherHourly: $("weather-hourly"),

  notifList: $("notif-list"),

  photoSettings: $("photo-settings"),
  photoMenu: $("photo-menu"),
  photoChoose: $("photo-choose"),
  photoReset: $("photo-reset"),
  photoInput: $("photo-input"),

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
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { }
};

/* =========================================================================
 * Photo picker — left-side background image
 * ========================================================================= */

const PHOTO_KEY = "dashboard_photo";
const PHOTO_MAX_BYTES = 3 * 1024 * 1024; // ~3MB raw → ~4MB base64

function applyPhotoDataUrl(dataUrl) {
  // Wrap in url('...'). Data URLs use a base64 alphabet plus :/;,=, all of
  // which are safe inside single quotes.
  document.documentElement.style.setProperty("--clock-photo", `url('${dataUrl}')`);
}

function loadPhotoFromStorage() {
  const dataUrl = lsGet(PHOTO_KEY);
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
    applyPhotoDataUrl(dataUrl);
  }
}

function savePhoto(dataUrl) {
  try {
    lsSet(PHOTO_KEY, dataUrl);
    applyPhotoDataUrl(dataUrl);
  } catch (e) {
    console.warn("[photo] save failed:", e);
    alert("L'image est trop volumineuse pour être enregistrée. Choisissez un fichier plus petit.");
  }
}

function resetPhoto() {
  lsSet(PHOTO_KEY, null);
  document.documentElement.style.removeProperty("--clock-photo");
}

function wirePhotoPicker() {
  if (!dom.photoSettings) return;

  const closeMenu = () => dom.photoMenu.classList.add("hidden");

  dom.photoSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.photoMenu.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (dom.photoMenu.classList.contains("hidden")) return;
    if (dom.photoMenu.contains(e.target)) return;
    if (dom.photoSettings.contains(e.target)) return;
    closeMenu();
  });

  dom.photoChoose.addEventListener("click", () => {
    closeMenu();
    dom.photoInput.click();
  });

  dom.photoReset.addEventListener("click", () => {
    closeMenu();
    resetPhoto();
  });

  dom.photoInput.addEventListener("change", () => {
    const file = dom.photoInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Le fichier choisi n'est pas une image.");
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      alert(`L'image dépasse ${Math.round(PHOTO_MAX_BYTES / 1024 / 1024)} Mo. Choisissez un fichier plus petit.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") savePhoto(reader.result);
    };
    reader.onerror = () => alert("Impossible de lire le fichier.");
    reader.readAsDataURL(file);
    dom.photoInput.value = ""; // allow re-selecting the same file
  });
}

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
  // notifications re-render quickly from in-memory state.events.
  if (now.getSeconds() === 0) {
    applyTheme();
    renderNotifications();
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
  const desc = WMO[code] ?? "—";
  dom.weatherDesc.innerHTML = opts.stale
    ? `<span class="stale-dot"></span>${desc}`
    : desc;
  dom.weatherMax.textContent = hi != null ? `${hi}°` : "—°";
  dom.weatherMin.textContent = lo != null ? `${lo}°` : "—°";
  dom.weatherIcon.innerHTML = WEATHER_ICONS[pickWeatherIcon(code)] || "";

  renderHourly(payload.hourly);

  state.sunrise = daily.sunrise?.[0] || null;
  state.sunset  = daily.sunset?.[0]  || null;
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
    callback: () => { },        // overridden per-call
    error_callback: () => { },  // overridden per-call
  });
  return state.auth.tokenClient;
}

function requestToken({ silent }) {
  return new Promise((resolve, reject) => {
    let client;
    try { client = ensureTokenClient(); }
    catch (e) { reject(e); return; }

    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    client.callback = (resp) => {
      if (resp && resp.access_token) {
        state.auth.accessToken = resp.access_token;
        const ttl = (resp.expires_in ? Number(resp.expires_in) : 3600) * 1000;
        state.auth.expiresAt = Date.now() + ttl;
        persistToken();
        scheduleSilentRefresh();
        showCalendarOverlay(false);
        settle(resolve, resp.access_token);
      } else {
        settle(reject, new Error(resp?.error || "No access token returned"));
      }
    };

    client.error_callback = (err) => {
      settle(reject, new Error(err?.type || err?.message || "gis_error"));
    };

    try {
      client.requestAccessToken({ prompt: silent ? "" : "consent" });
    } catch (e) {
      settle(reject, e);
    }

    // Safety net: if GIS never invokes either callback within 8 s for a silent
    // attempt, treat it as a failure so the UI can show the Connect button.
    if (silent) {
      setTimeout(() => settle(reject, new Error("silent_timeout")), 8000);
    }
  });
}

function showCalendarOverlay(show, msg) {
  if (!show) {
    dom.calOverlay.classList.add("hidden");
    return;
  }
  dom.calOverlayMsg.textContent = msg || "Connecter Google Calendar";
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
  const s = new Intl.DateTimeFormat("fr-CA", { month: "long", year: "numeric" })
    .format(new Date(y, m, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function classifyEventColor(ev) {
  // Google colorIds — our three offered colors map directly. Anything else
  // (events created in another client without a color) uses the red default,
  // matching the reference layout's accent.
  switch (ev.colorId) {
    case "9":  return "blue";
    case "10": return "green";
    case "5":  return "amber";
    case "11": return "red";
    case "2":  return "green";
    case "4":  return "red";
    case "6":  return "red";
    default:   return "red";
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

    cell.addEventListener("click", () => openDayPanel(cellDate));
    dom.calGrid.appendChild(cell);
  }
}

async function fetchEventsForViewedMonth() {
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    showCalendarOverlay(true, "Définir GOOGLE_CLIENT_ID dans app.js");
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
    renderNotifications();
    if (state.selectedDateKey) {
      const [y, m, d] = state.selectedDateKey.split("-").map(Number);
      renderDayPanelEvents(new Date(y, m - 1, d));
    }
  } catch (err) {
    if (err.message === "not_authenticated") return;
    console.warn("[calendar] fetch failed:", err);
  }
}

function renderNotifications() {
  if (!dom.notifList) return;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const upcoming = state.events
    .filter(ev => {
      const s = eventStart(ev);
      const e = eventEnd(ev) || s;
      if (!s) return false;
      // Show events that occur today and haven't ended yet.
      return s < tomorrow && e >= now;
    })
    .sort((a, b) => (eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0))
    .slice(0, CONFIG.NOTIF_MAX);

  if (!upcoming.length) {
    dom.notifList.innerHTML = `<div class="notif-empty">Aucun événement aujourd'hui</div>`;
    return;
  }

  dom.notifList.innerHTML = upcoming.map(ev => {
    const color = classifyEventColor(ev);
    const time = ev.start?.date
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
  const s = new Intl.DateTimeFormat("fr-CA", {
    weekday: "long", month: "long", day: "numeric",
  }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatEventTime(ev) {
  if (ev.start?.date) return "Toute la journée";
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
  if (!title) { showFormError("Le titre est requis."); return; }

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
    if (endD <= startD) { showFormError("L'heure de fin doit être après l'heure de début."); return; }
    start = { dateTime: startD.toISOString(), timeZone: CONFIG.TIMEZONE };
    end = { dateTime: endD.toISOString(), timeZone: CONFIG.TIMEZONE };
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
    renderNotifications();
    const sel = new Date(y, mo - 1, d);
    renderDayPanelEvents(sel);
    hideForm();
  } catch (err) {
    if (err.message === "not_authenticated") {
      showFormError("Session expirée — reconnecter sur le calendrier.");
    } else {
      console.warn("[calendar] create failed:", err);
      showFormError("Impossible d'enregistrer — vérifiez la connexion.");
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
 * Auto-update
 * ========================================================================= */

async function fetchDeployedVersion() {
  try {
    const r = await fetch("version.txt", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.text()).trim() || null;
  } catch {
    return null;
  }
}

function startUpdateWatcher() {
  let loadedVersion = null;
  fetchDeployedVersion().then(v => { loadedVersion = v; });

  setInterval(async () => {
    const v = await fetchDeployedVersion();
    if (!v) return;
    if (!loadedVersion) { loadedVersion = v; return; }
    if (v === loadedVersion) return;
    // Don't yank the page away while someone is reading or typing in the day panel.
    if (!dom.dayPanel.classList.contains("hidden")) return;
    location.reload();
  }, CONFIG.UPDATE_CHECK_MS);
}

/* =========================================================================
 * Boot
 * ========================================================================= */

function init() {
  const now = new Date();
  state.viewedYear = now.getFullYear();
  state.viewedMonth = now.getMonth();

  loadPhotoFromStorage();  // restore user-picked photo before first paint
  applyTheme();            // pick a theme from the fallback hours immediately
  startClock();
  startWeather();
  wireEvents();
  wirePhotoPicker();
  renderCalendar();
  renderNotifications();   // initial render with empty events list
  startUpdateWatcher();

  if (!CONFIG.GOOGLE_CLIENT_ID) {
    showCalendarOverlay(true, "Définir GOOGLE_CLIENT_ID dans app.js");
    return;
  }

  if (loadPersistedToken()) {
    scheduleSilentRefresh();
    fetchEventsForViewedMonth();
    return;
  }

  // No persisted token. Show the Connect overlay right away so the user always
  // sees the button; silent auth runs in the background and, if it succeeds,
  // hides the overlay via showCalendarOverlay(false) inside requestToken().
  showCalendarOverlay(true);

  waitForGis().then(() => {
    requestToken({ silent: true })
      .then(() => fetchEventsForViewedMonth())
      .catch(() => { /* overlay already visible */ });
  }).catch(() => showCalendarOverlay(true, "Échec du chargement de Google Sign-In"));
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
