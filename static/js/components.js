import {
  state,
  RARITIES, RARITY_RANK, SELL_PRICES,
  creditTimerText, escapeHtml, formatCredits, statsHtml,
} from "./state.js";

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

export function poster(item) {
  if (!item.owned) return `<div class="placeholder">?</div>`;
  return `
    <button class="poster poster-button" type="button" data-poster-menu="${item.id}" aria-label="Actions pour ${escapeHtml(item.name)}">
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
    ["gacha",      "Gachapon"],
    ["collection", "Collection"],
    ["leaderboard","Classement"],
    ["login",      state.user ? state.user.username : "Connexion"],
  ];
  return tabs
    .map(([id, label]) =>
      `<button class="ghost ${state.view === id ? "active" : ""}" data-view="${id}">${label}</button>`
    )
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
  if (item.favorite) return `<span class="favorite-mark" aria-label="Favori">★</span>`;
  if (item.watchlist) return `<span class="watchlist-mark" aria-label="Watchlist"></span>`;
  return "";
}

export function collectionCardHtml(item, featured, readonly = false) {
  const title = item.owned && item.url
    ? `<a class="film-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a>`
    : escapeHtml(item.name);
  const hasDupe = Number(item.count || 0) >= 2;
  const isMenuOpen = state.activeCardMenu === item.id;
  const isSendMode = isMenuOpen && state.cardMenuMode === "send";
  const sellPrice = SELL_PRICES[item.rarity] || 0;
  return `
    <article class="card rarity-${item.rarity} ${featured ? "featured" : ""} ${item.favorite ? "favorite" : ""} ${item.watchlist ? "watchlist" : ""} ${item.owned ? "" : "locked"}" data-card-id="${item.id}">
      <header class="card-title">
        <h3>${cardStatusMark(item)}${title}</h3>
        <span class="rarity ${item.rarity}">${item.rarity}</span>
      </header>
      <div class="card-action-area">
        ${readonly ? readonlyPoster(item) : poster(item)}
        ${item.owned && !readonly ? `
          <div class="poster-menu ${isMenuOpen ? "is-open" : ""}" data-card-menu="${item.id}">
            <button type="button" class="favorite-action" data-favorite-id="${item.id}" data-favorite-next="${item.favorite ? "0" : "1"}">${item.favorite ? "Retirer favori" : "Favori"}</button>
            <button type="button" class="watchlist-action" data-watchlist-id="${item.id}" data-watchlist-next="${item.watchlist ? "0" : "1"}">${item.watchlist ? "Retirer watchlist" : "Watchlist"}</button>
            <button type="button" class="primary" data-sell-id="${item.id}" ${hasDupe ? "" : "disabled"}>Vendre (+${sellPrice}¥)</button>
            <button type="button" class="blue" data-send-toggle="${item.id}" ${hasDupe ? "" : "disabled"}>Envoyer</button>
            <form class="send-card-form ${isSendMode ? "is-open" : ""}" data-send-form="${item.id}">
              <input name="toUsername" placeholder="Pseudo" list="users-datalist" autocorrect="off" autocapitalize="none" spellcheck="false" data-lpignore="true">
              <button type="submit" class="primary">OK</button>
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

export function cardHtml(item) {
  return collectionCardHtml(item, false);
}

export function publicCardHtml(item) {
  return collectionCardHtml(item, false, true);
}

export function resultHtml(result) {
  return `
    <div class="result-card">
      <button class="close-result" id="closeResult" type="button" aria-label="Fermer la carte">×</button>
      <div class="grid result-grid">${collectionCardHtml({ ...result.item, owned: true, count: result.item.count || 1 }, false)}</div>
      <p>${result.isDuplicate ? "Doublon ajoute au classeur." : "Nouvelle entree dans le classeur."}</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Stats de collection
// ---------------------------------------------------------------------------

export function collectionStats() {
  const stats = {
    total:    state.collection.length,
    owned:    0,
    seen:     0,
    favorites:0,
    watchlist:0,
    byRarity: Object.fromEntries(RARITIES.map((r) => [r, { total: 0, owned: 0 }])),
  };
  state.collection.forEach((item) => {
    const entry = stats.byRarity[item.rarity] || { total: 0, owned: 0 };
    entry.total += 1;
    if (item.owned) {
      stats.owned += 1;
      entry.owned += 1;
      if (item.seen)      stats.seen      += 1;
      if (item.favorite)  stats.favorites += 1;
      if (item.watchlist) stats.watchlist += 1;
    }
    stats.byRarity[item.rarity] = entry;
  });
  return stats;
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
    .sort((a, b) => {
      const rd = (RARITY_RANK[a.rarity] ?? 99) - (RARITY_RANK[b.rarity] ?? 99);
      if (rd) return rd;
      const rd2 = Number(b.rating || 0) - Number(a.rating || 0);
      if (rd2) return rd2;
      const rd3 = Number(b.reviewCount || 0) - Number(a.reviewCount || 0);
      if (rd3) return rd3;
      return a.name.localeCompare(b.name);
    });
}

export function filteredCollection() {
  return applyCollectionFilters(state.collection, state.filters);
}

export function filteredPublicCollection() {
  if (!state.publicCollection) return [];
  return applyCollectionFilters(state.publicCollection.items, state.publicFilters);
}

export function hasActiveFilters() {
  return state.filters.q !== "" || state.filters.rarity !== "all" || state.filters.owned !== "all";
}

export function filterCountText(count) {
  if (count === 0) return "Aucun film";
  return `${count} film${count !== 1 ? "s" : ""}`;
}

export function collectionEmptyHtml() {
  if (!state.collection.some((i) => i.owned)) {
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
  return `
    <div class="public-heading">
      <div>
        <p class="eyebrow">Collection de</p>
        <h2>${escapeHtml(profile.username)}</h2>
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
    <div class="grid public-grid">${ownedItems.map(publicCardHtml).join("") || `<p>Aucune carte obtenue.</p>`}</div>
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
  return `
    <div class="account-grid">
      <section class="panel stack account-panel">
        <div>
          <p class="eyebrow">Joueur</p>
          <h1>${escapeHtml(state.user.username)}</h1>
          <p class="muted-copy">Ta session est stockée dans ce navigateur.</p>
        </div>
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
          <span>Posters</span>
          <strong><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">TMDB</a>, cache local</strong>
        </div>
        <div class="credit-row">
          <span>Notes, reviews et liens films</span>
          <strong><a href="https://letterboxd.com" target="_blank" rel="noreferrer">Letterboxd</a>, snapshot local</strong>
        </div>
      </div>
      <div class="legal-notes">
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p>CinéGacha est un projet personnel non commercial, non affilié à Letterboxd, TMDB, ni aux ayants droit des films. Les titres, images, marques et données liées aux films appartiennent à leurs propriétaires respectifs.</p>
        <p>Les données de jeu de cette instance sont stockées localement dans la base SQLite du serveur : pseudo, clé hashée, collection, crédits, favoris, watchlist et films vus.</p>
      </div>
    </section>
  `;
}
