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

app.use(express.static(path.join(__dirname, "public")));

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

function elapsedSecondsFromMatchStart(matchCreatedAt, eventTime) {
  const elapsedMs = new Date(eventTime) - new Date(matchCreatedAt);
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, Math.floor(elapsedMs / 1000));
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
  return pubgFetch(`https://api.pubg.com/shards/steam/matches/${matchId}`);
}

async function fetchTelemetry(telemetryURL) {
  const response = await fetch(telemetryURL);
  if (!response.ok) {
    throw new Error(`Telemetry error ${response.status}: ${response.statusText}`);
  }
  return response.json();
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

app.listen(PORT, () => {
  console.log(`Teamkill website is running at http://localhost:${PORT}`);
});
