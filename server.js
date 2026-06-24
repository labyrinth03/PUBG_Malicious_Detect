import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import { MAP_NAMES, DAMAGE_CAUSE_NAMES } from "./datacode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const PUBG_API_KEY = process.env.PUBG_API_KEY;
const PORT = process.env.PORT || 3000;
const app = express();
const MAX_MATCH_CACHE_ENTRIES = 1000;
const MAX_TELEMETRY_CACHE_ENTRIES = 40;
const MAX_ANALYSIS_CACHE_ENTRIES = 3000;
const matchCache = new Map();
const telemetryCache = new Map();
const analysisCache = new Map();

app.use(express.static(path.join(__dirname, "public")));

function cachePromise(cache, key, promise, maxEntries) {
  if (cache.size >= maxEntries && !cache.has(key)) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

function modeText(matchType) {
  if (matchType === "custom") return "커스텀";
  if (matchType === "airoyale") return "캐주얼";
  if (matchType === "competitive") return "경쟁전";
  if (matchType === "official") return "일반전";
  if (matchType === "event" || matchType === "arcade") return "아케이드";
  if (matchType === "training") return "훈련모드";
  return "기타";
}

function teamText(teamSize) {
  if (teamSize === 1) return "솔로";
  if (teamSize === 2) return "듀오";
  return "스쿼드";
}

function gameModeText(gameMode) {
  if (!gameMode) return "알 수 없음";
  if (gameMode.includes("solo")) return "솔로";
  if (gameMode.includes("duo")) return "듀오";
  if (gameMode.includes("squad")) return "스쿼드";
  return gameMode;
}

function elapsedSecondsFromMatchStart(matchCreatedAt, eventTime) {
  const elapsedMs = new Date(eventTime) - new Date(matchCreatedAt);
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, Math.floor(elapsedMs / 1000));
}

