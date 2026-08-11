import {
  state,
  DEFAULT_COLLECTION_SORT, RARITIES, RARITY_RANK, SELL_PRICES, SHOWCASE_LIMIT,
  creditTimerText, escapeHtml, formatCredits, statsHtml,
} from "./state.js?v=cinedex-mobile-6";

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

export function poster(item, menuKey = item.id) {
  if (!item.owned) return `<div class="placeholder">?</div>`;
  return `
    <button class="poster poster-button" type="button" data-poster-menu="${escapeHtml(menuKey)}" aria-label="Actions pour ${escapeHtml(item.name)}">
      <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async">
    </button>
  `;
}

export function readonlyPoster(item) {
  if (!item.owned) return `<div class="placeholder">?</div>`;
  return `
    <div class="poster">
      <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async">
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Barre de navigation & portefeuille
// ---------------------------------------------------------------------------

export function walletHtml() {
  return `
    <div class="wallet">
      <span>${formatCredits(state.user.credits)}</span>
      <small data-credit-timer>${escapeHtml(creditTimerText())}</small>
    </div>
  `;
}

export function nav() {
  const tabs = [
    ["gacha",        "Gachapon"],
    ["collection",   "Cinédex"],
    ["leaderboard",  "Classement"],
    ["achievements", "Succès"],
    ["notifications", "Notifications"],
    ["login",        state.user ? state.user.username : "Connexion"],
  ];
  return tabs
    .map(([id, label]) => {
      const unread = Number(state.unreadNotificationCount || 0);
      const disabled = !state.user && id !== "login";
      const badge = id === "notifications"
        ? `<span class="notification-badge ${unread ? "" : "is-empty"}" aria-hidden="true">${unread > 99 ? "99+" : unread}</span>`
        : "";
      const ariaLabel = id === "notifications" && unread
        ? ` aria-label="Notifications, ${unread} non lue${unread > 1 ? "s" : ""}"`
        : "";
      return `<button class="ghost ${state.view === id ? "active" : ""}" data-view="${id}"${ariaLabel}${disabled ? " disabled" : ""}><span>${escapeHtml(label)}</span>${badge}</button>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Machine à sous
// ---------------------------------------------------------------------------

export function dropRatesHtml() {
  const rates = state.dropRates || {};
  const labels = { C: "Commun", UC: "Peu commun", R: "Rare", UR: "Ultra rare", L: "Légendaire" };
  return ["C", "UC", "R", "UR", "L"]
    .map((rarity) => `<span>${labels[rarity]} · ${Number(rates[rarity] || 0)}%</span>`)
    .join("");
}

export function burstHtml() {
  return `
    <div class="burst" aria-hidden="true">
      ${Array.from({ length: 16 }, (_, i) => `<i style="--i:${i}"></i>`).join("")}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Modale clé de connexion
// ---------------------------------------------------------------------------

export function keyModalHtml() {
  if (!state.keyModal) return "";
  return `
    <div class="key-modal-backdrop" data-key-modal-close>
      <section class="key-modal" role="dialog" aria-modal="true" aria-labelledby="keyModalTitle">
        <h2 id="keyModalTitle">Clé de connexion</h2>
        <p>Note-la maintenant. Elle ne sera plus affichée après fermeture.</p>
        <input id="connectionKeyPopup" class="key-modal-input" value="${escapeHtml(state.keyModal.key)}" readonly autocomplete="off" spellcheck="false">
        <p class="key-modal-status">${state.keyModal.copied ? "Déjà copiée dans le presse-papier." : "Tu peux la sélectionner ou la copier ici."}</p>
        <div class="key-modal-actions">
          <button id="copyConnectionKey" class="blue" type="button">Copier</button>
          <button id="closeKeyModal" class="primary" type="button">OK</button>
        </div>
      </section>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Cartes
// ---------------------------------------------------------------------------

export function cardStatusMark(item) {
  const marks = [];
  if (item.favorite) marks.push(`<span class="favorite-mark" aria-label="Favori">★</span>`);
  if (item.watchlist) marks.push(`<span class="watchlist-mark" aria-label="Watchlist"></span>`);
  return marks.join("");
}

export function showcaseItems(items = state.collection) {
  return [...items]
    .filter((item) => item.owned && Number(item.showcaseSlot || 0) > 0)
    .sort((a, b) => Number(a.showcaseSlot) - Number(b.showcaseSlot));
}

export function firstEmptyShowcaseSlot(items = state.collection) {
  const used = new Set(showcaseItems(items).map((item) => Number(item.showcaseSlot)));
  for (let slot = 1; slot <= SHOWCASE_LIMIT; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

export function collectionCardHtml(item, featured, readonly = false, menuScope = "collection", precomputedSlot) {
  const title = item.owned && item.url
    ? `<a class="film-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a>`
    : escapeHtml(item.name);
  const hasDupe = Number(item.count || 0) >= 2;
  const menuKey = `${menuScope}:${item.id}`;
  const isMenuOpen = state.activeCardMenu === menuKey;
  const isSendMode = isMenuOpen && state.cardMenuMode === "send";
  const sellPrice = SELL_PRICES[item.rarity] || 0;
  const isShowcased = Number(item.showcaseSlot || 0) > 0;
  // Slot libre calcule une fois par grille (cf. collectionGridHtml) ; fallback pour les
  // rendus unitaires (resultHtml, vitrine) afin d'eviter un calcul O(N) par carte.
  const nextShowcaseSlot = precomputedSlot !== undefined ? precomputedSlot : firstEmptyShowcaseSlot();
  const canAddShowcase = isShowcased || nextShowcaseSlot !== null;
  return `
    <article class="card rarity-${item.rarity} ${featured ? "featured" : ""} ${item.favorite ? "favorite" : ""} ${item.watchlist ? "watchlist" : ""} ${item.owned ? "" : "locked"}" data-card-id="${item.id}">
      <header class="card-title">
        <h3>${cardStatusMark(item)}${title}</h3>
        <span class="rarity ${item.rarity}">${item.rarity}</span>
      </header>
      <div class="card-action-area">
        ${readonly ? readonlyPoster(item) : poster(item, menuKey)}
        ${item.owned && !readonly ? `
          <div class="poster-menu ${isMenuOpen ? "is-open" : ""}" data-card-menu="${escapeHtml(menuKey)}">
            <button type="button" class="favorite-action" data-favorite-id="${item.id}" data-favorite-next="${item.favorite ? "0" : "1"}">${item.favorite ? "Retirer favori" : "Favori"}</button>
            <button type="button" class="watchlist-action" data-watchlist-id="${item.id}" data-watchlist-next="${item.watchlist ? "0" : "1"}">${item.watchlist ? "Retirer watchlist" : "Watchlist"}</button>
            <button type="button" class="showcase-action" data-showcase-id="${item.id}" data-showcase-slot="${isShowcased ? "" : nextShowcaseSlot || ""}" ${canAddShowcase ? "" : "disabled"}>${isShowcased ? "Retirer vitrine" : "Ajouter vitrine"}</button>
            <button type="button" class="primary" data-sell-id="${item.id}" ${hasDupe ? "" : "disabled"}>Vendre (+${sellPrice}¥)</button>
            <button type="button" class="blue" data-send-toggle="${escapeHtml(menuKey)}" ${hasDupe ? "" : "disabled"}>Envoyer</button>
            <form class="send-card-form ${isSendMode ? "is-open" : ""}" data-send-form="${escapeHtml(menuKey)}" data-send-item-id="${item.id}">
              <div class="recipient-combobox">
                <input name="toUsername" placeholder="Pseudo" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" data-lpignore="true" data-recipient-input role="combobox" aria-autocomplete="list" aria-expanded="false" aria-label="Pseudo du destinataire">
                <div class="recipient-suggestions" data-recipient-list role="listbox" aria-label="Utilisateurs existants" hidden></div>
              </div>
              <button type="submit" class="primary" data-recipient-submit disabled>OK</button>
            </form>
            ${hasDupe ? "" : `<p class="menu-hint">Action disponible avec un doublon.</p>`}
          </div>
        ` : ""}
      </div>
      <section class="director-box">
        <span>Réalisateur</span>
        <strong>${item.owned ? escapeHtml(item.director || "Realisateur inconnu") : "A decouvrir"}</strong>
        ${item.owned && item.year ? `<small>${escapeHtml(item.year)}</small>` : ""}
      </section>
      ${item.owned && !readonly ? `<button class="seen-toggle ${item.seen ? "seen" : ""}" data-seen-id="${item.id}" data-seen-next="${item.seen ? "0" : "1"}">${item.seen ? "Vu" : "Pas vu"}</button>` : ""}
      ${item.owned && readonly ? `<div class="seen-toggle readonly ${item.seen ? "seen" : ""}">${item.seen ? "Vu" : "Pas vu"}</div>` : ""}
      <footer class="meta"><span>${escapeHtml(statsHtml(item))}</span><span>x${item.count || 0}</span></footer>
    </article>
  `;
}

// Rend une grille de cartes possedees en calculant le slot de vitrine libre UNE seule fois
// (au lieu d'un calcul O(N) par carte -> O(N^2) sur la collection).
export function collectionGridHtml(items) {
  const nextSlot = firstEmptyShowcaseSlot();
  return items
    .map((item) => mobileCardTileHtml(item, {
      source: "collection",
      cardHtml: collectionCardHtml(item, false, false, "collection", nextSlot),
    }))
    .join("");
}

function mobileCardTileHtml(item, { source, cardHtml }) {
  return `
    <div
      class="mobile-card-tile"
      data-mobile-card-id="${escapeHtml(item.id)}"
      data-mobile-card-source="${escapeHtml(source)}"
      data-mobile-card-label="Agrandir la carte ${escapeHtml(item.name)}"
    >
      <div class="mobile-card-scale">
        ${cardHtml}
      </div>
    </div>
  `;
}

export function cardViewerHtml(items, { readonly = false, navigationLabel = "Navigation entre les cartes" } = {}) {
  if (!state.cardViewer) return "";
  const index = items.findIndex((item) => String(item.id) === String(state.cardViewer.itemId));
  if (index < 0) return "";
  const item = items[index];
  const nextSlot = firstEmptyShowcaseSlot();
  return `
    <div class="collection-viewer-backdrop" data-collection-viewer-backdrop>
      <section
        class="collection-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collectionViewerTitle"
      >
        <h2 class="visually-hidden" id="collectionViewerTitle">${escapeHtml(item.name)}</h2>
        <button class="collection-viewer-close" type="button" data-collection-viewer-close aria-label="Fermer">×</button>
        <div class="collection-viewer-stage" data-collection-viewer-stage>
          <div class="collection-viewer-card-shell">
            <div class="mobile-card-scale">
              ${collectionCardHtml(item, false, readonly, "collection-viewer", nextSlot)}
            </div>
          </div>
        </div>
        <div class="collection-viewer-controls" aria-label="${escapeHtml(navigationLabel)}">
          <button type="button" class="ghost" data-collection-viewer-step="-1" ${index === 0 ? "disabled" : ""} aria-label="Carte précédente">←</button>
          <span aria-live="polite">${index + 1} / ${items.length}</span>
          <button type="button" class="ghost" data-collection-viewer-step="1" ${index === items.length - 1 ? "disabled" : ""} aria-label="Carte suivante">→</button>
        </div>
      </section>
    </div>
  `;
}

export function publicCardHtml(item) {
  return collectionCardHtml(item, false, true);
}

export function publicCollectionCardHtml(item) {
  return `
    <div class="public-card-tile">
      <div class="mobile-card-scale">
        ${publicCardHtml(item)}
      </div>
    </div>
  `;
}

function showcaseSlotHtml(slot, item) {
  if (!item) {
    return `
      <div class="showcase-slot is-empty">
        <div class="showcase-empty">Libre</div>
      </div>
    `;
  }
  return `
    <div class="showcase-slot is-filled">
      ${mobileCardTileHtml(item, {
        source: "showcase",
        cardHtml: collectionCardHtml(item, false, false, `showcase-${slot}`),
      })}
      <div class="showcase-controls">
        <button type="button" class="ghost" data-showcase-move="${item.id}" data-showcase-slot="${slot - 1}" ${slot === 1 ? "disabled" : ""} aria-label="Déplacer ${escapeHtml(item.name)} vers la gauche">←</button>
        <button type="button" class="ghost" data-showcase-move="${item.id}" data-showcase-slot="${slot + 1}" ${slot === SHOWCASE_LIMIT ? "disabled" : ""} aria-label="Déplacer ${escapeHtml(item.name)} vers la droite">→</button>
      </div>
    </div>
  `;
}

export function showcaseEditorHtml() {
  const showcased = new Map(showcaseItems().map((item) => [Number(item.showcaseSlot), item]));
  const count = showcased.size;
  return `
    <section class="showcase-editor" aria-label="Ma vitrine">
      <div class="showcase-heading">
        <div>
          <p class="eyebrow">Ma vitrine</p>
          <h2>${count}/${SHOWCASE_LIMIT} cartes</h2>
        </div>
        <span class="showcase-status">${count >= SHOWCASE_LIMIT ? "Pleine" : `${SHOWCASE_LIMIT - count} libre${SHOWCASE_LIMIT - count > 1 ? "s" : ""}`}</span>
      </div>
      <div class="showcase-slots">
        ${Array.from({ length: SHOWCASE_LIMIT }, (_, index) => showcaseSlotHtml(index + 1, showcased.get(index + 1))).join("")}
      </div>
    </section>
  `;
}

function publicShowcaseHtml(profile) {
  const items = showcaseItems(profile.items || []);
  if (!items.length) return "";
  return `
    <section class="public-showcase" aria-label="Vitrine de ${escapeHtml(profile.username)}">
      <div class="showcase-heading">
        <div>
          <p class="eyebrow">Vitrine</p>
          <h3>${items.length}/${SHOWCASE_LIMIT} cartes</h3>
        </div>
      </div>
      <div class="public-showcase-grid">
        ${items.map((item) => mobileCardTileHtml(item, {
          source: "public-showcase",
          cardHtml: publicCardHtml(item),
        })).join("")}
      </div>
    </section>
  `;
}

export function resultHtml(result) {
  const entries = Array.isArray(result?.items)
    ? result.items
    : result?.item
      ? [{ item: result.item, isDuplicate: result.isDuplicate }]
      : [];
  const index = Math.min(state.resultIndex || 0, Math.max(entries.length - 1, 0));
  const current = entries[index];
  if (!current) return "";
  const remaining = Math.max(0, entries.length - index - 1);
  const stackBacks = entries
    .slice(index + 1, index + 4)
    .map((entry, i) => {
      const offsets = [
        ["5px", "5px", "-.35deg", ".96"],
        ["9px", "9px", ".15deg", ".9"],
        ["13px", "13px", ".45deg", ".84"],
      ][i];
      return `
        <div class="result-stack-back rarity-${entry.item.rarity}" style="--stack-x:${offsets[0]};--stack-y:${offsets[1]};--stack-rotate:${offsets[2]};--stack-opacity:${offsets[3]}" aria-hidden="true"></div>
      `;
    })
    .join("");
  const duplicateText = current.isDuplicate
    ? "Doublon ajoute au classeur."
    : "Nouvelle entree dans le classeur.";
  return `
    <div class="result-card ${entries.length > 1 ? "is-stack" : ""}">
      <button class="close-result" id="closeResult" type="button" aria-label="${remaining ? "Carte suivante" : "Fermer la carte"}">×</button>
      <div class="result-stack-stage">
        ${stackBacks}
        <div class="grid result-grid">${collectionCardHtml({ ...current.item, owned: true, count: current.item.count || 1 }, false)}</div>
      </div>
      <p>${entries.length > 1 ? `<span class="result-progress">Carte ${index + 1}/${entries.length}</span>` : ""}${duplicateText}</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Stats de collection
// ---------------------------------------------------------------------------

export function collectionStats() {
  // Totaux servis par le backend (collection_summary). state.collection ne contient
  // que les cartes possedees, donc les totaux ne peuvent plus etre recalcules ici.
  const summary = state.collectionSummary;
  return {
    total:     summary?.total     || 0,
    owned:     summary?.owned     || 0,
    seen:      summary?.seen      || 0,
    favorites: summary?.favorites || 0,
    watchlist: summary?.watchlist || 0,
    byRarity: Object.fromEntries(RARITIES.map((r) => [r, {
      total: summary?.byRarity?.[r]?.total || 0,
      owned: summary?.byRarity?.[r]?.owned || 0,
    }])),
  };
}

export function collectionStatsHtml() {
  const stats = collectionStats();
  const globalPercent = stats.total ? Math.round((stats.owned / stats.total) * 100) : 0;
  return `
    <section class="collection-stats" aria-label="Progression de la collection">
      <div class="stats-summary">
        <div><span>Collection</span><strong>${stats.owned} / ${stats.total}</strong></div>
        <div><span>Vus</span><strong>${stats.seen}</strong></div>
        <div><span>Favoris</span><strong>${stats.favorites}</strong></div>
        <div><span>Watchlist</span><strong>${stats.watchlist}</strong></div>
      </div>
      <div class="progress-line">
        <span style="--progress:${globalPercent}%"></span>
      </div>
      <div class="rarity-stats">
        ${RARITIES.map((rarity) => {
          const entry = stats.byRarity[rarity];
          const percent = entry.total ? Math.round((entry.owned / entry.total) * 100) : 0;
          return `
            <div class="rarity-stat">
              <div><span class="rarity ${rarity}">${rarity}</span><strong>${entry.owned}/${entry.total}</strong></div>
              <div class="mini-progress"><span style="--progress:${percent}%"></span></div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Filtres de collection
// ---------------------------------------------------------------------------

function standardCollectionSort(a, b) {
  const rd = (RARITY_RANK[a.rarity] ?? 99) - (RARITY_RANK[b.rarity] ?? 99);
  if (rd) return rd;
  const rd2 = Number(b.rating || 0) - Number(a.rating || 0);
  if (rd2) return rd2;
  const rd3 = Number(b.reviewCount || 0) - Number(a.reviewCount || 0);
  if (rd3) return rd3;
  return a.name.localeCompare(b.name);
}

function collectionSort(a, b, sort) {
  if (sort === "obtained-desc" || sort === "obtained-asc") {
    const aDate = Number(a.obtainedAt);
    const bDate = Number(b.obtainedAt);
    const aHasDate = Number.isFinite(aDate) && aDate > 0;
    const bHasDate = Number.isFinite(bDate) && bDate > 0;
    if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;
    if (aHasDate && bHasDate && aDate !== bDate) {
      return sort === "obtained-desc" ? bDate - aDate : aDate - bDate;
    }
  }
  return standardCollectionSort(a, b);
}

export function applyCollectionFilters(items, filters) {
  return items
    .filter((item) => {
      if (!item.owned) return false;
      const q = filters.q.trim().toLowerCase();
      if (q && !item.name.toLowerCase().includes(q)) return false;
      if (filters.rarity !== "all" && item.rarity !== filters.rarity) return false;
      if (filters.owned === "favorites" && !item.favorite) return false;
      if (filters.owned === "watchlist" && !item.watchlist) return false;
      if (filters.owned === "dupes"     && item.count < 2) return false;
      if (filters.owned === "seen"      && !item.seen)     return false;
      if (filters.owned === "unseen"    && item.seen)      return false;
      return true;
    })
    .sort((a, b) => collectionSort(a, b, filters.sort || "standard"));
}

export function filteredCollection() {
  return applyCollectionFilters(state.collection, state.filters);
}

export function filteredPublicCollection() {
  if (!state.publicCollection) return [];
  return applyCollectionFilters(state.publicCollection.items, state.publicFilters);
}

export function hasActiveFilters() {
  return state.filters.q !== ""
    || state.filters.rarity !== "all"
    || state.filters.owned !== "all"
    || state.filters.sort !== DEFAULT_COLLECTION_SORT;
}

export function filterCountText(count) {
  if (count === 0) return "Aucun film";
  return `${count} film${count !== 1 ? "s" : ""}`;
}

export function collectionEmptyHtml() {
  if (!state.collection.length) {
    return `<p class="empty-state"><strong>Ta collection est vide.</strong><br>Tourne la manette pour obtenir ta première carte&nbsp;!</p>`;
  }
  return `<p class="empty-state">Aucun film ne correspond à ces filtres.</p>`;
}

// ---------------------------------------------------------------------------
// Classement
// ---------------------------------------------------------------------------

export function leaderboardRowHtml(entry) {
  const percent = Number(entry.percent || 0);
  const isSelected = state.publicCollection?.username === entry.username;
  return `
    <button class="leaderboard-row ${isSelected ? "is-selected" : ""}" type="button" data-public-user="${escapeHtml(entry.username)}">
      <span class="rank">${entry.rank || 1}</span>
      <span class="leader-name">${escapeHtml(entry.username)}</span>
      <span class="leader-score">${entry.owned}/${entry.total}</span>
      <span class="leader-percent">${percent.toFixed(1)}%</span>
      <span class="leader-progress"><i style="--progress:${percent}%"></i></span>
    </button>
  `;
}

export function publicCollectionHtml(profile) {
  const ownedItems = filteredPublicCollection();
  const summary = profile.summary || {
    owned: ownedItems.length,
    total: state.dataset?.count || 0,
    percent: 0, seen: 0, favorites: 0, watchlist: 0,
  };
  const letterboxdUrl = profile.letterboxdUsername
    ? `https://letterboxd.com/${encodeURIComponent(profile.letterboxdUsername)}/`
    : null;
  return `
    <div class="public-heading">
      <div>
        <p class="eyebrow">Collection de</p>
        <div class="public-profile-line">
          <h2>${escapeHtml(profile.username)}</h2>
          ${letterboxdUrl ? `
            <a class="credits-stamp letterboxd-link" href="${escapeHtml(letterboxdUrl)}" target="_blank" rel="noopener noreferrer">
              Letterboxd
            </a>
          ` : ""}
        </div>
      </div>
      <span class="credits-stamp">${Number(summary.percent || 0).toFixed(1)}%</span>
    </div>
    <div class="stats-summary public-summary">
      <div><span>Collection</span><strong>${summary.owned} / ${summary.total}</strong></div>
      <div><span>Vus</span><strong>${summary.seen}</strong></div>
      <div><span>Favoris</span><strong>${summary.favorites}</strong></div>
      <div><span>Watchlist</span><strong>${summary.watchlist}</strong></div>
    </div>
    <div class="progress-line">
      <span style="--progress:${Number(summary.percent || 0)}%"></span>
    </div>
    ${publicShowcaseHtml(profile)}
    <div class="filters public-filters">
      <input id="publicQ" placeholder="Rechercher un film" value="${escapeHtml(state.publicFilters.q)}">
      <select id="publicRarity">
        ${["all", ...RARITIES].map((r) =>
          `<option value="${r}" ${state.publicFilters.rarity === r ? "selected" : ""}>${r === "all" ? "Toutes raretes" : r}</option>`
        ).join("")}
      </select>
      <select id="publicOwned">
        <option value="all"       ${state.publicFilters.owned === "all"       ? "selected" : ""}>Tous</option>
        <option value="favorites" ${state.publicFilters.owned === "favorites" ? "selected" : ""}>Favoris</option>
        <option value="watchlist" ${state.publicFilters.owned === "watchlist" ? "selected" : ""}>Watchlist</option>
        <option value="dupes"     ${state.publicFilters.owned === "dupes"     ? "selected" : ""}>Doublons</option>
        <option value="seen"      ${state.publicFilters.owned === "seen"      ? "selected" : ""}>Vus</option>
        <option value="unseen"    ${state.publicFilters.owned === "unseen"    ? "selected" : ""}>Non vus</option>
      </select>
    </div>
    <div class="grid public-grid">${ownedItems.map(publicCollectionCardHtml).join("") || `<p>Aucune carte obtenue.</p>`}</div>
  `;
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

function achievementRowHtml(ach) {
  const current = Number(ach.current || 0);
  const target = Number(ach.target || 1);
  const progress = Math.max(0, Math.min(100, Number(ach.progress || 0)));
  return `
    <div class="achievement-row ${ach.unlocked ? "is-unlocked" : "is-locked"}">
      <div class="achievement-icon"></div>
      <div class="achievement-info">
        <strong>${escapeHtml(ach.name)}</strong>
        <span>${escapeHtml(ach.description)}</span>
        <div class="achievement-progress" aria-hidden="true"><span style="--progress:${progress}%"></span></div>
      </div>
      <div class="achievement-meta">
        <span>${current}/${target}</span>
        <strong>${ach.unlocked ? "" : "+"}${ach.reward}¥</strong>
      </div>
    </div>
  `;
}

function visibleAchievementsForCategory(category, achievements) {
  if (category.toLowerCase() === "divers") return achievements;
  const nextLocked = achievements.find((ach) => !ach.unlocked);
  return achievements.filter((ach) => ach.unlocked || ach === nextLocked);
}

export function achievementsViewHtml() {
  const achs = state.achievements;
  const total = achs.length;
  const unlocked = achs.filter((a) => a.unlocked).length;
  const percent = total ? Math.round((unlocked / total) * 100) : 0;

  const seenCats = new Set();
  const categories = [];
  for (const a of achs) {
    if (!seenCats.has(a.category)) { seenCats.add(a.category); categories.push(a.category); }
  }

  const categoriesHtml = categories.map((cat) => {
    const items = visibleAchievementsForCategory(cat, achs.filter((a) => a.category === cat));
    return `
      <div class="achievement-category">
        <h3 class="achievement-category-title">${escapeHtml(cat)}</h3>
        <div class="achievement-list">${items.map(achievementRowHtml).join("")}</div>
      </div>
    `;
  }).join("");

  return `
    <section class="panel stack">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Progression</p>
          <h1>Succès</h1>
        </div>
        <span class="credits-stamp">${unlocked}/${total}</span>
      </div>
      <div class="progress-line"><span style="--progress:${percent}%"></span></div>
      ${total ? `<div class="achievements-grid">${categoriesHtml}</div>` : `<p class="muted-copy">Chargement…</p>`}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notificationDate(timestamp) {
  const date = new Date(Number(timestamp || 0) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function notificationRowHtml(notification) {
  const highlighted = !notification.read || state.notificationHighlightIds.includes(notification.id);
  const formattedDate = notificationDate(notification.createdAt);
  if (notification.type === "card_received") {
    const item = notification.data?.item || {};
    const sender = notification.actorUsername || "Un utilisateur";
    return `
      <article class="notification-row ${highlighted ? "is-unread" : ""}">
        <div class="notification-icon notification-icon-card" aria-hidden="true"></div>
        <div class="notification-content">
          <span class="notification-kind">Carte reçue</span>
          <strong>${escapeHtml(sender)} t’a envoyé ${escapeHtml(item.name || "une carte")}</strong>
          ${item.rarity ? `<span>Rareté <span class="rarity ${escapeHtml(item.rarity)}">${escapeHtml(item.rarity)}</span></span>` : ""}
        </div>
        <time datetime="${new Date(Number(notification.createdAt || 0) * 1000).toISOString()}">${escapeHtml(formattedDate)}</time>
      </article>
    `;
  }
  if (notification.type === "achievement_unlocked") {
    const achievement = notification.data?.achievement || {};
    return `
      <article class="notification-row ${highlighted ? "is-unread" : ""}">
        <div class="notification-icon notification-icon-achievement" aria-hidden="true"></div>
        <div class="notification-content">
          <span class="notification-kind">Succès débloqué</span>
          <strong>${escapeHtml(achievement.name || "Nouveau succès")}</strong>
          <span>${escapeHtml(achievement.description || "")}${achievement.reward !== undefined ? ` · +${Number(achievement.reward || 0)}¥` : ""}</span>
        </div>
        <time datetime="${new Date(Number(notification.createdAt || 0) * 1000).toISOString()}">${escapeHtml(formattedDate)}</time>
      </article>
    `;
  }
  return "";
}

export function notificationsViewHtml() {
  let content = `<p class="muted-copy">Chargement…</p>`;
  if (state.notificationsLoaded) {
    const rows = state.notifications.map(notificationRowHtml).filter(Boolean).join("");
    content = rows || `<p class="empty-state"><strong>Aucune notification.</strong><br>Les cartes reçues et les succès débloqués apparaîtront ici.</p>`;
  }
  return `
    <section class="panel stack notifications-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Activité</p>
          <h1>Notifications</h1>
        </div>
        ${state.notificationsLoaded && state.notifications.length
          ? `<button class="ghost notification-clear" id="clearNotifications" type="button">Vider les notifications</button>`
          : ""}
      </div>
      <div class="notification-list" aria-live="polite">${content}</div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Écran connexion / compte
// ---------------------------------------------------------------------------

export function loginForms() {
  return `
    <div class="login-stack">
      <div class="layout">
        <form class="panel stack" id="createUser">
          <h2>Créer un compte</h2>
          <input name="username" placeholder="Nom d'utilisateur" autocomplete="username">
          <button class="primary">Generer ma cle</button>
        </form>
        <form class="panel stack" id="loginUser">
          <h2>Connexion</h2>
          <input name="username" placeholder="Nom d'utilisateur" autocomplete="username">
          <input name="connectionKey" placeholder="Cle de connexion" autocomplete="current-password">
          <button class="blue">Entrer</button>
        </form>
      </div>
      ${creditsPanelHtml()}
    </div>
  `;
}

export function accountPanelHtml() {
  const letterboxdUsername = state.user.letterboxdUsername || "";
  return `
    <div class="account-grid">
      <section class="panel stack account-panel">
        <div>
          <p class="eyebrow">Joueur</p>
          <h1>${escapeHtml(state.user.username)}</h1>
          <p class="muted-copy">Ta session est stockée dans ce navigateur.</p>
        </div>
        <form id="letterboxdProfile" class="letterboxd-form stack" autocomplete="off">
          <label for="letterboxdUsername">Pseudo Letterboxd</label>
          <p class="muted-copy">Ajoute ton profil pour le partager avec les joueurs qui consultent ta collection.</p>
          <div class="letterboxd-field">
            <span aria-hidden="true">letterboxd.com/</span>
            <input id="letterboxdUsername" name="letterboxdUsername" value="${escapeHtml(letterboxdUsername)}" placeholder="ton-pseudo" maxlength="64" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
          </div>
          <div class="letterboxd-actions">
            <button class="blue" type="submit">Enregistrer</button>
            ${letterboxdUsername ? `<button id="unlinkLetterboxd" class="ghost" type="button">Supprimer le lien</button>` : ""}
          </div>
        </form>
        <div class="account-actions">
          <button id="regenerateKey" class="blue">Regénérer la clé</button>
          <button id="resetCollection" class="primary">Réinitialiser la collection</button>
          <button id="logout" class="ghost">Déconnexion</button>
        </div>
      </section>
      ${creditsPanelHtml()}
    </div>
  `;
}

export function creditsPanelHtml() {
  const changelog = state.release.changelog || [];
  const changelogHtml = changelog.map((entry) => {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    return `
      <div class="changelog-entry">
        <strong>v${escapeHtml(entry.version || "")}</strong>
        <ul>
          ${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}
        </ul>
      </div>
    `;
  }).join("");
  return `
    <section class="panel credits-panel" aria-labelledby="creditsTitle">
      <div class="credits-header">
        <div>
          <p class="eyebrow">À propos</p>
          <h2 id="creditsTitle">Crédits & mentions</h2>
        </div>
        <span class="credits-stamp">CinéGacha</span>
      </div>
      <div class="credit-list">
        <div class="credit-row">
          <span>Version</span>
          <details class="changelog">
            <summary>${escapeHtml(state.release.version || "dev")}</summary>
            <div class="changelog-body">
              ${changelogHtml || `<div class="changelog-entry"><strong>Aucune note</strong></div>`}
            </div>
          </details>
        </div>
        <div class="credit-row"><span>Développement</span><strong>Benjamin Corbelet-Riou</strong></div>
        <div class="credit-row">
          <span>Code source</span>
          <strong><a href="https://github.com/BenCorb/cinegacha" target="_blank" rel="noreferrer">GitHub</a></strong>
        </div>
        <div class="credit-row">
          <span>Licence</span>
          <strong><a href="https://github.com/BenCorb/cinegacha/blob/main/LICENSE" target="_blank" rel="noreferrer">GNU GPL v3+</a></strong>
        </div>
        <div class="credit-row">
          <span>Posters</span>
          <strong><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">TMDB</a>, cache local</strong>
        </div>
        <div class="credit-row">
          <span>Notes, reviews et liens films</span>
          <strong><a href="https://letterboxd.com" target="_blank" rel="noreferrer">Letterboxd</a>, snapshot local</strong>
        </div>
      </div>
      <div class="legal-notes">
        <p>This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.</p>
        <p>CinéGacha est un projet personnel non commercial, non affilié à Letterboxd, TMDB, ni aux ayants droit des films. Les titres, images, marques, notes, liens, métadonnées et données liées aux films appartiennent à leurs propriétaires respectifs.</p>
      </div>
      <div class="privacy-notice">
        <h3>Confidentialité</h3>
        <p>CinéGacha enregistre uniquement les données nécessaires au jeu : pseudo, pseudo Letterboxd facultatif, clé de connexion hashée, collection, crédits, échanges, notifications, succès, favoris, watchlist et films vus.</p>
        <p>Ces données sont stockées dans la base SQLite du serveur. Elles servent à retrouver ton compte, afficher ta progression, gérer les échanges et notifications, et maintenir le classement.</p>
        <p>Pour toute question, demande d'accès ou suppression de compte, contacte <a href="mailto:cinegacha.app@pm.me">cinegacha.app@pm.me</a>.</p>
      </div>
    </section>
  `;
}
