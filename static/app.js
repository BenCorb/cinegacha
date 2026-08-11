import {
  state,
  DEFAULT_COLLECTION_SORT, RARITIES, ROLL_COST,
  api, mergeUser, preloadImage, saveUser,
  creditTimerText, escapeHtml, loadRelease, serverNowMs,
} from "./js/state.js?v=cinedex-mobile-7";
import {
  accountPanelHtml, achievementsViewHtml, applyCollectionFilters, burstHtml,
  cardViewerHtml, collectionEmptyHtml, collectionGridHtml, collectionStatsHtml,
  creditsPanelHtml, dropRatesHtml, filterCountText, filteredCollection,
  filteredPublicCollection, hasActiveFilters, keyModalHtml, leaderboardRowHtml,
  loginForms, nav, notificationsViewHtml, publicCollectionCardHtml, publicCollectionHtml, resultHtml, showcaseEditorHtml,
  showcaseItems, walletHtml,
} from "./js/components.js?v=cinedex-mobile-7";

const $ = (selector) => document.querySelector(selector);

// ---------------------------------------------------------------------------
// Timer crédits
// ---------------------------------------------------------------------------

let creditTimerId = null;
let creditRefreshInFlight = false;
const appToastQueue = [];
let appToastTimer = null;
const ROLL_COUNTS = [1, 5, 10];
let achievementToastTimer = null;
let notificationPollId = null;
let notificationCountRefreshInFlight = false;
let notificationLoadPromise = null;
let notificationClearInFlight = false;
const NOTIFICATION_POLL_MS = 30_000;
const RESULT_SWIPE_LOCK_DISTANCE = 12;
const RESULT_SWIPE_RATIO = 0.32;
const RESULT_SWIPE_MAX_DISTANCE = 96;
const RESULT_SWIPE_MIN_VELOCITY = 0.55;
const COLLECTION_SWIPE_LOCK_DISTANCE = 12;
const COLLECTION_SWIPE_RATIO = 0.24;
const COLLECTION_SWIPE_MAX_DISTANCE = 84;
const COLLECTION_SWIPE_MIN_VELOCITY = 0.5;
const MOBILE_COLLECTION_COLUMNS = 3;
const MOBILE_COLLECTION_WINDOW_ROWS = 36;
const MOBILE_COLLECTION_OVERSCAN_ROWS = 10;

const MOBILE_CARD_QUERY = window.matchMedia("(max-width: 700px)");
let mobileCardScaleObserver = null;
let mobileCollectionImageObserver = null;
let mobileCollectionVirtualAbortController = null;
let mobileCollectionVirtualFrame = 0;
let mobileCollectionVirtualItems = [];
let mobileCollectionWindowStartRow = 0;
let mobileCollectionWindowEndRow = 0;
let mobileCollectionRowStride = 0;
let mobileCollectionWindowSignature = "";
let cardViewerAbortController = null;
let cardViewerReturnTarget = null;
let cardViewerScrollY = 0;

function resultEntries(result = state.result) {
  if (!result) return [];
  if (Array.isArray(result.items)) return result.items;
  if (result.item) return [result];
  return [];
}

function syncLegacyResultFields(entries) {
  if (!state.result || !entries.length) return;
  state.result.item = entries[0].item;
  state.result.isDuplicate = entries[0].isDuplicate;
}

function syncResultItems(collection) {
  const entries = resultEntries();
  if (!entries.length) return;
  entries.forEach((entry) => {
    const fresh = collection.find((item) => item.id === entry.item?.id);
    if (fresh) entry.item = { ...fresh };
  });
  syncLegacyResultFields(entries);
}

function patchResultItems(itemId, patch) {
  const entries = resultEntries();
  entries.forEach((entry) => {
    if (entry.item?.id === itemId) entry.item = { ...entry.item, ...patch };
  });
  syncLegacyResultFields(entries);
}

function rollPrice(count = state.rollCount) {
  return `${(ROLL_COST * count).toLocaleString("fr-FR")}¥`;
}

// ---------------------------------------------------------------------------
// Toasts applicatifs
// ---------------------------------------------------------------------------