function formatMatchDate(dateValue) {
  if (!dateValue) return "날짜 없음";
  return new Date(dateValue).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

async function getMatchDateRange(matchIds) {
  if (matchIds.length === 0) {
    return { oldestDate: null, newestDate: null, label: "날짜 없음" };
  }

  const newestMatchId = matchIds[0];
  const oldestMatchId = matchIds[matchIds.length - 1];
  const [newestMatch, oldestMatch] = await Promise.all([
    fetchMatch(newestMatchId),
    newestMatchId === oldestMatchId ? null : fetchMatch(oldestMatchId),
  ]);

  const newestDate = newestMatch?.data?.attributes?.createdAt || null;
  const oldestDate = oldestMatch?.data?.attributes?.createdAt || newestDate;

  return {
    oldestDate,
    newestDate,
    label: `${formatMatchDate(oldestDate)} - ${formatMatchDate(newestDate)}`,
  };
}

function findParticipantByPlayerId(matchData, playerId) {
  return matchData.included
    ?.filter((item) => item.type === "participant")
    .find((participant) => participant.attributes?.stats?.playerId === playerId);
}

function findRosterByParticipantId(matchData, participantId) {
  return matchData.included?.find(
    (item) =>
      item.type === "roster" &&
      item.relationships?.participants?.data?.some((participant) => participant.id === participantId)
  );
}

async function pubgFetch(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${PUBG_API_KEY}`,
      Accept: "application/vnd.api+json",
    },
  });

  if (!response.ok) {
    throw new Error(`PUBG API error ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function fetchPlayer(playerName) {
  const encodedName = encodeURIComponent(playerName);
  const data = await pubgFetch(`https://api.pubg.com/shards/steam/players?filter[playerNames]=${encodedName}`);
  return data.data?.[0] || null;
}

async function fetchMatch(matchId) {
  if (matchCache.has(matchId)) return matchCache.get(matchId);

  return cachePromise(
    matchCache,
    matchId,
    pubgFetch(`https://api.pubg.com/shards/steam/matches/${matchId}`),
    MAX_MATCH_CACHE_ENTRIES
  );
}

async function fetchTelemetry(telemetryURL) {
  if (telemetryCache.has(telemetryURL)) return telemetryCache.get(telemetryURL);

  const telemetryPromise = (async () => {
    const response = await fetch(telemetryURL);
    if (!response.ok) {
      throw new Error(`Telemetry error ${response.status}: ${response.statusText}`);
    }
    return response.json();
  })();

  return cachePromise(telemetryCache, telemetryURL, telemetryPromise, MAX_TELEMETRY_CACHE_ENTRIES);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        console.error(error);
        results[currentIndex] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function analyzeMatch(matchId, playerId, playerName) {
  const cacheKey = `${playerId}:${matchId}`;
  if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey);

  return cachePromise(
    analysisCache,
    cacheKey,
    analyzeMatchUncached(matchId, playerId, playerName),
    MAX_ANALYSIS_CACHE_ENTRIES
  );
}

async function analyzeMatchUncached(matchId, playerId, playerName) {
  const matchData = await fetchMatch(matchId);
  if (!matchData?.data || !matchData?.included) return null;

  const participants = matchData.included.filter((item) => item.type === "participant");
  const playerStats = participants.find((p) => p.attributes.stats.playerId === playerId);
  if (!playerStats) return null;

  const roster = matchData.included.find(
    (item) => item.type === "roster" && item.relationships.participants.data.some((p) => p.id === playerStats.id)
  );
  if (!roster) return null;

  const teamPlayerIds = roster.relationships.participants.data.map((p) => p.id);
  const teamPlayers = participants.filter((p) => teamPlayerIds.includes(p.id));
  const teammateNames = teamPlayers
    .map((p) => p.attributes.stats.name)
    .filter((name) => name.toLowerCase() !== playerName.toLowerCase());
  const teammateNameSet = new Set(teammateNames.map((name) => name.toLowerCase()));
  const teamSurvivalTime = Math.max(...teamPlayers.map((p) => p.attributes.stats.timeSurvived || 0));
  const telemetryURL = matchData.included.find((asset) => asset.type === "asset")?.attributes.URL;
  const matchCreatedAt = matchData.data.attributes.createdAt;
  const damageByWeapon = {};
  const teamDamageByWeapon = {};
  const teamDamageDetails = [];
  const teamDamagedVictimSet = new Set();
  const teammateReturnDamageEvents = [];
  const selfDamageByWeapon = {};
  const playerNameLower = playerName.toLowerCase();

  if (telemetryURL) {
    const telemetryData = await fetchTelemetry(telemetryURL);
    for (const event of telemetryData) {
      if (event._T !== "LogPlayerTakeDamage") continue;

      const attackerName = event.attacker?.name;
      const attackerNameLower = attackerName?.toLowerCase();
      const victimName = event.victim?.name?.toLowerCase();
      const weapon = DAMAGE_CAUSE_NAMES[event.damageCauserName] || event.damageCauserName || "Unknown";
      const damage = event.damage || 0;
      if (damage < 0.05) continue;

      if (attackerNameLower === playerNameLower) {
        damageByWeapon[weapon] = (damageByWeapon[weapon] || 0) + damage;

        if (teammateNameSet.has(victimName)) {
          const victimDisplayName = event.victim.name;
          teamDamagedVictimSet.add(victimName);
          teamDamageByWeapon[weapon] = (teamDamageByWeapon[weapon] || 0) + damage;
          teamDamageDetails.push({
            elapsedSeconds: elapsedSecondsFromMatchStart(matchCreatedAt, event._D),
            weapon,
            victimName: victimDisplayName,
            damage: Number(damage.toFixed(1)),
          });
        }

        if (victimName === playerNameLower) {
          selfDamageByWeapon[weapon] = (selfDamageByWeapon[weapon] || 0) + damage;
        }
      }

      if (victimName === playerNameLower && teammateNameSet.has(attackerNameLower)) {
        teammateReturnDamageEvents.push({
          attackerName,
          attackerNameLower,
          elapsedSeconds: elapsedSecondsFromMatchStart(matchCreatedAt, event._D),
          weapon,
          damage,
        });
      }
    }
  }

  const teammateReturnDamageDetails = [];
  for (const event of teammateReturnDamageEvents) {
    if (!teamDamagedVictimSet.has(event.attackerNameLower)) continue;

    teammateReturnDamageDetails.push({
      elapsedSeconds: event.elapsedSeconds,
      weapon: event.weapon,
      attackerName: event.attackerName,
      damage: Number(event.damage.toFixed(1)),
    });
  }

  const totalWeaponDamage = Object.values(damageByWeapon).reduce((sum, damage) => sum + damage, 0);
  const officialDamage = playerStats.attributes.stats.damageDealt || 0;
  const teamKillDamage = Object.values(teamDamageByWeapon).reduce((sum, damage) => sum + damage, 0);
  const selfDamage = Object.values(selfDamageByWeapon).reduce((sum, damage) => sum + damage, 0);
  const teammateReturnDamage = teammateReturnDamageDetails.reduce((sum, event) => sum + event.damage, 0);

  if (teamKillDamage < 0.05) return null;

  return {
    matchId,
    playerName,
    playedAt: new Date(matchCreatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    mapName: MAP_NAMES[matchData.data.attributes.mapName] || matchData.data.attributes.mapName || "알 수 없음",
    matchType: modeText(matchData.data.attributes.matchType),
    teamType: teamText(teamPlayers.length),
    teamMembers: teammateNames,
    teamSurvivalSeconds: Math.floor(teamSurvivalTime),
    rank: playerStats.attributes.stats.winPlace,
    kills: playerStats.attributes.stats.kills,
    assists: playerStats.attributes.stats.assists,
    dbnos: playerStats.attributes.stats.DBNOs,
    officialDamage: Number(officialDamage.toFixed(1)),
    totalWeaponDamage: Number(totalWeaponDamage.toFixed(1)),
    teamKillDamage: Number(teamKillDamage.toFixed(1)),
    selfDamage: Number(selfDamage.toFixed(1)),
    teammateReturnDamage: Number(teammateReturnDamage.toFixed(1)),
    accountedDamage: Number((officialDamage + teamKillDamage + selfDamage).toFixed(1)),
    teamDamageByWeapon: Object.entries(teamDamageByWeapon)
      .map(([weapon, damage]) => ({ weapon, damage: Number(damage.toFixed(1)) }))
      .sort((a, b) => b.damage - a.damage),
    teamDamageDetails: teamDamageDetails.sort((a, b) => a.elapsedSeconds - b.elapsedSeconds),
    teammateReturnDamageDetails: teammateReturnDamageDetails.sort((a, b) => a.elapsedSeconds - b.elapsedSeconds),
    selfDamageByWeapon: Object.entries(selfDamageByWeapon)
      .map(([weapon, damage]) => ({ weapon, damage: Number(damage.toFixed(1)) }))
      .sort((a, b) => b.damage - a.damage),
    damageByWeapon: Object.entries(damageByWeapon)
      .map(([weapon, damage]) => ({ weapon, damage: Number(damage.toFixed(1)) }))
      .sort((a, b) => b.damage - a.damage),
  };
}

app.get("/api/teamkills/:playerName", async (req, res) => {
  if (!PUBG_API_KEY) {
    return res.status(500).json({ error: "PUBG_API_KEY가 설정되지 않았습니다." });
  }

  const playerName = req.params.playerName.trim();
  if (!playerName) {
    return res.status(400).json({ error: "플레이어 닉네임을 입력해주세요." });
  }

  try {
    const player = await fetchPlayer(playerName);
    if (!player) {
      return res.status(404).json({ error: `${playerName} 플레이어를 찾을 수 없습니다.` });
    }

    const matchIds = player.relationships?.matches?.data?.map((match) => match.id) || [];
    const results = (await mapWithConcurrency(matchIds, 6, (matchId) => analyzeMatch(matchId, player.id, player.attributes.name)))
      .filter(Boolean);

    res.json({
      playerName: player.attributes.name,
      scannedMatches: matchIds.length,
      teamKillMatches: results.length,
      matches: results,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "조회 중 오류가 발생했습니다. API 제한 또는 일시적인 네트워크 문제일 수 있습니다." });
  }
});

app.get("/api/sniper-check", async (req, res) => {
  if (!PUBG_API_KEY) {
    return res.status(500).json({ error: "PUBG_API_KEY가 설정되지 않았습니다." });
  }

  const playerName = String(req.query.playerName || "").trim();
  const suspectName = String(req.query.suspectName || "").trim();

  if (!playerName || !suspectName) {
    return res.status(400).json({ error: "본인 닉네임과 저격 의심 닉네임을 모두 입력해주세요." });
  }

  try {
    const [player, suspect] = await Promise.all([
      fetchPlayer(playerName),
      fetchPlayer(suspectName),
    ]);

    if (!player) {
      return res.status(404).json({ error: `${playerName} 플레이어를 찾을 수 없습니다.` });
    }

    if (!suspect) {
      return res.status(404).json({ error: `${suspectName} 플레이어를 찾을 수 없습니다.` });
    }

    const playerMatchIds = player.relationships?.matches?.data?.map((match) => match.id) || [];
    const suspectMatchIds = suspect.relationships?.matches?.data?.map((match) => match.id) || [];
    const suspectMatchIdSet = new Set(suspectMatchIds);
    const commonMatchIds = playerMatchIds.filter((matchId) => suspectMatchIdSet.has(matchId));
    const [playerMatchRange, suspectMatchRange] = await Promise.all([
      getMatchDateRange(playerMatchIds),
      getMatchDateRange(suspectMatchIds),
    ]);

    const commonMatches = (await mapWithConcurrency(commonMatchIds, 6, async (matchId) => {
      const matchData = await fetchMatch(matchId);
      if (!matchData?.data?.attributes || !matchData?.included) return null;

      const playerParticipant = findParticipantByPlayerId(matchData, player.id);
      const suspectParticipant = findParticipantByPlayerId(matchData, suspect.id);
      if (!playerParticipant || !suspectParticipant) return null;

      const playerRoster = findRosterByParticipantId(matchData, playerParticipant.id);
      const suspectRoster = findRosterByParticipantId(matchData, suspectParticipant.id);
      if (playerRoster?.id && playerRoster.id === suspectRoster?.id) return null;

      const attributes = matchData.data.attributes;
      return {
        matchId,
        playedAt: new Date(attributes.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
        mapName: MAP_NAMES[attributes.mapName] || attributes.mapName || "알 수 없음",
        matchType: modeText(attributes.matchType),
        gameMode: gameModeText(attributes.gameMode),
      };
    })).filter(Boolean);

    res.json({
      playerName: player.attributes.name,
      suspectName: suspect.attributes.name,
      playerScannedMatches: playerMatchIds.length,
      suspectScannedMatches: suspectMatchIds.length,
      playerMatchRange,
      suspectMatchRange,
      commonMatchCount: commonMatches.length,
      matches: commonMatches,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "저격 의심 조회 중 오류가 발생했습니다. API 제한 또는 일시적인 네트워크 문제일 수 있습니다." });
  }
});

app.listen(PORT, () => {
  console.log(`Teamkill website is running at http://localhost:${PORT}`);
});
