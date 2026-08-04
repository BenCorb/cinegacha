import {
  state,
  RARITIES, ROLL_COST,
  api, mergeUser, preloadImage, saveUser,
  creditTimerText, escapeHtml, loadRelease, serverNowMs,
} from "./js/state.js?v=letterboxd-2";
import {
  accountPanelHtml, achievementsViewHtml, applyCollectionFilters, burstHtml,
  collectionEmptyHtml, collectionGridHtml, collectionStatsHtml,
  creditsPanelHtml, dropRatesHtml, filterCountText, filteredCollection,
  filteredPublicCollection, hasActiveFilters, keyModalHtml, leaderboardRowHtml,
  loginForms, nav, notificationsViewHtml, publicCardHtml, publicCollectionHtml, resultHtml, showcaseEditorHtml,
  walletHtml,
} from "./js/components.js?v=letterboxd-2";

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
      <datalist id="users-datalist">
        ${state.users.filter((u) => u !== state.user?.username).map((u) => `<option value="${escapeHtml(u)}">`).join("")}
      </datalist>
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

function renderCollection() {
  if (requireLogin()) return;
  const items = filteredCollection();
  const active = hasActiveFilters();
  renderShell(`
    <section class="panel">
      ${collectionStatsHtml()}
      ${showcaseEditorHtml()}
      <div class="filters">
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
      </div>
      <div class="filter-meta">
        <span class="filter-count">${filterCountText(items.length)}</span>
        <button class="ghost filter-reset ${active ? "is-active" : ""}" id="resetFilters" type="button">Effacer les filtres</button>
      </div>
      <div class="grid collection-grid">${items.length ? collectionGridHtml(items) : collectionEmptyHtml()}</div>
    </section>
  `);
  ["q", "rarity", "owned"].forEach((id) => {
    $("#" + id).addEventListener("input", (event) => {
      state.filters[id === "q" ? "q" : id] = event.target.value;
      renderCollectionGrid();
    });
  });
  $("#resetFilters")?.addEventListener("click", () => {
    state.filters = { q: "", rarity: "all", owned: "all" };
    render();
  });
}

function renderCollectionGrid() {
  const grid = document.querySelector(".collection-grid");
  if (!grid) return render();
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  const items = filteredCollection();
  grid.innerHTML = items.length ? collectionGridHtml(items) : collectionEmptyHtml();
  const countEl = document.querySelector(".filter-count");
  if (countEl) countEl.textContent = filterCountText(items.length);
  const active = hasActiveFilters();
  document.querySelector(".filter-reset")?.classList.toggle("is-active", active);
  bindInteractiveCards();
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
        <div class="leaderboard-list">
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
  `);
  $("#leaderboardSearch")?.addEventListener("input", (event) => {
    state.leaderboardQuery = event.target.value;
    renderLeaderboardList();
  });
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

function renderLeaderboardList() {
  const list = document.querySelector(".leaderboard-list");
  if (!list) return render();
  const entries = filteredLeaderboard();
  list.innerHTML = entries.map(leaderboardRowHtml).join("") || `<p>Aucun joueur trouvé.</p>`;
  document.querySelectorAll("[data-public-user]").forEach((button) => {
    button.addEventListener("click", () => loadPublicCollection(button.dataset.publicUser));
  });
}

function renderPublicCollectionGrid() {
  const grid = document.querySelector(".public-grid");
  if (!grid) return render();
  const items = filteredPublicCollection();
  grid.innerHTML = items.map(publicCardHtml).join("") || `<p>Aucune carte trouvée.</p>`;
  bindCardTilt();
}

async function loadPublicCollection(username) {
  try {
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
  const data = Object.fromEntries(new FormData(form));
  try {
    const sent = await api("/api/trades", { method: "POST", body: JSON.stringify({ offerItemId: itemId, toUsername: data.toUsername }) });
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
      state.collection = updated.items;
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

function bindCardTilt() {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  document.querySelectorAll(".card").forEach((card) => {
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
    if (!open || !showSend || !isTarget) form.reset();
  });
}

function bindInteractiveCards() {
  document.querySelectorAll("[data-seen-id]").forEach((button) =>
    button.addEventListener("click", toggleSeen));
  document.querySelectorAll("[data-favorite-id]").forEach((button) =>
    button.addEventListener("click", toggleFavorite));
  document.querySelectorAll("[data-watchlist-id]").forEach((button) =>
    button.addEventListener("click", toggleWatchlist));
  document.querySelectorAll("[data-showcase-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const rawSlot = button.dataset.showcaseSlot;
      setShowcaseSlot(button.dataset.showcaseId, rawSlot ? Number(rawSlot) : null);
    });
  });
  document.querySelectorAll("[data-showcase-move]").forEach((button) => {
    button.addEventListener("click", () =>
      setShowcaseSlot(button.dataset.showcaseMove, Number(button.dataset.showcaseSlot)));
  });
  document.querySelectorAll("[data-showcase-remove]").forEach((button) => {
    button.addEventListener("click", () => setShowcaseSlot(button.dataset.showcaseRemove, null));
  });
  document.querySelectorAll("[data-poster-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menuKey = button.dataset.posterMenu;
      const wasOpen = state.activeCardMenu === menuKey;
      state.activeCardMenu = wasOpen ? null : menuKey;
      state.cardMenuMode = null;
      setPosterMenu(menuKey, !wasOpen);
    });
  });
  document.querySelectorAll("[data-sell-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      sellCard(button.dataset.sellId);
    });
  });
  document.querySelectorAll("[data-send-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menuKey = button.dataset.sendToggle;
      const shouldOpen = state.activeCardMenu !== menuKey || state.cardMenuMode !== "send";
      state.activeCardMenu = menuKey;
      state.cardMenuMode = shouldOpen ? "send" : null;
      setPosterMenu(menuKey, true, shouldOpen);
    });
  });
  document.querySelectorAll("[data-send-form]").forEach((form) => {
    form.addEventListener("submit", sendCard);
    form.addEventListener("click", (event) => event.stopPropagation());
  });
  bindCardTilt();
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
  if      (state.view === "collection")   renderCollection();
  else if (state.view === "leaderboard")  renderLeaderboard();
  else if (state.view === "achievements") renderAchievements();
  else if (state.view === "notifications") renderNotifications();
  else if (state.view === "login")        renderLogin();
  else                                    renderGacha();
  document.body.classList.toggle("is-result-open", state.view === "gacha" && Boolean(state.result));
  bindInteractiveCards();
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

loadRelease().finally(() => refresh());
