// --------------------------------------------------
// WORKER: WARCRAFT LOGS PROXY
// --------------------------------------------------

const CACHE_TTL = 300; // 5 minutes

// ── Guild config ─────────────────────────────────
const GUILD = {
  name:      "Fluke",
  slug:      "frostmane",
  region:    "US",
  wclId:     570091,
  timezone:  "America/Edmonton",
};

// ── Token cache ──────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getAccessToken(clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`WCL token error: ${res.statusText}`);
  const data  = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── GraphQL helper ───────────────────────────────
async function queryWCL(query, accessToken) {
  const res = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`WCL GraphQL error: ${res.statusText}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data;
}

// ── Date key helper ──────────────────────────────
function raidDateKey(unixMs) {
  return new Date(unixMs).toLocaleDateString('en-CA', {
    timeZone: GUILD.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

// ── Route handlers ───────────────────────────────
async function handleRankings(accessToken) {
  const data = await queryWCL(`
    query {
      guildData {
        guild(name: "${GUILD.name}", serverSlug: "${GUILD.slug}", serverRegion: "${GUILD.region}") {
          zoneRanking {
            progress {
              worldRank  { number color }
              regionRank { number color }
              serverRank { number color }
            }
            speed {
              worldRank  { number color }
              regionRank { number color }
              serverRank { number color }
            }
          }
        }
      }
    }
  `, accessToken);

  const zr = data.data?.guildData?.guild?.zoneRanking ?? {};
  return {
    progress: {
      world:  zr.progress?.worldRank  ?? null,
      region: zr.progress?.regionRank ?? null,
      server: zr.progress?.serverRank ?? null,
    },
    speed: {
      world:  zr.speed?.worldRank  ?? null,
      region: zr.speed?.regionRank  ?? null,
      server: zr.speed?.serverRank ?? null,
    },
  };
}

async function handleLastRaid(accessToken) {
  const data = await queryWCL(`
    query {
      reportData {
        reports(guildName: "${GUILD.name}", guildServerSlug: "${GUILD.slug}", guildServerRegion: "${GUILD.region}", limit: 10) {
          data {
            code
            title
            startTime
            endTime
            fights(difficulty: 4, killType: All) {
              name
              kill
              encounterID
              startTime
              endTime
              fightPercentage
            }
          }
        }
      }
    }
  `, accessToken);

  const reports = data.data?.reportData?.reports?.data ?? [];

  // Filter to heroic reports with boss fights
  const heroicPattern  = /\((H|N\/H)\)/i;
  const heroicReports  = reports.filter(r =>
    heroicPattern.test(r.title) &&
    r.fights.some(f => f.encounterID > 0)
  );
  if (!heroicReports.length) throw new Error("No recent heroic raid reports found");

  // Group by raid date and pick most recent night
  const byDate = new Map();
  for (const r of heroicReports) {
    const key = raidDateKey(r.startTime);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }
  const mostRecentDate = [...byDate.keys()].sort().at(-1);
  const nightReports   = byDate.get(mostRecentDate);

  // Combine all boss fights from the night
  const allFights = nightReports
    .flatMap(r => r.fights)
    .filter(f => f.encounterID > 0);

  // Duration from report-level timestamps
  const nightStart = Math.min(...nightReports.map(r => r.startTime));
  const nightEnd   = Math.max(...nightReports.map(r => r.endTime));
  const durationMs = nightEnd - nightStart;
  const hours      = Math.floor(durationMs / 3600000);
  const minutes    = Math.floor((durationMs % 3600000) / 60000);
  const duration   = `${hours}h ${String(minutes).padStart(2, '0')}m`;

  // Deduplicate bosses — prefer kill, then best pull percentage
  // Skip pulls under 30 seconds
  const bossMap = new Map();
  for (const fight of allFights) {
    const fightDurationSec = (fight.endTime - fight.startTime) / 1000;
    if (fightDurationSec < 30) continue;

    const existing = bossMap.get(fight.name);
    if (!existing) {
      bossMap.set(fight.name, fight);
    } else if (fight.kill) {
      bossMap.set(fight.name, fight);
    } else if (!existing.kill && fight.fightPercentage < existing.fightPercentage) {
      bossMap.set(fight.name, fight);
    }
  }

  const bosses     = Array.from(bossMap.values());
  const kills      = bosses.filter(b => b.kill).length;
  const totalWipes = allFights.filter(f => !f.kill).length;
  const date       = new Date(nightStart).toLocaleDateString('en-US', {
    timeZone: GUILD.timezone,
    month: 'long', day: 'numeric',
  });

  return {
    code:       nightReports[0].code,
    title:      nightReports[0].title,
    date,
    duration,
    kills,
    total:      bosses.length,
    totalWipes,
    bosses:     bosses.map(b => ({
      name:     b.name,
      kill:     b.kill,
      bestPull: b.kill ? null : Math.round(b.fightPercentage),
    })),
    url: `https://www.warcraftlogs.com/guild/id/${GUILD.wclId}`,
  };
}

// ── Route map ─────────────────────────────────────
const ROUTES = {
  "/rankings": handleRankings,
  "/lastraid": handleLastRaid,
};

// ── Main fetch handler ────────────────────────────
export default {
  async fetch(request, env) {
    const ALLOWED_ORIGINS = [
      "https://flukegaming.com",
      "https://test.flukegaming.com",
    ];

    const origin     = request.headers.get("Origin") || "";
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type":                 "application/json",
    };
    if (ALLOWED_ORIGINS.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const path    = new URL(request.url).pathname;
    const handler = ROUTES[path];

    if (!handler) {
      return new Response(
        JSON.stringify({ error: `Unknown route. Valid routes: ${Object.keys(ROUTES).join(", ")}` }),
        { status: 404, headers: corsHeaders }
      );
    }

    const cache    = caches.default;
    const cacheKey = new Request(request.url, request);
    let response   = await cache.match(cacheKey);
    if (response) return response;

    try {
      const clientId     = env.WCL_CLIENT_ID;
      const clientSecret = env.WCL_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("WCL credentials not found");

      const accessToken = await getAccessToken(clientId, clientSecret);
      const result      = await handler(accessToken);

      response = new Response(JSON.stringify(result), { headers: corsHeaders });
      response.headers.append("Cache-Control", `public, max-age=${CACHE_TTL}`);
      response.headers.append("Vary", "Origin");
      await cache.put(cacheKey, response.clone());
      return response;

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeaders }
      );
    }
  },
};