import {
  state,
  RARITIES, ROLL_COST,
  api, mergeUser, preloadImage, saveUser,
  creditTimerText, escapeHtml, loadRelease, serverNowMs,
} from "./js/state.js";
import {
  accountPanelHtml, applyCollectionFilters, burstHtml,
  cardHtml, collectionEmptyHtml, collectionStatsHtml,
  creditsPanelHtml, dropRatesHtml, filterCountText, filteredCollection,
  filteredPublicCollection, hasActiveFilters, keyModalHtml, leaderboardRowHtml,
  loginForms, nav, publicCardHtml, publicCollectionHtml, resultHtml, walletHtml,
} from "./js/components.js";

const $ = (selector) => document.querySelector(selector);

// ---------------------------------------------------------------------------
// Timer crédits
// ---------------------------------------------------------------------------

let creditTimerId = null;
let creditRefreshInFlight = false;
let messageTimer = null;

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
    const requests = [api("/api/collection"), api("/api/users")];
    if (needsLeaderboard) requests.push(api("/api/leaderboard"));
    const [collection, users, leaderboardData] = await Promise.all(requests);
    state.collection = collection.items;
    if (state.result?.item?.id) {
      const fresh = state.collection.find((item) => item.id === state.result.item.id);
      if (fresh) state.result.item = { ...fresh };
    }
    if (typeof collection.credits === "number") mergeUser(collection);
    state.users = users.users;
    if (leaderboardData) state.leaderboard = leaderboardData.leaderboard || [];
    if (shouldRender) render();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem("gachaUser");
      state.user       = null;
      state.collection = [];
      state.users      = [];
      state.trades     = [];
      state.leaderboard = [];
      state.publicCollection = null;
      state.pendingRoll = null;
      state.result = null;
      state.message = "Session expiree apres reset. Reconnecte-toi ou cree un compte.";
      state.view = "login";
      render();
      return;
    }
    state.message = error.message;
    render();
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderShell(content) {
  $("#app").innerHTML = `
    <main class="shell view-${state.view}">
      <header class="topbar">
        <button class="brand brand-button" id="refreshApp" type="button" aria-label="Rafraichir CinéGacha">
          <span class="logo"></span><span>CinéGacha</span>
        </button>
        ${state.user ? walletHtml() : ""}
        <nav class="nav">${nav()}</nav>
      </header>
      ${state.message ? `<div class="message">${escapeHtml(state.message)}</div>` : ""}
      ${content}
      ${keyModalHtml()}
      <datalist id="users-datalist">
        ${state.users.filter((u) => u !== state.user?.username).map((u) => `<option value="${escapeHtml(u)}">`).join("")}
      </datalist>
    </main>
  `;
  if (state.message) {
    if (messageTimer) clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      state.message = "";
      document.querySelector(".message")?.remove();
    }, 4000);
  }
  startCreditTimer();
  $("#refreshApp")?.addEventListener("click", () => window.location.reload());
  bindKeyModal();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const prevView = state.view;
      state.view = button.dataset.view;
      state.message = "";
      if (messageTimer) clearTimeout(messageTimer);
      if (state.view === "leaderboard" && prevView !== "leaderboard") {
        refresh({ shouldRender: true });
      } else {
        render();
      }
    });
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
  renderShell(`
    <section class="panel stack login-required">
      <h1>Avant de tourner la manette</h1>
      <p>Crée un nom d'utilisateur ou connecte-toi avec ta clé locale.</p>
      ${loginForms()}
    </section>
  `);
  bindLogin();
  return true;
}

// ---------------------------------------------------------------------------
// Vue Gachapon
// ---------------------------------------------------------------------------