function processAppToastQueue() {
  if (!appToastQueue.length || document.getElementById("appToast")) return;
  const { message, type } = appToastQueue.shift();
  const toast = document.createElement("div");
  toast.id = "appToast";
  toast.className = `app-toast app-toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `
    <div class="app-toast-body">
      <span class="app-toast-label">${type === "error" ? "Erreur" : type === "success" ? "OK" : "Info"}</span>
      <strong>${escapeHtml(message)}</strong>
    </div>
    <button class="app-toast-close" type="button" aria-label="Fermer">×</button>
  `;
  document.body.appendChild(toast);

  const dismiss = () => {
    if (appToastTimer) { clearTimeout(appToastTimer); appToastTimer = null; }
    toast.classList.add("is-dismissing");
    setTimeout(() => { toast.remove(); processAppToastQueue(); }, 260);
  };

  toast.querySelector(".app-toast-close").addEventListener("click", dismiss);
  appToastTimer = setTimeout(dismiss, type === "error" ? 5200 : 3600);
}

function showToast(message, type = "info") {
  if (!message) return;
  appToastQueue.push({ message, type });
  processAppToastQueue();
}

// ---------------------------------------------------------------------------
// Toast achievements
// ---------------------------------------------------------------------------

function processAchievementQueue() {
  if (!state.achievementQueue.length || document.getElementById("achievementToast")) return;
  const ach = state.achievementQueue.shift();

  const toast = document.createElement("div");
  toast.id = "achievementToast";
  toast.className = "achievement-toast";
  toast.innerHTML = `
    <div class="achievement-toast-body">
      <span class="achievement-toast-label">Succès débloqué</span>
      <strong class="achievement-toast-name">${escapeHtml(ach.name)}</strong>
      <span class="achievement-toast-reward">+${ach.reward}¥</span>
    </div>
    <button class="achievement-toast-close" type="button" aria-label="Fermer">×</button>
  `;
  document.body.appendChild(toast);

  const dismiss = () => {
    if (achievementToastTimer) { clearTimeout(achievementToastTimer); achievementToastTimer = null; }
    toast.classList.add("is-dismissing");
    setTimeout(() => { toast.remove(); processAchievementQueue(); }, 260);
  };

  toast.querySelector(".achievement-toast-close").addEventListener("click", dismiss);
  achievementToastTimer = setTimeout(dismiss, 3500);
}

function handleNewAchievements(data) {
  const newAchs = data?.newAchievements;
  if (!Array.isArray(newAchs) || !newAchs.length) return;
  state.achievementQueue.push(...newAchs);
  processAchievementQueue();
  refreshUnreadNotificationCount();
  // Invalider le cache achievements pour rafraîchir la vue si nécessaire
  state.achievements = [];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function updateNotificationBadge() {
  const count = Number(state.unreadNotificationCount || 0);
  const badge = document.querySelector(".notification-badge");
  const button = document.querySelector('[data-view="notifications"]');
  if (!badge || !button) return;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("is-empty", count === 0);
  if (count) button.setAttribute("aria-label", `Notifications, ${count} non lue${count > 1 ? "s" : ""}`);
  else button.removeAttribute("aria-label");
}

async function refreshUnreadNotificationCount() {
  if (!state.user || document.hidden || notificationCountRefreshInFlight) return;
  notificationCountRefreshInFlight = true;
  try {
    const data = await api("/api/notifications/unread-count");
    state.unreadNotificationCount = Number(data.unreadCount || 0);
    updateNotificationBadge();
  } catch (error) {
    if (error.status === 401) return;
  } finally {
    notificationCountRefreshInFlight = false;
  }
}

async function markNotificationsRead(notificationIds) {
  let unreadCount = state.unreadNotificationCount;
  for (let index = 0; index < notificationIds.length; index += 500) {
    const chunk = notificationIds.slice(index, index + 500);
    const data = await api("/api/notifications/read", {
      method: "POST",
      body: JSON.stringify({ ids: chunk }),
    });
    const markedIds = new Set(chunk);
    state.notifications.forEach((notification) => {
      if (markedIds.has(notification.id)) notification.read = true;
    });
    unreadCount = Number(data.unreadCount || 0);
  }
  state.unreadNotificationCount = unreadCount;
  updateNotificationBadge();
}

function loadNotifications({ showErrors = true } = {}) {
  if (!state.user) return Promise.resolve();
  if (notificationLoadPromise) return notificationLoadPromise;
  notificationLoadPromise = api("/api/notifications")
    .then(async (data) => {
      state.notifications = Array.isArray(data.notifications) ? data.notifications : [];
      state.notificationsLoaded = true;
      state.unreadNotificationCount = Number(data.unreadCount || 0);
      const unreadIds = state.notifications.filter((item) => !item.read).map((item) => item.id);
      if (state.view === "notifications") {
        state.notificationHighlightIds = [...new Set([
          ...state.notificationHighlightIds,
          ...unreadIds,
        ])];
        renderNotificationsView();
      } else {
        updateNotificationBadge();
      }
      if (state.view === "notifications" && unreadIds.length) {
        try {
          await markNotificationsRead(unreadIds);
        } catch (error) {
          if (showErrors) showToast(error.message, "error");
          await refreshUnreadNotificationCount();
        }
      }
    })
    .catch((error) => {
      if (showErrors) showToast(error.message, "error");
    })
    .finally(() => { notificationLoadPromise = null; });
  return notificationLoadPromise;
}

async function clearNotifications() {
  if (notificationClearInFlight) return;
  notificationClearInFlight = true;
  const button = $("#clearNotifications");
  if (button) button.disabled = true;
  try {
    const data = await api("/api/notifications/clear", { method: "POST", body: "{}" });
    state.notifications = [];
    state.notificationsLoaded = true;
    state.unreadNotificationCount = Number(data.unreadCount || 0);
    state.notificationHighlightIds = [];
    renderNotificationsView();
    const deleted = Number(data.deleted || 0);
    showToast(`${deleted} notification${deleted > 1 ? "s" : ""} supprimée${deleted > 1 ? "s" : ""}.`, "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    notificationClearInFlight = false;
    const currentButton = $("#clearNotifications");
    if (currentButton) currentButton.disabled = false;
  }
}

function renderNotificationsView() {
  renderShell(notificationsViewHtml());
  $("#clearNotifications")?.addEventListener("click", clearNotifications);
}

function startNotificationPolling() {
  if (notificationPollId) clearInterval(notificationPollId);
  notificationPollId = null;
  if (!state.user) return;
  notificationPollId = setInterval(() => {
    if (document.hidden) return;
    if (state.view === "notifications") loadNotifications({ showErrors: false });
    else refreshUnreadNotificationCount();
  }, NOTIFICATION_POLL_MS);
}

function updateCreditTimer() {
  const timer = document.querySelector("[data-credit-timer]");
  if (!timer) return;
  timer.textContent = creditTimerText();
  if (
    state.user?.nextCreditAt &&
    Number(state.user.credits || 0) < Number(state.user.refillCap || 5000) &&
    state.user.nextCreditAt * 1000 <= serverNowMs() &&
    !creditRefreshInFlight
  ) {
    creditRefreshInFlight = true;
    refresh({ shouldRender: true }).finally(() => { creditRefreshInFlight = false; });
  }
}

function startCreditTimer() {
  if (creditTimerId) clearInterval(creditTimerId);
  updateCreditTimer();
  if (state.user) creditTimerId = setInterval(updateCreditTimer, 1000);
}

// ---------------------------------------------------------------------------
// Rafraîchissement global
// ---------------------------------------------------------------------------

async function refresh({ shouldRender = true } = {}) {
  const base = await api("/api/state").catch(() => null);
  if (base) state.dataset  = base.dataset;
  if (base) state.dropRates = base.dropRates || {};
  if (base?.user && state.user) mergeUser(base.user);
  if (!state.user) {
    if (shouldRender) render();
    return;
  }
  try {
    const needsLeaderboard = state.view === "leaderboard";
    const needsAchievements = state.view === "achievements" || !state.achievements.length;
    const requests = [
      api("/api/collection"),
      api("/api/users"),
      needsLeaderboard  ? api("/api/leaderboard")  : Promise.resolve(null),
      needsAchievements ? api("/api/achievements") : Promise.resolve(null),
      api("/api/notifications/unread-count"),
    ];
    const [collection, users, leaderboardData, achievementsData, notificationData] = await Promise.all(requests);
    state.collection = collection.items;
    state.collectionSummary = collection.summary || null;
    syncResultItems(state.collection);
    if (typeof collection.credits === "number") mergeUser(collection);
    state.users = users.users;
    if (leaderboardData)  state.leaderboard  = leaderboardData.leaderboard || [];
    if (achievementsData) state.achievements = achievementsData.achievements || [];
    state.unreadNotificationCount = Number(notificationData?.unreadCount || 0);
    if (shouldRender) render();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem("gachaUser");
      state.user       = null;
      state.collection = [];
      state.collectionSummary = null;
      state.users      = [];
      state.trades     = [];
      state.leaderboard = [];
      state.achievements = [];
      state.achievementQueue = [];
      state.notifications = [];
      state.notificationsLoaded = false;
      state.unreadNotificationCount = 0;
      state.notificationHighlightIds = [];
      state.publicCollection = null;
      state.cardViewer = null;
      state.pendingRoll = null;
      state.result = null;
      state.resultIndex = 0;
      showToast("Session expiree apres reset. Reconnecte-toi ou cree un compte.", "error");
      state.view = "login";
      render();
      return;
    }
    showToast(error.message, "error");
    render();
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderShell(content) {
  const showBackToTop = state.view === "collection" || state.view === "leaderboard";
  $("#app").innerHTML = `
    <main class="shell view-${state.view}">
      <header class="topbar">
        <button class="brand brand-button" id="refreshApp" type="button" aria-label="Rafraichir CinéGacha">
          <span class="logo"></span><span>CinéGacha</span>
        </button>
        ${state.user ? walletHtml() : ""}
        <nav class="nav">${nav()}</nav>
      </header>
      ${content}
      ${keyModalHtml()}
      ${showBackToTop ? `<button class="back-to-top" id="backToTop" type="button" aria-label="Revenir en haut de la page">↑</button>` : ""}
    </main>
  `;
  startCreditTimer();
  startNotificationPolling();
  $("#refreshApp")?.addEventListener("click", () => window.location.reload());
  bindKeyModal();
  document.querySelectorAll("[data-view]:not(:disabled)").forEach((button) => {
    button.addEventListener("click", () => {
      const previousView = state.view;
      state.view = button.dataset.view;
      state.cardViewer = null;
      state.activeCardMenu = null;
      state.cardMenuMode = null;
      if (previousView === "notifications" && state.view !== "notifications") {
        state.notificationHighlightIds = [];
      }
      // Bascule immediate depuis le cache : pas d'attente reseau au changement d'onglet.
      render();
      // Donnees specifiques a la vue, rafraichies en arriere-plan (non bloquant).
      // Collection/users sont deja en memoire ; seules les vues a donnees fraiches refetchent.
      if (state.view === "leaderboard") loadLeaderboard();
      else if (state.view === "achievements") loadAchievements();
    });
  });
  $("#backToTop")?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function bindKeyModal() {
  const modal = document.querySelector(".key-modal");
  if (!modal) return;
  const input = $("#connectionKeyPopup");
  input?.addEventListener("focus", () => input.select());
  input?.addEventListener("click", () => input.select());
  requestAnimationFrame(() => input?.select());
  $("#copyConnectionKey")?.addEventListener("click", async () => {
    const copied = await copyConnectionKey(state.keyModal.key);
    if (copied) {
      state.keyModal.copied = true;
      document.querySelector(".key-modal-status").textContent = "Copiée dans le presse-papier.";
    }
  });
  $("#closeKeyModal")?.addEventListener("click", () => { state.keyModal = null; render(); });
  document.querySelector("[data-key-modal-close]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) { state.keyModal = null; render(); }
  });
}

function requireLogin() {
  if (state.user) return false;
  state.view = "login";
  renderLogin();
  return true;
}

// ---------------------------------------------------------------------------
// Vue Gachapon
// ---------------------------------------------------------------------------

function renderGacha() {
  if (requireLogin()) return;
  if (!ROLL_COUNTS.includes(state.rollCount)) state.rollCount = 1;
  const rollCount = state.rollCount;
  const canRoll = Number(state.user?.credits || 0) >= ROLL_COST * rollCount;
  const balls = [
    ["#cfd6df","8%","22%",50],["#74d99f","22%","28%",54],["#55c7f5","38%","21%",58],
    ["#c8a8ff","55%","27%",48],["#ffd84f","72%","21%",52],["#74d99f","12%","48%",58],
    ["#cfd6df","30%","52%",49],["#55c7f5","47%","49%",56],["#ffd84f","66%","51%",62],
    ["#c8a8ff","79%","43%",50],["#74d99f","19%","71%",46],["#cfd6df","37%","72%",53],
    ["#55c7f5","58%","72%",47],["#ffd84f","76%","69%",44],["#ff7da8","4%","65%",42],
    ["#74d99f","86%","67%",45],
  ];
  renderShell(`
    <div class="layout">
      <section class="panel machine-wrap">
        <div class="machine ${state.pendingRoll ? "dropped" : ""}" style="--capsule:${state.pendingRoll?.capsule?.color || "#74d99f"}">
          <div class="sign">
            <span>CAPSULE</span><span>STATION</span>
            <button class="info-badge" type="button" aria-label="Taux de drop">
              i
              <span class="drop-tooltip" role="tooltip">${dropRatesHtml()}</span>
            </button>
          </div>
          <div class="tank">${balls.map(([c, x, y, s]) => `<div class="ball" style="--c:${c};--x:${x};--y:${y};--s:${s}px"></div>`).join("")}</div>
          <div class="base">
            <div class="price">${rollPrice(rollCount)}</div>
            <button class="roll-count" id="rollCount" type="button" aria-label="Changer le nombre de tirages" ${state.pendingRoll || state.rolling ? "disabled" : ""}>x${rollCount}</button>
            <button class="handle" id="roll" type="button" aria-label="Tourner la manette" ${state.pendingRoll || !canRoll || state.rolling ? "disabled" : ""}></button>
            <div class="chute"></div>
            ${state.pendingRoll ? `<button class="drop" id="open" type="button" aria-label="Ouvrir la capsule"></button>` : ""}
          </div>
        </div>
      </section>
      <section class="panel reveal ${state.result ? "has-result" : "empty-reveal"} ${state.opening ? `opening impact-${state.openingRarity}` : ""}">
        ${state.opening ? burstHtml() : ""}
        ${state.result ? resultHtml(state.result) : `<h1>Ta prochaine capsule attend.</h1><p>${canRoll ? `Tirage x${rollCount} : ${rollPrice(rollCount)}.` : "Pas assez de credits. Recharge automatique : 100¥ par heure."}</p>`}
      </section>
    </div>
  `);
  $("#rollCount")?.addEventListener("click", cycleRollCount);
  $("#roll").addEventListener("click", roll);
  $("#open")?.addEventListener("click", openCapsule);
  $("#closeResult")?.addEventListener("click", closeResult);
  bindResultSwipe();
}

function bindResultSwipe() {
  const resultCard = document.querySelector(".view-gacha .result-card");
  const swipeCard = resultCard?.querySelector(".result-grid .card");
  const reveal = resultCard?.closest(".reveal");
  if (!resultCard || !swipeCard || !window.PointerEvent || !window.matchMedia("(pointer: coarse)").matches) return;

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let currentX = 0;
  let currentY = 0;
  let locked = false;
  let frame = 0;
  let suppressClick = false;
  let suppressClickTimer = 0;

  const clearFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const clearSwipeStyles = () => {
    reveal?.classList.remove("is-result-swiping", "is-result-dismissing");
    swipeCard.classList.remove("is-swiping", "is-swipe-returning", "is-swipe-dismissed");
    swipeCard.style.removeProperty("--result-swipe-x");
    swipeCard.style.removeProperty("--result-swipe-rotate");
    swipeCard.style.removeProperty("--result-swipe-opacity");
  };

  const resetGesture = () => {
    clearFrame();
    pointerId = null;
    locked = false;
  };

  const updateSwipeStyles = () => {
    const width = swipeCard.getBoundingClientRect().width || 300;
    const progress = Math.min(Math.abs(currentX) / width, 1);
    const rotate = Math.max(-8, Math.min(8, (currentX / width) * 10));
    swipeCard.style.setProperty("--result-swipe-x", `${currentX.toFixed(1)}px`);
    swipeCard.style.setProperty("--result-swipe-rotate", `${rotate.toFixed(2)}deg`);
    swipeCard.style.setProperty("--result-swipe-opacity", `${Math.max(0.58, 1 - progress * 0.42).toFixed(2)}`);
    frame = 0;
  };

  const queueSwipeStyles = () => {
    if (frame) return;
    frame = requestAnimationFrame(updateSwipeStyles);
  };

  const suppressNextClick = () => {
    suppressClick = true;
    if (suppressClickTimer) clearTimeout(suppressClickTimer);
    suppressClickTimer = setTimeout(() => { suppressClick = false; }, 450);
  };

  swipeCard.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || event.isPrimary === false) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    currentX = 0;
    currentY = 0;
    locked = false;
    startTime = performance.now();
    clearFrame();
    swipeCard.classList.remove("is-swipe-returning", "is-swipe-dismissed");
  });

  swipeCard.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    currentX = event.clientX - startX;
    currentY = event.clientY - startY;

    const distanceX = Math.abs(currentX);
    const distanceY = Math.abs(currentY);
    if (!locked) {
      if (distanceY > RESULT_SWIPE_LOCK_DISTANCE && distanceY > distanceX) {
        resetGesture();
        return;
      }
      if (distanceX < RESULT_SWIPE_LOCK_DISTANCE || distanceX <= distanceY) return;
      locked = true;
      reveal?.classList.add("is-result-swiping");
      swipeCard.classList.add("is-swiping");
      swipeCard.setPointerCapture?.(event.pointerId);
    }

    event.preventDefault();
    queueSwipeStyles();
  });

  const finishSwipe = (event) => {
    if (event.pointerId !== pointerId) return;
    clearFrame();

    if (!locked) {
      resetGesture();
      return;
    }

    suppressNextClick();
    const width = swipeCard.getBoundingClientRect().width || 300;
    const threshold = Math.min(RESULT_SWIPE_MAX_DISTANCE, width * RESULT_SWIPE_RATIO);
    const elapsed = Math.max(1, performance.now() - startTime);
    const velocity = Math.abs(currentX) / elapsed;
    const shouldDismiss = Math.abs(currentX) >= threshold
      || (velocity >= RESULT_SWIPE_MIN_VELOCITY && Math.abs(currentX) >= RESULT_SWIPE_LOCK_DISTANCE * 2);

    swipeCard.classList.remove("is-swiping");
    if (shouldDismiss) {
      const direction = currentX < 0 ? -1 : 1;
      const exitDistance = direction * (window.innerWidth + width);
      reveal?.classList.remove("is-result-swiping");
      reveal?.classList.add("is-result-dismissing");
      swipeCard.style.setProperty("--result-swipe-x", `${exitDistance}px`);
      swipeCard.style.setProperty("--result-swipe-rotate", `${direction * 8}deg`);
      swipeCard.style.setProperty("--result-swipe-opacity", "0");
      swipeCard.classList.add("is-swipe-dismissed");
      setTimeout(closeResult, 180);
    } else {
      reveal?.classList.remove("is-result-swiping");
      swipeCard.style.setProperty("--result-swipe-x", "0px");
      swipeCard.style.setProperty("--result-swipe-rotate", "0deg");
      swipeCard.style.setProperty("--result-swipe-opacity", "1");
      swipeCard.classList.add("is-swipe-returning");
      setTimeout(clearSwipeStyles, 220);
    }

    resetGesture();
  };

  const cancelSwipe = (event) => {
    if (event.pointerId !== pointerId) return;
    resetGesture();
    clearSwipeStyles();
  };

  swipeCard.addEventListener("pointerup", finishSwipe);
  swipeCard.addEventListener("pointercancel", cancelSwipe);
  swipeCard.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function cycleRollCount() {
  const index = ROLL_COUNTS.indexOf(state.rollCount);
  state.rollCount = ROLL_COUNTS[(index + 1) % ROLL_COUNTS.length];
  render();
}

async function roll() {
  state.rolling = true;
  const btn = $("#roll");
  if (btn) btn.disabled = true;
  $(".machine")?.classList.add("spinning");
  try {
    state.pendingRoll = await api("/api/gacha/roll", {
      method: "POST",
      body: JSON.stringify({ count: state.rollCount }),
    });
    if (typeof state.pendingRoll.credits === "number") mergeUser(state.pendingRoll);
    handleNewAchievements(state.pendingRoll);
    state.rolling = false;
    setTimeout(render, 650);
  } catch (e) {
    state.rolling = false;
    showToast(e.message, "error");
    render();
  }
}

async function openCapsule() {
  const btn = $("#open");
  if (btn) btn.disabled = true;
  try {
    const pendingRarity = state.pendingRoll?.rarity || "C";
    const rollIds = state.pendingRoll?.rollIds || [state.pendingRoll.rollId];
    state.result = await api("/api/gacha/open", {
      method: "POST",
      body: JSON.stringify({ rollIds }),
    });
    state.resultIndex = 0;
    state.pendingRoll = null;
    state.openingRarity = pendingRarity;
    state.opening = true;
    handleNewAchievements(state.result);
    await refresh({ shouldRender: false });
    await Promise.all(resultEntries().map((entry) => preloadImage(entry.item?.image)));
    state.view = "gacha";
    render();
    setTimeout(() => {
      state.opening = false;
      state.openingRarity = "C";
      document.querySelector(".reveal")?.classList.remove(
        "opening", "impact-C", "impact-UC", "impact-R", "impact-UR", "impact-L"
      );
    }, state.openingRarity === "L" ? 1250 : state.openingRarity === "UR" ? 1100 : 900);
  } catch (e) {
    if (btn) btn.disabled = false;
    showToast(e.message, "error");
    render();
  }
}

function closeResult() {
  const entries = resultEntries();
  if (state.result && state.resultIndex < entries.length - 1) {
    state.resultIndex += 1;
    state.opening = false;
    state.openingRarity = "C";
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    render();
    return;
  }
  state.result = null;
  state.resultIndex = 0;
  state.opening = false;
  state.openingRarity = "C";
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  render();
}

// ---------------------------------------------------------------------------
// Vue Collection
// ---------------------------------------------------------------------------

function collectionWindowSignature(items) {
  const firstId = items[0]?.id || "";
  const lastId = items[items.length - 1]?.id || "";
  return `${state.filters.q}\u0000${state.filters.rarity}\u0000${state.filters.owned}\u0000${state.filters.sort}\u0000${items.length}\u0000${firstId}\u0000${lastId}`;
}

function collectionGridWindow(items) {
  mobileCollectionVirtualItems = items;
  const totalRows = Math.ceil(items.length / MOBILE_COLLECTION_COLUMNS);
  if (!isMobileCardLayout()) {
    mobileCollectionWindowStartRow = 0;
    mobileCollectionWindowEndRow = totalRows;
    return { items, totalRows, startRow: 0, endRow: totalRows };
  }

  const signature = collectionWindowSignature(items);
  if (signature !== mobileCollectionWindowSignature) {
    mobileCollectionWindowSignature = signature;
    mobileCollectionWindowStartRow = 0;
  }
  const maxStartRow = Math.max(0, totalRows - MOBILE_COLLECTION_WINDOW_ROWS);
  mobileCollectionWindowStartRow = Math.min(mobileCollectionWindowStartRow, maxStartRow);
  mobileCollectionWindowEndRow = Math.min(
    totalRows,
    mobileCollectionWindowStartRow + MOBILE_COLLECTION_WINDOW_ROWS,
  );
  return {
    items: items.slice(
      mobileCollectionWindowStartRow * MOBILE_COLLECTION_COLUMNS,
      mobileCollectionWindowEndRow * MOBILE_COLLECTION_COLUMNS,
    ),
    totalRows,
    startRow: mobileCollectionWindowStartRow,
    endRow: mobileCollectionWindowEndRow,
  };
}

function applyCollectionGridWindow(grid, windowData) {
  if (!grid) return;
  grid.dataset.collectionTotalRows = String(windowData.totalRows);
  grid.dataset.collectionStartRow = String(windowData.startRow);
  grid.dataset.collectionEndRow = String(windowData.endRow);
  if (!isMobileCardLayout() || !windowData.totalRows) {
    grid.style.removeProperty("padding-block-start");
    grid.style.removeProperty("padding-block-end");
    return;
  }
  const before = windowData.startRow * mobileCollectionRowStride;
  const after = (windowData.totalRows - windowData.endRow) * mobileCollectionRowStride;
  grid.style.paddingBlockStart = `${before.toFixed(2)}px`;
  grid.style.paddingBlockEnd = `${after.toFixed(2)}px`;
}

function renderCollection() {
  if (requireLogin()) return;
  const items = filteredCollection();
  const gridWindow = collectionGridWindow(items);
  const active = hasActiveFilters();
  renderShell(`
    <section class="panel">
      ${collectionStatsHtml()}
      ${showcaseEditorHtml()}
      <div class="filters collection-filters">
        <input id="q" placeholder="Rechercher un film" value="${escapeHtml(state.filters.q)}">
        <select id="rarity">
          ${["all", ...RARITIES].map((r) =>
            `<option value="${r}" ${state.filters.rarity === r ? "selected" : ""}>${r === "all" ? "Toutes raretes" : r}</option>`
          ).join("")}
        </select>
        <select id="owned">
          <option value="all"       ${state.filters.owned === "all"       ? "selected" : ""}>Tous</option>
          <option value="favorites" ${state.filters.owned === "favorites" ? "selected" : ""}>Favoris</option>
          <option value="watchlist" ${state.filters.owned === "watchlist" ? "selected" : ""}>Watchlist</option>
          <option value="dupes"     ${state.filters.owned === "dupes"     ? "selected" : ""}>Doublons</option>
          <option value="seen"      ${state.filters.owned === "seen"      ? "selected" : ""}>Vus</option>
          <option value="unseen"    ${state.filters.owned === "unseen"    ? "selected" : ""}>Non vus</option>
        </select>
        <select id="sort" aria-label="Trier la collection">
          <option value="standard"      ${state.filters.sort === "standard"      ? "selected" : ""}>Tri standard</option>
          <option value="obtained-desc" ${state.filters.sort === "obtained-desc" ? "selected" : ""}>Obtention : récent → ancien</option>
          <option value="obtained-asc"  ${state.filters.sort === "obtained-asc"  ? "selected" : ""}>Obtention : ancien → récent</option>
        </select>
      </div>
      <div class="filter-meta">
        <span class="filter-count">${filterCountText(items.length)}</span>
        <button class="ghost filter-reset ${active ? "is-active" : ""}" id="resetFilters" type="button">Effacer les filtres</button>
      </div>
      <div class="grid collection-grid">${items.length ? collectionGridHtml(gridWindow.items) : collectionEmptyHtml()}</div>
    </section>
    ${cardViewerMarkup()}
  `);
  applyCollectionGridWindow(document.querySelector(".collection-grid"), gridWindow);
  ["q", "rarity", "owned", "sort"].forEach((id) => {
    $("#" + id).addEventListener("input", (event) => {
      state.filters[id] = event.target.value;
      renderCollectionGrid();
    });
  });
  $("#resetFilters")?.addEventListener("click", () => {
    state.filters = { q: "", rarity: "all", owned: "all", sort: DEFAULT_COLLECTION_SORT };
    render();
  });
}

function renderCollectionGrid() {
  const grid = document.querySelector(".collection-grid");
  if (!grid) return render();
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  const items = filteredCollection();
  const gridWindow = collectionGridWindow(items);
  grid.innerHTML = items.length ? collectionGridHtml(gridWindow.items) : collectionEmptyHtml();
  applyCollectionGridWindow(grid, gridWindow);
  const countEl = document.querySelector(".filter-count");
  if (countEl) countEl.textContent = filterCountText(items.length);
  const active = hasActiveFilters();
  document.querySelector(".filter-reset")?.classList.toggle("is-active", active);
  bindInteractiveCards();
  bindMobileCardExperience();
}

function isMobileCardLayout() {
  return MOBILE_CARD_QUERY.matches;
}

function viewerItemsForSource(source = state.cardViewer?.source) {
  if (source === "collection") return filteredCollection();
  if (source === "showcase") return showcaseItems();
  if (source === "public-showcase") return showcaseItems(state.publicCollection?.items || []);
  return [];
}

function viewerSourceAllowedInCurrentView(source = state.cardViewer?.source) {
  if (state.view === "collection") return source === "collection" || source === "showcase";
  if (state.view === "leaderboard") return source === "public-showcase";
  return false;
}

function cardViewerItemIndex(items = viewerItemsForSource()) {
  return items.findIndex((item) => String(item.id) === String(state.cardViewer?.itemId));
}

function cardViewerMarkup() {
  if (!isMobileCardLayout() || !state.cardViewer || !viewerSourceAllowedInCurrentView()) return "";
  const source = state.cardViewer.source;
  return cardViewerHtml(viewerItemsForSource(source), {
    readonly: source === "public-showcase",
    navigationLabel: source === "collection" ? "Navigation dans le Cinédex" : "Navigation dans la vitrine",
  });
}

function clearCardViewerState({ restoreScroll = false } = {}) {
  const scrollY = cardViewerScrollY;
  state.cardViewer = null;
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  document.body.style.removeProperty("--collection-viewer-scroll-top");
  if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

function normalizeCardViewerState() {
  if (!state.cardViewer) return;
  const items = viewerItemsForSource();
  if (
    !isMobileCardLayout()
    || !viewerSourceAllowedInCurrentView()
    || cardViewerItemIndex(items) < 0
  ) clearCardViewerState({ restoreScroll: true });
}

function scaleResponsiveCards() {
  const viewerShell = document.querySelector(".collection-viewer-card-shell");
  if (viewerShell && isMobileCardLayout()) {
    const reservedHeight = window.innerWidth <= 700 ? 116 : 136;
    const widthFromHeight = Math.max(120, (window.innerHeight - reservedHeight) * 3 / 5);
    const sideMargin = window.innerWidth <= 700 ? 32 : 72;
    const viewerWidth = Math.min(300, Math.max(120, window.innerWidth - sideMargin), widthFromHeight);
    viewerShell.style.width = `${viewerWidth.toFixed(2)}px`;
  }

  document.querySelectorAll(".mobile-card-tile, .public-card-tile, .collection-viewer-card-shell").forEach((shell) => {
    const shouldScale = isMobileCardLayout()
      || shell.classList.contains("public-card-tile")
      || Boolean(shell.closest(".public-showcase-grid"));
    if (!shouldScale) return;
    const scale = shell.getBoundingClientRect().width / 300;
    const cardScale = shell.querySelector(":scope > .mobile-card-scale");
    if (cardScale && scale > 0) cardScale.style.setProperty("--collection-card-scale", scale.toFixed(5));
  });
}

function observeResponsiveCardSizes() {
  mobileCardScaleObserver?.disconnect();
  mobileCardScaleObserver = null;
  if (window.ResizeObserver) {
    mobileCardScaleObserver = new ResizeObserver(scaleResponsiveCards);
    const selector = isMobileCardLayout()
      ? ".collection-grid, .showcase-slots, .public-showcase-grid, .public-grid"
      : ".public-showcase-grid, .public-grid";
    document.querySelectorAll(selector).forEach((container) => {
      mobileCardScaleObserver.observe(container);
    });
  }
  requestAnimationFrame(scaleResponsiveCards);
}

function restoreMobileCollectionImages() {
  document.querySelectorAll(".collection-grid img[data-mobile-poster-src]").forEach((image) => {
    if (!image.getAttribute("src")) image.setAttribute("src", image.dataset.mobilePosterSrc);
  });
}

function observeMobileCollectionImages() {
  mobileCollectionImageObserver?.disconnect();
  mobileCollectionImageObserver = null;
  if (!isMobileCardLayout() || state.view !== "collection" || !window.IntersectionObserver) {
    restoreMobileCollectionImages();
    return;
  }

  mobileCollectionImageObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const image = entry.target;
      if (entry.isIntersecting) {
        if (!image.getAttribute("src")) image.setAttribute("src", image.dataset.mobilePosterSrc);
        return;
      }
      const source = image.getAttribute("src");
      if (!source) return;
      image.dataset.mobilePosterSrc = source;
      image.removeAttribute("src");
    });
  }, { rootMargin: "1000px 0px" });

  document.querySelectorAll(".collection-grid .mobile-card-tile img").forEach((image) => {
    image.dataset.mobilePosterSrc = image.getAttribute("src") || image.dataset.mobilePosterSrc || "";
    if (image.dataset.mobilePosterSrc) mobileCollectionImageObserver.observe(image);
  });
}

function renderMobileCollectionWindow(startRow, totalRows) {
  const grid = document.querySelector(".collection-grid");
  if (!grid || !isMobileCardLayout() || state.view !== "collection") return;
  const maxStartRow = Math.max(0, totalRows - MOBILE_COLLECTION_WINDOW_ROWS);
  const nextStartRow = Math.max(0, Math.min(startRow, maxStartRow));
  const nextEndRow = Math.min(totalRows, nextStartRow + MOBILE_COLLECTION_WINDOW_ROWS);
  if (
    nextStartRow === mobileCollectionWindowStartRow
    && nextEndRow === mobileCollectionWindowEndRow
  ) {
    applyCollectionGridWindow(grid, {
      totalRows,
      startRow: nextStartRow,
      endRow: nextEndRow,
    });
    return;
  }

  mobileCollectionWindowStartRow = nextStartRow;
  mobileCollectionWindowEndRow = nextEndRow;
  grid.innerHTML = collectionGridHtml(mobileCollectionVirtualItems.slice(
    nextStartRow * MOBILE_COLLECTION_COLUMNS,
    nextEndRow * MOBILE_COLLECTION_COLUMNS,
  ));
  applyCollectionGridWindow(grid, {
    totalRows,
    startRow: nextStartRow,
    endRow: nextEndRow,
  });
  scaleResponsiveCards();
  bindInteractiveCards(grid);
  bindMobileCardExperience({ skipVirtualSetup: true });
}

function updateMobileCollectionVirtualWindow({ force = false } = {}) {
  mobileCollectionVirtualFrame = 0;
  const grid = document.querySelector(".collection-grid");
  if (!grid || !isMobileCardLayout() || state.view !== "collection") return;
  const tile = grid.querySelector(".mobile-card-tile");
  const totalRows = Math.ceil(mobileCollectionVirtualItems.length / MOBILE_COLLECTION_COLUMNS);
  if (!tile || !totalRows) return;

  const styles = getComputedStyle(grid);
  const rowGap = Number.parseFloat(styles.rowGap) || 0;
  const tileHeight = tile.getBoundingClientRect().height;
  if (tileHeight <= 0) return;
  mobileCollectionRowStride = tileHeight + rowGap;
  applyCollectionGridWindow(grid, {
    totalRows,
    startRow: mobileCollectionWindowStartRow,
    endRow: mobileCollectionWindowEndRow,
  });
  if (state.cardViewer) return;

  const gridTop = grid.getBoundingClientRect().top + window.scrollY;
  const viewportStart = Math.max(0, window.scrollY - gridTop);
  const viewportEnd = Math.max(0, window.scrollY + window.innerHeight - gridTop);
  const visibleStartRow = Math.floor(viewportStart / mobileCollectionRowStride);
  const visibleEndRow = Math.ceil(viewportEnd / mobileCollectionRowStride);
  const guardRows = Math.max(3, Math.floor(MOBILE_COLLECTION_OVERSCAN_ROWS / 2));
  const needsEarlierRows = mobileCollectionWindowStartRow > 0
    && visibleStartRow < mobileCollectionWindowStartRow + guardRows;
  const needsLaterRows = mobileCollectionWindowEndRow < totalRows
    && visibleEndRow > mobileCollectionWindowEndRow - guardRows;
  if (!force && !needsEarlierRows && !needsLaterRows) return;

  renderMobileCollectionWindow(visibleStartRow - MOBILE_COLLECTION_OVERSCAN_ROWS, totalRows);
}

function scheduleMobileCollectionVirtualWindow() {
  if (mobileCollectionVirtualFrame) return;
  mobileCollectionVirtualFrame = requestAnimationFrame(() => {
    updateMobileCollectionVirtualWindow();
  });
}

function setupMobileCollectionVirtualization() {
  mobileCollectionVirtualAbortController?.abort();
  mobileCollectionVirtualAbortController = null;
  if (mobileCollectionVirtualFrame) cancelAnimationFrame(mobileCollectionVirtualFrame);
  mobileCollectionVirtualFrame = 0;
  if (!isMobileCardLayout() || state.view !== "collection") return;

  updateMobileCollectionVirtualWindow({ force: true });
  mobileCollectionVirtualAbortController = new AbortController();
  const { signal } = mobileCollectionVirtualAbortController;
  window.addEventListener("scroll", scheduleMobileCollectionVirtualWindow, { passive: true, signal });
  window.addEventListener("resize", scheduleMobileCollectionVirtualWindow, { passive: true, signal });
}

function openCardViewer(itemId, source) {
  if (!isMobileCardLayout()) return;
  const items = viewerItemsForSource(source);
  if (!items.some((item) => String(item.id) === String(itemId))) return;
  cardViewerReturnTarget = { itemId: String(itemId), source };
  cardViewerScrollY = window.scrollY;
  document.body.style.setProperty("--collection-viewer-scroll-top", `${-cardViewerScrollY}px`);
  state.cardViewer = { itemId, source };
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  render();
  requestAnimationFrame(() => document.querySelector(".collection-viewer-close")?.focus({ preventScroll: true }));
}

function closeCardViewer() {
  const returnTarget = cardViewerReturnTarget || {
    itemId: String(state.cardViewer?.itemId || ""),
    source: state.cardViewer?.source || "",
  };
  const scrollY = cardViewerScrollY;
  clearCardViewerState();
  render();
  window.scrollTo(0, scrollY);
  requestAnimationFrame(() => {
    const tile = [...document.querySelectorAll("[data-mobile-card-id]")]
      .find((entry) => entry.dataset.mobileCardId === returnTarget.itemId
        && entry.dataset.mobileCardSource === returnTarget.source);
    tile?.focus({ preventScroll: true });
  });
}

function stepCardViewer(delta) {
  const items = viewerItemsForSource();
  const index = cardViewerItemIndex(items);
  const next = items[index + delta];
  if (!next) return false;
  state.cardViewer = { ...state.cardViewer, itemId: next.id };
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  render();
  requestAnimationFrame(() => document.querySelector(".collection-viewer-close")?.focus({ preventScroll: true }));
  return true;
}

function bindCardViewerSwipe(stage, signal) {
  const shell = stage.querySelector(".collection-viewer-card-shell");
  if (!shell || !window.PointerEvent) return;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let currentX = 0;
  let currentY = 0;
  let locked = false;
  let frame = 0;
  let suppressClick = false;

  const clearFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const clearStyles = () => {
    shell.classList.remove("is-swiping", "is-swipe-returning", "is-swipe-dismissed");
    shell.style.removeProperty("--collection-swipe-x");
    shell.style.removeProperty("--collection-swipe-rotate");
    shell.style.removeProperty("--collection-swipe-opacity");
  };
  const reset = () => {
    clearFrame();
    pointerId = null;
    locked = false;
  };
  const paint = () => {
    const width = shell.getBoundingClientRect().width || 300;
    const progress = Math.min(Math.abs(currentX) / width, 1);
    shell.style.setProperty("--collection-swipe-x", `${currentX.toFixed(1)}px`);
    shell.style.setProperty("--collection-swipe-rotate", `${Math.max(-7, Math.min(7, currentX / width * 8)).toFixed(2)}deg`);
    shell.style.setProperty("--collection-swipe-opacity", `${Math.max(.62, 1 - progress * .38).toFixed(2)}`);
    frame = 0;
  };

  stage.addEventListener("pointerdown", (event) => {
    const interactive = event.target.closest("button, a, input, select, textarea, form, [data-card-menu]");
    if (interactive && !event.target.closest(".poster-button")) return;
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startTime = performance.now();
    currentX = 0;
    currentY = 0;
    locked = false;
    clearStyles();
  }, { signal });

  stage.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    currentX = event.clientX - startX;
    currentY = event.clientY - startY;
    const distanceX = Math.abs(currentX);
    const distanceY = Math.abs(currentY);
    if (!locked) {
      if (distanceY > COLLECTION_SWIPE_LOCK_DISTANCE && distanceY > distanceX) {
        reset();
        return;
      }
      if (distanceX < COLLECTION_SWIPE_LOCK_DISTANCE || distanceX <= distanceY) return;
      locked = true;
      shell.classList.add("is-swiping");
      stage.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    if (!frame) frame = requestAnimationFrame(paint);
  }, { signal });

  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    clearFrame();
    if (!locked) {
      reset();
      return;
    }
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 450);
    const width = shell.getBoundingClientRect().width || 300;
    const elapsed = Math.max(1, performance.now() - startTime);
    const velocity = Math.abs(currentX) / elapsed;
    const threshold = Math.min(COLLECTION_SWIPE_MAX_DISTANCE, width * COLLECTION_SWIPE_RATIO);
    const delta = currentX < 0 ? 1 : -1;
    const items = viewerItemsForSource();
    const canStep = Boolean(items[cardViewerItemIndex(items) + delta]);
    const shouldStep = canStep && (
      Math.abs(currentX) >= threshold
      || (velocity >= COLLECTION_SWIPE_MIN_VELOCITY && Math.abs(currentX) >= COLLECTION_SWIPE_LOCK_DISTANCE * 2)
    );
    shell.classList.remove("is-swiping");
    if (shouldStep) {
      const direction = currentX < 0 ? -1 : 1;
      shell.style.setProperty("--collection-swipe-x", `${direction * (window.innerWidth + width)}px`);
      shell.style.setProperty("--collection-swipe-rotate", `${direction * 7}deg`);
      shell.style.setProperty("--collection-swipe-opacity", "0");
      shell.classList.add("is-swipe-dismissed");
      setTimeout(() => stepCardViewer(delta), 180);
    } else {
      shell.style.setProperty("--collection-swipe-x", "0px");
      shell.style.setProperty("--collection-swipe-rotate", "0deg");
      shell.style.setProperty("--collection-swipe-opacity", "1");
      shell.classList.add("is-swipe-returning");
      setTimeout(clearStyles, 220);
    }
    reset();
  };

  stage.addEventListener("pointerup", finish, { signal });
  stage.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== pointerId) return;
    reset();
    clearStyles();
  }, { signal });
  stage.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal });
}

function bindMobileCardExperience({ skipVirtualSetup = false } = {}) {
  cardViewerAbortController?.abort();
  cardViewerAbortController = new AbortController();
  const { signal } = cardViewerAbortController;
  const mobile = isMobileCardLayout();
  observeResponsiveCardSizes();
  observeMobileCollectionImages();

  document.querySelectorAll(".mobile-card-tile").forEach((tile) => {
    const card = tile.querySelector(":scope > .mobile-card-scale > .card");
    if (card) {
      card.inert = mobile;
      if (mobile) card.setAttribute("aria-hidden", "true");
      else card.removeAttribute("aria-hidden");
    }
    if (!mobile) {
      tile.removeAttribute("tabindex");
      tile.removeAttribute("role");
      tile.removeAttribute("aria-label");
      return;
    }
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", tile.dataset.mobileCardLabel || "Agrandir la carte");
    tile.addEventListener("click", () => {
      openCardViewer(tile.dataset.mobileCardId, tile.dataset.mobileCardSource);
    }, { signal });
    tile.addEventListener("keydown", (event) => {
      if (event.target !== tile || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      openCardViewer(tile.dataset.mobileCardId, tile.dataset.mobileCardSource);
    }, { signal });
  });

  const backdrop = document.querySelector("[data-collection-viewer-backdrop]");
  const stage = document.querySelector("[data-collection-viewer-stage]");
  if (backdrop && stage) {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeCardViewer();
    }, { signal });
    document.querySelector("[data-collection-viewer-close]")?.addEventListener("click", closeCardViewer, { signal });
    document.querySelectorAll("[data-collection-viewer-step]").forEach((button) => {
      button.addEventListener("click", () => stepCardViewer(Number(button.dataset.collectionViewerStep)), { signal });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCardViewer();
        return;
      }
      if (event.key === "Tab") {
        const viewer = document.querySelector(".collection-viewer");
        const focusable = [...viewer.querySelectorAll(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
        )].filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const currentIndex = focusable.indexOf(document.activeElement);
        const nextIndex = event.shiftKey
          ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
          : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
        if (currentIndex < 0 || (event.shiftKey && currentIndex === 0) || (!event.shiftKey && currentIndex === focusable.length - 1)) {
          event.preventDefault();
          focusable[nextIndex].focus();
        }
        return;
      }
      if (event.target.closest("input, select, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        stepCardViewer(event.key === "ArrowLeft" ? -1 : 1);
      }
    }, { signal });
    bindCardViewerSwipe(stage, signal);
  }
  if (!skipVirtualSetup) setupMobileCollectionVirtualization();
}

// ---------------------------------------------------------------------------
// Vue Classement
// ---------------------------------------------------------------------------

function filteredLeaderboard() {
  const q = state.leaderboardQuery.trim().toLowerCase();
  return state.leaderboard
    .filter((entry) => !q || entry.username.toLowerCase().includes(q))
    .map((entry, _, arr) => ({
      ...entry,
      rank: state.leaderboard.findIndex((item) => item.username === entry.username) + 1,
    }));
}

function renderLeaderboard() {
  if (requireLogin()) return;
  const selected = state.publicCollection;
  const leaderboardEntries = filteredLeaderboard();
  renderShell(`
    <section class="leaderboard-layout">
      <div class="panel stack leaderboard-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Progression</p>
            <h1>Classement</h1>
          </div>
          <span class="credits-stamp">${state.leaderboard.length} joueurs</span>
        </div>
        <input id="leaderboardSearch" placeholder="Rechercher un joueur" value="${escapeHtml(state.leaderboardQuery)}" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
        <div class="leaderboard-list" role="region" aria-label="Classement des joueurs" tabindex="0">
          ${leaderboardEntries.map(leaderboardRowHtml).join("") || `<p>Aucun joueur trouvé.</p>`}
        </div>
      </div>
      <div class="panel stack public-collection-panel">
        ${selected ? publicCollectionHtml(selected) : `
          <div class="empty-public-collection">
            <p class="eyebrow">Collection publique</p>
            <h2>Choisis un joueur</h2>
            <p class="muted-copy">Clique sur une ligne du classement pour consulter ses cartes obtenues.</p>
          </div>
        `}
      </div>
    </section>
    ${cardViewerMarkup()}
  `);
  $("#leaderboardSearch")?.addEventListener("input", (event) => {
    state.leaderboardQuery = event.target.value;
    renderLeaderboardList({ resetScroll: true });
  });
  bindLeaderboardScroll();
  ["publicQ", "publicRarity", "publicOwned"].forEach((id) => {
    $("#" + id)?.addEventListener("input", (event) => {
      const key = id === "publicQ" ? "q" : id === "publicRarity" ? "rarity" : "owned";
      state.publicFilters[key] = event.target.value;
      renderPublicCollectionGrid();
    });
  });
  document.querySelectorAll("[data-public-user]").forEach((button) => {
    button.addEventListener("click", () => loadPublicCollection(button.dataset.publicUser));
  });
}

function bindLeaderboardScroll() {
  const list = document.querySelector(".leaderboard-list");
  if (!list) return;
  list.addEventListener("keydown", (event) => {
    if (event.target !== list) return;
    const row = list.querySelector(".leaderboard-row");
    const rowHeight = row?.getBoundingClientRect().height || 72;
    const rowGap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
    const rowStep = rowHeight + rowGap;
    const pageStep = list.clientHeight;
    let nextScrollTop = null;
    if (event.key === "ArrowDown") nextScrollTop = list.scrollTop + rowStep;
    else if (event.key === "ArrowUp") nextScrollTop = list.scrollTop - rowStep;
    else if (event.key === "PageDown") nextScrollTop = list.scrollTop + pageStep;
    else if (event.key === "PageUp") nextScrollTop = list.scrollTop - pageStep;
    else if (event.key === "Home") nextScrollTop = 0;
    else if (event.key === "End") nextScrollTop = list.scrollHeight;
    if (nextScrollTop === null) return;
    event.preventDefault();
    list.scrollTop = Math.max(0, Math.min(nextScrollTop, list.scrollHeight - list.clientHeight));
  });
}

function loadLeaderboard() {
  // Rafraichit le classement en arriere-plan puis met a jour la vue si on y est encore.
  return api("/api/leaderboard")
    .then((data) => {
      state.leaderboard = data.leaderboard || [];
      if (state.view !== "leaderboard") return;
      // Full render (maj du compteur de joueurs) sauf si l'utilisateur tape une recherche.
      if (document.getElementById("leaderboardSearch") !== document.activeElement) render();
      else renderLeaderboardList();
    })
    .catch(() => {});
}

function renderLeaderboardList({ resetScroll = false } = {}) {
  const list = document.querySelector(".leaderboard-list");
  if (!list) return render();
  const entries = filteredLeaderboard();
  list.innerHTML = entries.map(leaderboardRowHtml).join("") || `<p>Aucun joueur trouvé.</p>`;
  if (resetScroll) list.scrollTop = 0;
  document.querySelectorAll("[data-public-user]").forEach((button) => {
    button.addEventListener("click", () => loadPublicCollection(button.dataset.publicUser));
  });
}

function renderPublicCollectionGrid() {
  const grid = document.querySelector(".public-grid");
  if (!grid) return render();
  const items = filteredPublicCollection();
  grid.innerHTML = items.map(publicCollectionCardHtml).join("") || `<p>Aucune carte trouvée.</p>`;
  bindCardTilt();
  requestAnimationFrame(scaleResponsiveCards);
}

async function loadPublicCollection(username) {
  try {
    clearCardViewerState();
    state.publicCollection = await api(`/api/users/${encodeURIComponent(username)}/collection`);
    render();
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

// ---------------------------------------------------------------------------
// Vue Connexion / Compte
// ---------------------------------------------------------------------------

function renderLogin() {
  renderShell(`
    <section class="stack">
      ${state.user ? accountPanelHtml() : loginForms()}
    </section>
  `);
  if (state.user) {
    $("#letterboxdProfile").addEventListener("submit", updateLetterboxdProfile);
    $("#unlinkLetterboxd")?.addEventListener("click", () => saveLetterboxdUsername(""));
    $("#resetCollection").addEventListener("click", resetCollection);
    $("#regenerateKey").addEventListener("click", regenerateConnectionKey);
    $("#logout").addEventListener("click", () => {
      localStorage.removeItem("gachaUser");
      state.user       = null;
      state.collection = [];
      state.collectionSummary = null;
      state.leaderboard = [];
      state.achievements = [];
      state.achievementQueue = [];
      state.notifications = [];
      state.notificationsLoaded = false;
      state.unreadNotificationCount = 0;
      state.notificationHighlightIds = [];
      state.publicCollection = null;
      state.pendingRoll = null;
      state.result = null;
      state.resultIndex = 0;
      state.view = "login";
      render();
    });
  } else {
    bindLogin();
  }
}

async function updateLetterboxdProfile(event) {
  event.preventDefault();
  const username = new FormData(event.currentTarget).get("letterboxdUsername");
  await saveLetterboxdUsername(username);
}

async function saveLetterboxdUsername(username) {
  try {
    const updated = await api("/api/profile/letterboxd", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    mergeUser(updated);
    showToast(updated.letterboxdUsername ? "Profil Letterboxd enregistré." : "Profil Letterboxd supprimé.", "success");
    renderLogin();
  } catch (e) {
    showToast(e.message, "error");
  }
}

function bindLogin() {
  $("#createUser")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = new FormData(event.currentTarget).get("username");
    try {
      const created = await api("/api/users", { method: "POST", body: JSON.stringify({ username }) });
      saveUser(created);
      const copied = await copyConnectionKey(created.connectionKey);
      state.keyModal = { key: created.connectionKey, copied };
      await refresh({ shouldRender: false });
      state.view = "gacha";
      render();
    } catch (e) {
      showToast(e.message, "error");
      renderLogin();
    }
  });
  $("#loginUser")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const session = await api("/api/session", { method: "POST", body: JSON.stringify(data) });
      saveUser({ ...data, ...session });
      state.view = "gacha";
      await refresh();
    } catch (e) {
      showToast(e.message, "error");
      renderLogin();
    }
  });
}

async function regenerateConnectionKey() {
  if (!confirm("Regénérer ta clé de connexion ? L'ancienne clé ne fonctionnera plus.")) return;
  try {
    const updated = await api("/api/session/key", { method: "POST", body: "{}" });
    saveUser({ ...state.user, ...updated });
    const copied = await copyConnectionKey(updated.connectionKey);
    state.keyModal = { key: updated.connectionKey, copied };
    render();
  } catch (e) {
    showToast(e.message, "error");
    renderLogin();
  }
}

async function resetCollection() {
  if (!confirm("Reset toute ta collection, tes cartes vues, tes échanges, tes succès et tes notifications ?")) return;
  try {
    const reset = await api("/api/collection/reset", { method: "POST", body: "{}" });
    mergeUser(reset);
    state.collection  = [];
    state.collectionSummary = null;
    state.trades      = [];
    state.achievements = [];
    state.achievementQueue = [];
    state.notifications = [];
    state.notificationsLoaded = true;
    state.unreadNotificationCount = 0;
    state.notificationHighlightIds = [];
    state.result      = null;
    state.resultIndex = 0;
    state.pendingRoll = null;
    showToast("Collection reset.", "success");
    await refresh();
    state.view = "login";
    render();
  } catch (e) {
    showToast(e.message, "error");
    renderLogin();
  }
}

// ---------------------------------------------------------------------------
// Actions sur les cartes
// ---------------------------------------------------------------------------

async function sellCard(itemId) {
  try {
    const sold = await api("/api/collection/sell", { method: "POST", body: JSON.stringify({ itemId }) });
    mergeUser(sold);
    handleNewAchievements(sold);
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    showToast(`Carte vendue +${sold.earned}¥.`, "success");
    await refresh({ shouldRender: false });
    render();
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

async function sendCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const itemId = form.dataset.sendItemId;
  const input = form.querySelector("[data-recipient-input]");
  const toUsername = form.dataset.selectedRecipient || "";
  if (!toUsername || input?.value !== toUsername) {
    showToast("Choisis un destinataire dans la liste.", "error");
    resetRecipientCombobox(form);
    return;
  }
  try {
    const sent = await api("/api/trades", { method: "POST", body: JSON.stringify({ offerItemId: itemId, toUsername }) });
    handleNewAchievements(sent);
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    showToast("Carte envoyee.", "success");
    await refresh({ shouldRender: false });
    render();
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

async function toggleSeen(event) {
  const button = event.currentTarget;
  const currentView = state.view;
  const nextSeen = button.dataset.seenNext === "1";
  try {
    const seenResult = await api("/api/collection/seen", {
      method: "POST",
      body: JSON.stringify({ itemId: button.dataset.seenId, seen: nextSeen }),
    });
    handleNewAchievements(seenResult);
    const item = state.collection.find((entry) => entry.id === button.dataset.seenId);
    if (item) item.seen = nextSeen;
    patchResultItems(button.dataset.seenId, { seen: nextSeen });
    state.view = currentView;
    await refresh({ shouldRender: false });
    state.view = currentView;
    document.querySelectorAll("[data-seen-id]").forEach((seenButton) => {
      if (seenButton.dataset.seenId === button.dataset.seenId) {
        updateSeenButton(seenButton, nextSeen);
      }
    });
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

function updateSeenButton(button, seen) {
  button.classList.toggle("seen", seen);
  button.dataset.seenNext = seen ? "0" : "1";
  button.textContent = seen ? "Vu" : "Pas vu";
}

async function toggleFavorite(event) {
  event.stopPropagation();
  const button = event.currentTarget;
  const itemId = button.dataset.favoriteId;
  const nextFavorite = button.dataset.favoriteNext === "1";
  try {
    const updated = await api("/api/collection/favorite", {
      method: "POST",
      body: JSON.stringify({ itemId, favorite: nextFavorite }),
    });
    handleNewAchievements(updated);
    const item = state.collection.find((entry) => entry.id === itemId);
    if (item) { item.favorite = updated.favorite; item.watchlist = updated.watchlist; }
    patchResultItems(itemId, { favorite: updated.favorite, watchlist: updated.watchlist });
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    render();
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

async function toggleWatchlist(event) {
  event.stopPropagation();
  const button = event.currentTarget;
  const itemId = button.dataset.watchlistId;
  const nextWatchlist = button.dataset.watchlistNext === "1";
  try {
    const updated = await api("/api/collection/watchlist", {
      method: "POST",
      body: JSON.stringify({ itemId, watchlist: nextWatchlist }),
    });
    handleNewAchievements(updated);
    const item = state.collection.find((entry) => entry.id === itemId);
    if (item) { item.favorite = updated.favorite; item.watchlist = updated.watchlist; }
    patchResultItems(itemId, { favorite: updated.favorite, watchlist: updated.watchlist });
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    render();
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

async function setShowcaseSlot(itemId, slot) {
  try {
    const updated = await api("/api/collection/showcase", {
      method: "POST",
      body: JSON.stringify({ itemId, slot }),
    });
    if (Array.isArray(updated.items)) {
      const previousItems = new Map(state.collection.map((item) => [item.id, item]));
      state.collection = updated.items.map((item) => {
        const previous = previousItems.get(item.id);
        return previous && Object.prototype.hasOwnProperty.call(previous, "obtainedAt")
          ? { ...item, obtainedAt: previous.obtainedAt }
          : item;
      });
      syncResultItems(state.collection);
    }
    if (typeof updated.credits === "number") mergeUser(updated);
    handleNewAchievements(updated);
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    showToast(slot === null ? "Carte retiree de la vitrine." : "Vitrine mise a jour.", "success");
    render();
  } catch (e) {
    showToast(e.message, "error");
    render();
  }
}

async function createTrade(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const sent = await api("/api/trades", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    handleNewAchievements(sent);
    showToast("Carte envoyee.", "success");
    await refresh();
  } catch (e) {
    showToast(e.message, "error");
    renderTrade();
  }
}

function renderTrade() {
  if (requireLogin()) return;
  const dupes = state.collection.filter((item) => item.count >= 2);
  renderShell(`
    <section class="panel stack">
      <h1>Echanges</h1>
      <form class="form" id="tradeForm">
        <label>Pseudo du destinataire<input name="toUsername" placeholder="Nom d'utilisateur"></label>
        <label>Carte à envoyer<select name="offerItemId">${dupes.map((i) => `<option value="${i.id}">${escapeHtml(i.name)} x${i.count}</option>`).join("")}</select></label>
        <button class="primary" ${!dupes.length ? "disabled" : ""}>Envoyer</button>
      </form>
      ${!dupes.length ? `<p class="muted-copy">Il faut au moins un doublon pour envoyer une carte.</p>` : ""}
      <div class="stack">${state.trades.map(tradeHtml).join("") || `<p>Aucun echange pour l'instant.</p>`}</div>
    </section>
  `);
  $("#tradeForm").addEventListener("submit", createTrade);
}

function tradeHtml(trade) {
  const incoming = trade.toUser === state.user.username;
  return `
    <article class="trade-row">
      <div><strong>${escapeHtml(trade.fromUser)}</strong> ${incoming ? "t'a envoyé" : "a reçu"}<br>${escapeHtml(trade.offer.name)} <span class="rarity ${trade.offer.rarity}">${trade.offer.rarity}</span></div>
      <div class="small">${incoming ? "Reçu" : `Envoyé à ${escapeHtml(trade.toUser)}`}</div>
    </article>
  `;
}

async function copyConnectionKey(key) {
  if (!navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(key); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// Interactions cartes (poster menu, tilt)
// ---------------------------------------------------------------------------

function bindCardTilt(root = document) {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  root.querySelectorAll(".card").forEach((card) => {
    let frame = 0, targetX = 0, targetY = 0;
    // will-change uniquement pendant l'interaction : pas de couche de composition permanente.
    card.addEventListener("pointerenter", () => { card.style.willChange = "transform"; });
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      targetY = (x - 0.5) * 7;
      targetX = (0.5 - y) * 7;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        card.style.setProperty("--tilt-x", `${targetX.toFixed(2)}deg`);
        card.style.setProperty("--tilt-y", `${targetY.toFixed(2)}deg`);
        frame = 0;
      });
    });
    card.addEventListener("pointerleave", () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      card.style.removeProperty("--tilt-x");
      card.style.removeProperty("--tilt-y");
      card.style.willChange = "";
    });
  });
}

function setPosterMenu(menuKey, open, showSend = false) {
  document.querySelectorAll("[data-card-menu]").forEach((menu) => {
    const isTarget = menu.dataset.cardMenu === menuKey;
    menu.classList.toggle("is-open", Boolean(open && isTarget));
  });
  document.querySelectorAll("[data-send-form]").forEach((form) => {
    const isTarget = form.dataset.sendForm === menuKey;
    form.classList.toggle("is-open", Boolean(open && showSend && isTarget));
    if (!open || !showSend || !isTarget) {
      form.reset();
      resetRecipientCombobox(form);
    }
  });
}

function recipientMatches(query) {
  const normalizedQuery = query.trim().toLowerCase();
  const currentUsername = (state.user?.username || "").toLowerCase();
  if (!normalizedQuery) return [];
  return state.users
    .filter((username) => {
      const normalizedUsername = username.toLowerCase();
      return normalizedUsername !== currentUsername && normalizedUsername.includes(normalizedQuery);
    })
    .slice(0, 8);
}

function resetRecipientCombobox(form) {
  const input = form.querySelector("[data-recipient-input]");
  const list = form.querySelector("[data-recipient-list]");
  const submit = form.querySelector("[data-recipient-submit]");
  delete form.dataset.selectedRecipient;
  if (submit) submit.disabled = true;
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  if (list) {
    list.hidden = true;
    list.innerHTML = "";
  }
}

function bindRecipientCombobox(form, formIndex) {
  const input = form.querySelector("[data-recipient-input]");
  const list = form.querySelector("[data-recipient-list]");
  const submit = form.querySelector("[data-recipient-submit]");
  if (!input || !list || !submit) return;

  const listId = `recipient-list-${formIndex}`;
  list.id = listId;
  input.setAttribute("aria-controls", listId);
  let matches = [];
  let activeIndex = -1;

  const closeSuggestions = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  };

  const setActiveOption = (nextIndex) => {
    if (!matches.length) return;
    activeIndex = (nextIndex + matches.length) % matches.length;
    list.querySelectorAll("[data-recipient-option]").forEach((option, index) => {
      const isActive = index === activeIndex;
      option.classList.toggle("is-active", isActive);
      option.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) input.setAttribute("aria-activedescendant", option.id);
    });
    list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  };

  const selectRecipient = (username) => {
    input.value = username;
    form.dataset.selectedRecipient = username;
    submit.disabled = false;
    closeSuggestions();
    input.focus();
  };

  const renderSuggestions = () => {
    delete form.dataset.selectedRecipient;
    submit.disabled = true;
    matches = recipientMatches(input.value);
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");

    if (!input.value.trim()) {
      closeSuggestions();
      list.innerHTML = "";
      return;
    }

    if (!matches.length) {
      list.innerHTML = `<div class="recipient-suggestion-empty" role="option" aria-disabled="true">Aucun utilisateur trouvé</div>`;
    } else {
      list.innerHTML = matches.map((username, index) => `
        <div class="recipient-suggestion" id="${listId}-option-${index}" role="option" aria-selected="false" data-recipient-option data-username="${escapeHtml(username)}">${escapeHtml(username)}</div>
      `).join("");
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSuggestions();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden && input.value.trim()) renderSuggestions();
      if (!matches.length) return;
      setActiveOption(event.key === "ArrowDown" ? activeIndex + 1 : activeIndex - 1);
      return;
    }
    if (event.key === "Enter" && !list.hidden) {
      event.preventDefault();
      if (activeIndex >= 0) selectRecipient(matches[activeIndex]);
    }
  });
  input.addEventListener("blur", () => setTimeout(closeSuggestions, 0));
  list.addEventListener("pointerdown", (event) => {
    const option = event.target.closest("[data-recipient-option]");
    if (!option) return;
    // Garde le focus dans le champ jusqu'au clic complet. Masquer la liste dès
    // pointerdown ferait retomber le clic sur un bouton placé dessous sur mobile.
    event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-recipient-option]");
    if (!option) return;
    selectRecipient(option.dataset.username);
  });
  list.addEventListener("pointermove", (event) => {
    const option = event.target.closest("[data-recipient-option]");
    if (!option) return;
    const optionIndex = [...list.querySelectorAll("[data-recipient-option]")].indexOf(option);
    if (optionIndex >= 0 && optionIndex !== activeIndex) setActiveOption(optionIndex);
  });
  resetRecipientCombobox(form);
}

function bindInteractiveCards(root = document) {
  root.querySelectorAll("[data-seen-id]").forEach((button) =>
    button.addEventListener("click", toggleSeen));
  root.querySelectorAll("[data-favorite-id]").forEach((button) =>
    button.addEventListener("click", toggleFavorite));
  root.querySelectorAll("[data-watchlist-id]").forEach((button) =>
    button.addEventListener("click", toggleWatchlist));
  root.querySelectorAll("[data-showcase-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const rawSlot = button.dataset.showcaseSlot;
      setShowcaseSlot(button.dataset.showcaseId, rawSlot ? Number(rawSlot) : null);
    });
  });
  root.querySelectorAll("[data-showcase-move]").forEach((button) => {
    button.addEventListener("click", () =>
      setShowcaseSlot(button.dataset.showcaseMove, Number(button.dataset.showcaseSlot)));
  });
  root.querySelectorAll("[data-poster-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menuKey = button.dataset.posterMenu;
      const wasOpen = state.activeCardMenu === menuKey;
      state.activeCardMenu = wasOpen ? null : menuKey;
      state.cardMenuMode = null;
      setPosterMenu(menuKey, !wasOpen);
    });
  });
  root.querySelectorAll("[data-sell-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      sellCard(button.dataset.sellId);
    });
  });
  root.querySelectorAll("[data-send-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menuKey = button.dataset.sendToggle;
      const shouldOpen = state.activeCardMenu !== menuKey || state.cardMenuMode !== "send";
      state.activeCardMenu = menuKey;
      state.cardMenuMode = shouldOpen ? "send" : null;
      setPosterMenu(menuKey, true, shouldOpen);
    });
  });
  root.querySelectorAll("[data-send-form]").forEach((form, formIndex) => {
    bindRecipientCombobox(form, formIndex);
    form.addEventListener("submit", sendCard);
    form.addEventListener("click", (event) => event.stopPropagation());
  });
  bindCardTilt(root);
}

// ---------------------------------------------------------------------------
// Vue Succès
// ---------------------------------------------------------------------------

function loadAchievements() {
  // Rafraichit la progression des succes en arriere-plan puis re-rend si on y est encore.
  return api("/api/achievements")
    .then((data) => {
      state.achievements = data.achievements || [];
      if (state.view === "achievements") renderShell(achievementsViewHtml());
    })
    .catch(() => {});
}

function renderAchievements() {
  if (requireLogin()) return;
  renderShell(achievementsViewHtml());
  // Filet pour le tout premier affichage si le cache est vide (sinon l'onglet declenche
  // deja un rafraichissement en arriere-plan via loadAchievements).
  if (!state.achievements.length) loadAchievements();
}

// ---------------------------------------------------------------------------
// Vue Notifications
// ---------------------------------------------------------------------------

function renderNotifications() {
  if (requireLogin()) return;
  renderNotificationsView();
  loadNotifications();
}

// ---------------------------------------------------------------------------
// Rendu principal
// ---------------------------------------------------------------------------

function render() {
  if (!state.user && state.view !== "login") state.view = "login";
  normalizeCardViewerState();
  if      (state.view === "collection")   renderCollection();
  else if (state.view === "leaderboard")  renderLeaderboard();
  else if (state.view === "achievements") renderAchievements();
  else if (state.view === "notifications") renderNotifications();
  else if (state.view === "login")        renderLogin();
  else                                    renderGacha();
  document.body.classList.toggle("is-result-open", state.view === "gacha" && Boolean(state.result));
  document.body.classList.toggle(
    "is-collection-viewer-open",
    isMobileCardLayout() && Boolean(state.cardViewer),
  );
  bindInteractiveCards();
  if (state.view === "collection" || state.view === "leaderboard") bindMobileCardExperience();
  else {
    cardViewerAbortController?.abort();
    mobileCardScaleObserver?.disconnect();
    mobileCollectionImageObserver?.disconnect();
    mobileCollectionVirtualAbortController?.abort();
  }
}

document.addEventListener("click", (event) => {
  if (!state.activeCardMenu || event.target.closest(".card-action-area")) return;
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  setPosterMenu("", false);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.user) return;
  if (state.view === "notifications") loadNotifications({ showErrors: false });
  else refreshUnreadNotificationCount();
});

window.addEventListener("resize", () => {
  requestAnimationFrame(scaleResponsiveCards);
});

MOBILE_CARD_QUERY.addEventListener("change", () => {
  mobileCollectionWindowStartRow = 0;
  mobileCollectionWindowEndRow = 0;
  mobileCollectionRowStride = 0;
  if (!isMobileCardLayout() && state.cardViewer) {
    closeCardViewer();
    return;
  }
  if (state.view === "collection") {
    render();
    return;
  }
  if (state.view === "leaderboard") bindMobileCardExperience();
});

loadRelease().finally(() => refresh());
