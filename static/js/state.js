// ---------------------------------------------------------------------------
// État global
// ---------------------------------------------------------------------------

export const state = {
  view: "gacha",
  user: JSON.parse(localStorage.getItem("gachaUser") || "null"),
  dataset: null,
  dropRates: null,
  collection: [],
  collectionSummary: null,
  users: [],
  trades: [],
  leaderboard: [],
  achievements: [],
  achievementQueue: [],
  notifications: [],
  notificationsLoaded: false,
  unreadNotificationCount: 0,
  notificationHighlightIds: [],
  publicCollection: null,
  leaderboardQuery: "",
  pendingRoll: null,
  rollCount: 1,
  rolling: false,
  result: null,
  resultIndex: 0,
  opening: false,
  openingRarity: "C",
  activeCardMenu: null,
  cardMenuMode: null,
  cardViewer: null,
  keyModal: null,
  filters: { q: "", rarity: "all", owned: "all", sort: "standard" },
  publicFilters: { q: "", rarity: "all", owned: "all" },
  release: {
    version: "dev",
    changelog: [],
  },
};

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const ROLL_COST   = 100;
export const SELL_PRICES = { C: 20, UC: 30, R: 50, UR: 100, L: 150 };
export const SHOWCASE_LIMIT = 3;
export const DEFAULT_COLLECTION_SORT = "standard";
export const RARITIES    = ["C", "UC", "R", "UR", "L"];
export const RARITY_RANK = { L: 0, UR: 1, R: 2, UC: 3, C: 4 };
export const preloadedImages = new Set();

// ---------------------------------------------------------------------------
// Horloge serveur (offset privé, muté par saveUser / mergeUser)
// ---------------------------------------------------------------------------

let serverClockOffsetMs = 0;

export function serverNowMs() {
  return Date.now() + serverClockOffsetMs;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export function formatReviews(value) {
  const count = Number(value || 0);
  if (!count) return "- reviews";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M reviews`;
  if (count >= 1_000)     return `${Math.round(count / 1_000)}k reviews`;
  return `${count} reviews`;
}

export function statsHtml(item) {
  if (!item.owned) return "Note cachée";
  return `★ ${Number(item.rating || 0).toFixed(2)} · ${formatReviews(item.reviewCount)}`;
}

export function formatCredits(value) {
  return `${Number(value || 0).toLocaleString("fr-FR")}¥`;
}

export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function creditTimerText() {
  if (!state.user) return "";
  if (Number(state.user.credits || 0) >= Number(state.user.refillCap || 5000)) return "Recharge max";
  if (!state.user.nextCreditAt) return "";
  return `+100¥ dans ${formatCountdown(state.user.nextCreditAt * 1000 - serverNowMs())}`;
}

export function preloadImage(src) {
  if (!src || preloadedImages.has(src)) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { preloadedImages.add(src); resolve(); };
    img.onerror = resolve;
    img.src = src;
    if (img.complete) { preloadedImages.add(src); resolve(); }
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function authHeaders() {
  if (!state.user) return {};
  return {
    "X-Username":        state.user.username,
    "X-Connection-Key":  state.user.connectionKey,
  };
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Erreur inconnue.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function loadRelease() {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return;
    const release = await response.json();
    state.release = {
      version: release.version || "dev",
      changelog: Array.isArray(release.changelog) ? release.changelog : [],
    };
  } catch {
    state.release = { version: "dev", changelog: [] };
  }
}

export function saveUser(user) {
  if (typeof user.serverNow === "number") {
    serverClockOffsetMs = user.serverNow * 1000 - Date.now();
  }
  state.user = user;
  localStorage.setItem("gachaUser", JSON.stringify(user));
}

export function mergeUser(user) {
  if (!user || !state.user) return;
  if (typeof user.serverNow === "number") {
    serverClockOffsetMs = user.serverNow * 1000 - Date.now();
  }
  const fields = {};
  ["username", "letterboxdUsername", "credits", "nextCreditAt", "refillCap", "serverNow"].forEach((key) => {
    if (key in user) fields[key] = user[key];
  });
  state.user = { ...state.user, ...fields };
  localStorage.setItem("gachaUser", JSON.stringify(state.user));
}