function renderGacha() {
  if (requireLogin()) return;
  const canRoll = Number(state.user?.credits || 0) >= ROLL_COST;
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
            <div class="price">100¥</div>
            <button class="handle" id="roll" type="button" aria-label="Tourner la manette" ${state.pendingRoll || !canRoll || state.rolling ? "disabled" : ""}></button>
            <div class="chute"></div>
            ${state.pendingRoll ? `<button class="drop" id="open" type="button" aria-label="Ouvrir la capsule"></button>` : ""}
          </div>
        </div>
      </section>
      <section class="panel reveal ${state.result ? "has-result" : "empty-reveal"} ${state.opening ? `opening impact-${state.openingRarity}` : ""}">
        ${state.opening ? burstHtml() : ""}
        ${state.result ? resultHtml(state.result) : `<h1>Ta prochaine capsule attend.</h1><p>${canRoll ? "Chaque tirage coute 100¥." : "Pas assez de credits. Recharge automatique : 100¥ par heure."}</p>`}
      </section>
    </div>
  `);
  $("#roll").addEventListener("click", roll);
  $("#open")?.addEventListener("click", openCapsule);
  $("#closeResult")?.addEventListener("click", closeResult);
}

async function roll() {
  state.message = "";
  state.rolling = true;
  const btn = $("#roll");
  if (btn) btn.disabled = true;
  $(".machine")?.classList.add("spinning");
  try {
    state.pendingRoll = await api("/api/gacha/roll", { method: "POST", body: "{}" });
    if (typeof state.pendingRoll.credits === "number") mergeUser(state.pendingRoll);
    state.rolling = false;
    setTimeout(render, 650);
  } catch (e) {
    state.rolling = false;
    state.message = e.message;
    render();
  }
}

async function openCapsule() {
  const btn = $("#open");
  if (btn) btn.disabled = true;
  try {
    state.result = await api("/api/gacha/open", {
      method: "POST",
      body: JSON.stringify({ rollId: state.pendingRoll.rollId }),
    });
    state.pendingRoll = null;
    state.openingRarity = state.result.item.rarity || "C";
    state.opening = true;
    await refresh({ shouldRender: false });
    await preloadImage(state.result.item.image);
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
    state.message = e.message;
    render();
  }
}

function closeResult() {
  state.result = null;
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
      <div class="grid collection-grid">${items.length ? items.map(cardHtml).join("") : collectionEmptyHtml()}</div>
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
  grid.innerHTML = items.length ? items.map(cardHtml).join("") : collectionEmptyHtml();
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
    state.message = "";
    state.publicCollection = await api(`/api/users/${encodeURIComponent(username)}/collection`);
    render();
  } catch (e) {
    state.message = e.message;
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
    $("#resetCollection").addEventListener("click", resetCollection);
    $("#regenerateKey").addEventListener("click", regenerateConnectionKey);
    $("#logout").addEventListener("click", () => {
      localStorage.removeItem("gachaUser");
      state.user       = null;
      state.collection = [];
      state.leaderboard = [];
      state.publicCollection = null;
      state.view = "login";
      render();
    });
  } else {
    bindLogin();
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
      state.message = "";
      await refresh({ shouldRender: false });
      state.view = "gacha";
      render();
    } catch (e) {
      state.message = e.message;
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
      state.message = e.message;
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
    state.message = "";
    render();
  } catch (e) {
    state.message = e.message;
    renderLogin();
  }
}

async function resetCollection() {
  if (!confirm("Reset toute ta collection, tes cartes vues et tes échanges ?")) return;
  try {
    await api("/api/collection/reset", { method: "POST", body: "{}" });
    state.collection  = [];
    state.trades      = [];
    state.result      = null;
    state.pendingRoll = null;
    state.message = "Collection reset.";
    await refresh();
    state.view = "login";
    render();
  } catch (e) {
    state.message = e.message;
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
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    state.message = `Carte vendue +${sold.earned}¥.`;
    await refresh({ shouldRender: false });
    render();
  } catch (e) {
    state.message = e.message;
    render();
  }
}

async function sendCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const itemId = form.dataset.sendForm;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api("/api/trades", { method: "POST", body: JSON.stringify({ offerItemId: itemId, toUsername: data.toUsername }) });
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    state.message = "Carte envoyee.";
    await refresh({ shouldRender: false });
    render();
  } catch (e) {
    state.message = e.message;
    render();
  }
}

async function toggleSeen(event) {
  const button = event.currentTarget;
  const currentView = state.view;
  const nextSeen = button.dataset.seenNext === "1";
  try {
    await api("/api/collection/seen", {
      method: "POST",
      body: JSON.stringify({ itemId: button.dataset.seenId, seen: nextSeen }),
    });
    const item = state.collection.find((entry) => entry.id === button.dataset.seenId);
    if (item) item.seen = nextSeen;
    if (state.result?.item?.id === button.dataset.seenId) state.result.item.seen = nextSeen;
    state.view = currentView;
    await refresh({ shouldRender: false });
    state.view = currentView;
    updateSeenButton(button, nextSeen);
  } catch (e) {
    state.message = e.message;
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
    const item = state.collection.find((entry) => entry.id === itemId);
    if (item) { item.favorite = updated.favorite; item.watchlist = updated.watchlist; }
    if (state.result?.item?.id === itemId) {
      state.result.item.favorite  = updated.favorite;
      state.result.item.watchlist = updated.watchlist;
    }
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    render();
  } catch (e) {
    state.message = e.message;
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
    const item = state.collection.find((entry) => entry.id === itemId);
    if (item) { item.favorite = updated.favorite; item.watchlist = updated.watchlist; }
    if (state.result?.item?.id === itemId) {
      state.result.item.favorite  = updated.favorite;
      state.result.item.watchlist = updated.watchlist;
    }
    state.activeCardMenu = null;
    state.cardMenuMode = null;
    render();
  } catch (e) {
    state.message = e.message;
    render();
  }
}

async function createTrade(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/trades", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    state.message = "Carte envoyee.";
    await refresh();
  } catch (e) {
    state.message = e.message;
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
      ${!dupes.length ? `<div class="message">Il faut au moins un doublon pour envoyer une carte.</div>` : ""}
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
    });
  });
}

function setPosterMenu(itemId, open, showSend = false) {
  document.querySelectorAll("[data-card-menu]").forEach((menu) => {
    const isTarget = menu.dataset.cardMenu === itemId;
    menu.classList.toggle("is-open", Boolean(open && isTarget));
  });
  document.querySelectorAll("[data-send-form]").forEach((form) => {
    const isTarget = form.dataset.sendForm === itemId;
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
  document.querySelectorAll("[data-poster-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const itemId = button.dataset.posterMenu;
      const wasOpen = state.activeCardMenu === itemId;
      state.activeCardMenu = wasOpen ? null : itemId;
      state.cardMenuMode = null;
      setPosterMenu(itemId, !wasOpen);
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
      state.activeCardMenu = button.dataset.sendToggle;
      state.cardMenuMode = state.cardMenuMode === "send" ? null : "send";
      setPosterMenu(button.dataset.sendToggle, true, state.cardMenuMode === "send");
    });
  });
  document.querySelectorAll("[data-send-form]").forEach((form) => {
    form.addEventListener("submit", sendCard);
    form.addEventListener("click", (event) => event.stopPropagation());
  });
  bindCardTilt();
}

// ---------------------------------------------------------------------------
// Rendu principal
// ---------------------------------------------------------------------------

function render() {
  if      (state.view === "collection")  renderCollection();
  else if (state.view === "leaderboard") renderLeaderboard();
  else if (state.view === "login")       renderLogin();
  else                                   renderGacha();
  bindInteractiveCards();
}

document.addEventListener("click", (event) => {
  if (!state.activeCardMenu || event.target.closest(".card-action-area")) return;
  state.activeCardMenu = null;
  state.cardMenuMode = null;
  setPosterMenu("", false);
});

loadRelease().finally(() => refresh());
