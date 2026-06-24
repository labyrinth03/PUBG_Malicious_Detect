const form = document.querySelector("#searchForm");
const input = document.querySelector("#playerName");
const statusBox = document.querySelector("#status");
const introBox = document.querySelector("#intro");
const resultsView = document.querySelector("#resultsView");
const summaryBox = document.querySelector("#summary");
const resultsBox = document.querySelector("#results");
const paginationBox = document.querySelector("#pagination");
const submitButton = form.querySelector("button");
const pageSize = 10;
let currentMatches = [];
let currentPage = 1;
const expandedMatchIds = new Set();

function setStatus(message, type = "info") {
  statusBox.hidden = false;
  statusBox.className = `status ${type === "error" ? "error" : ""}`;
  statusBox.textContent = message;
}

function clearStatus() {
  statusBox.hidden = true;
  statusBox.textContent = "";
  statusBox.className = "status";
}

function formatSurvival(seconds) {
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${minutes}분 ${restSeconds}초`;
}

function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${minutes}분 ${restSeconds}초`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderSummary(data) {
  summaryBox.innerHTML = `
    <div>
      <strong>${data.scannedMatches}</strong>
      <span>조회 가능한 최근 매치</span>
    </div>
    <div>
      <strong>${data.teamKillMatches}</strong>
      <span>아군에게 입힌 데미지 감지 매치</span>
    </div>
    <div>
      <strong>${escapeHtml(data.playerName)}</strong>
      <span>검색 플레이어</span>
    </div>
  `;
}

function renderPagination(totalPages) {
  if (totalPages <= 1) {
    paginationBox.innerHTML = "";
    return;
  }

  const buttons = [];
  const pageWindow = 5;
  const windowStart = Math.floor((currentPage - 1) / pageWindow) * pageWindow + 1;
  const windowEnd = Math.min(windowStart + pageWindow - 1, totalPages);

  for (let page = windowStart; page <= windowEnd; page += 1) {
    buttons.push(`
      <button class="page-button ${page === currentPage ? "active" : ""}" type="button" data-page="${page}">
        ${page}
      </button>
    `);
  }

  buttons.push(`
    <button class="page-button" type="button" data-page="${Math.min(currentPage + 1, totalPages)}" ${currentPage === totalPages ? "disabled" : ""}>
      &gt;
    </button>
  `);

  paginationBox.innerHTML = buttons.join("");
}

function renderCurrentPage() {
  const totalPages = Math.max(1, Math.ceil(currentMatches.length / pageSize));
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageMatches = currentMatches.slice(start, start + pageSize);

  renderMatches(pageMatches);
  renderPagination(currentMatches.length === 0 ? 0 : totalPages);
}

function renderMatches(matches) {
  if (matches.length === 0) {
    resultsBox.innerHTML = `<div class="empty">아군 공격 데미지가 감지된 매치가 없습니다.</div>`;
    return;
  }

  resultsBox.innerHTML = matches
    .map((match) => {
      const teamMembers = match.teamMembers.length > 0 ? match.teamMembers.map(escapeHtml).join(", ") : "없음";
      const teamWeapons = match.teamDamageByWeapon
        .map((item) => `
          <li>
            <span>${escapeHtml(item.weapon)}</span>
            <span>${item.damage.toFixed(1)}</span>
          </li>
        `)
        .join("");
      const teamDamageDetails = match.teamDamageDetails
        .map((item) => `
          <div class="team-damage-row">
            <span>${formatElapsed(item.elapsedSeconds)}</span>
            <span>${escapeHtml(item.weapon)}</span>
            <span>${escapeHtml(item.victimName)}</span>
            <strong>${item.damage.toFixed(1)}</strong>
          </div>
        `)
        .join("");
      const teammateReturnDamageDetails = match.teammateReturnDamageDetails.length > 0
        ? match.teammateReturnDamageDetails
            .map((item) => `
              <div class="team-damage-row">
                <span>${formatElapsed(item.elapsedSeconds)}</span>
                <span>${escapeHtml(item.weapon)}</span>
                <span>${escapeHtml(item.attackerName)}</span>
                <strong>${item.damage.toFixed(1)}</strong>
              </div>
            `)
            .join("")
        : `<div class="team-damage-row"><span>-</span><span>기록 없음</span><span>-</span><strong>0.0</strong></div>`;
      const selfWeapons = match.selfDamageByWeapon
        .map((item) => `
          <li>
            <span>${escapeHtml(item.weapon)}</span>
            <span>${item.damage.toFixed(1)}</span>
          </li>
        `)
        .join("");
      const allWeapons = match.damageByWeapon
        .map((item) => `
          <li>
            <span>${escapeHtml(item.weapon)}</span>
            <span>${item.damage.toFixed(1)}</span>
          </li>
        `)
        .join("");
      const damageFormula = `${match.officialDamage.toFixed(1)} + ${match.selfDamage.toFixed(1)} + <span class="danger-value">${match.teamKillDamage.toFixed(1)}</span> = ${match.totalWeaponDamage.toFixed(1)}`;
      const isExpanded = expandedMatchIds.has(match.matchId);
      const damagedTeammates = [...new Set(match.teamDamageDetails.map((item) => item.victimName))].map(escapeHtml).join(", ");

      return `
        <article class="match-card ${isExpanded ? "expanded" : ""}">
          <header class="match-head match-toggle" data-match-id="${escapeHtml(match.matchId)}" role="button" tabindex="0" aria-expanded="${isExpanded}">
            <div>
              <h2 class="match-title">${escapeHtml(match.playedAt)} · ${escapeHtml(match.mapName)}</h2>
              <div class="match-meta">
                ${escapeHtml(match.matchType)} · ${escapeHtml(match.teamType)} · 매치 ID ${escapeHtml(match.matchId)}
              </div>
            </div>
            <div class="match-preview-stats">
              <div class="damaged-teammates"><strong>피해입은 아군 :</strong> ${damagedTeammates}</div>
              <div class="damage-badge">아군에게 입힌 데미지 ${match.teamKillDamage.toFixed(1)}</div>
            </div>
          </header>
          <div class="match-detail" ${isExpanded ? "" : "hidden"}>
            <div class="match-body">
              <dl class="detail-list">
                <div><dt>순위</dt><dd>${match.rank}</dd></div>
                <div><dt>팀 생존시간</dt><dd>${formatSurvival(match.teamSurvivalSeconds)}</dd></div>
                <div><dt>팀원</dt><dd>${teamMembers}</dd></div>
                <div><dt>킬 / 어시 / 기절</dt><dd>${match.kills} / ${match.assists} / ${match.dbnos}</dd></div>
                <div><dt>적에게 입힌 데미지</dt><dd>${match.officialDamage.toFixed(1)}</dd></div>
                <div><dt>본인에게 입힌 데미지</dt><dd>${match.selfDamage.toFixed(1)}</dd></div>
                <div><dt>아군에게 입힌 데미지</dt><dd><span class="danger-value">${match.teamKillDamage.toFixed(1)}</span></dd></div>
                <div><dt>전체 공격수단 합계</dt><dd>${damageFormula}</dd></div>
              </dl>
              <div class="weapon-columns">
                <div>
                  <h3 class="match-title">아군 피해 공격수단</h3>
                  <ul class="weapon-list">${teamWeapons}</ul>
                </div>
                <div>
                  <h3 class="match-title">본인 피해 공격수단</h3>
                  <ul class="weapon-list">${selfWeapons || "<li><span>기록 없음</span><span>0.0</span></li>"}</ul>
                </div>
                <div>
                  <h3 class="match-title">전체 공격수단</h3>
                  <ul class="weapon-list">${allWeapons}</ul>
                </div>
              </div>
            </div>
            <section class="team-damage-detail">
              <h3 class="match-title">아군 피해 상세</h3>
              <div class="team-damage-grid">
                <div class="team-damage-header">경과 시간</div>
                <div class="team-damage-header">공격수단</div>
                <div class="team-damage-header">피해 아군</div>
                <div class="team-damage-header">데미지</div>
                ${teamDamageDetails}
              </div>
            </section>
            <section class="team-damage-detail">
              <h3 class="match-title">맞은 아군이 다시 이 플레이어에게 입힌 데미지</h3>
              <p class="detail-note">위 아군 피해 상세에 등장한 아군이 검색 플레이어에게 준 데미지만 집계합니다.</p>
              <div class="team-damage-grid">
                <div class="team-damage-header">경과 시간</div>
                <div class="team-damage-header">공격수단</div>
                <div class="team-damage-header">공격 아군</div>
                <div class="team-damage-header">데미지</div>
                ${teammateReturnDamageDetails}
              </div>
            </section>
          </div>
        </article>
      `;
    })
    .join("");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const playerName = input.value.trim();
  if (!playerName) return;

  submitButton.disabled = true;
  introBox.hidden = true;
  resultsView.hidden = true;
  resultsBox.innerHTML = "";
  paginationBox.innerHTML = "";
  setStatus("조회 중입니다. 시간이 다소 오래 걸릴 수 있습니다.");

  try {
    const response = await fetch(`/api/teamkills/${encodeURIComponent(playerName)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "조회에 실패했습니다.");
    }

    clearStatus();
    renderSummary(data);
    currentMatches = data.matches;
    currentPage = 1;
    expandedMatchIds.clear();
    resultsView.hidden = false;
    renderCurrentPage();
  } catch (error) {
    introBox.hidden = false;
    resultsView.hidden = true;
    resultsBox.innerHTML = "";
    paginationBox.innerHTML = "";
    setStatus(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

paginationBox.addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (!button || button.disabled) return;

  currentPage = Number(button.dataset.page);
  renderCurrentPage();
  resultsView.scrollIntoView({ behavior: "smooth", block: "start" });
});

resultsBox.addEventListener("click", (event) => {
  const toggle = event.target.closest(".match-toggle");
  if (!toggle) return;

  const matchId = toggle.dataset.matchId;
  if (expandedMatchIds.has(matchId)) {
    expandedMatchIds.delete(matchId);
  } else {
    expandedMatchIds.add(matchId);
  }

  renderCurrentPage();
});

resultsBox.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;

  const toggle = event.target.closest(".match-toggle");
  if (!toggle) return;

  event.preventDefault();
  toggle.click();
});
