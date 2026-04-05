// --------------------------------------------------
// WORKER: WARCRAFT LOGS PROXY
// --------------------------------------------------

const CACHE_TTL = 300; // 5 minutes

let cachedToken = null;
let tokenExpiry = 0;

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
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

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

export default {
  async fetch(request, env) {
    const ALLOWED_ORIGINS = [
      "https://flukegaming.com",
      "https://test.flukegaming.com"
    ];

    const origin = request.headers.get("Origin") || "";
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };
    if (ALLOWED_ORIGINS.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Route based on path
    const path = new URL(request.url).pathname;

    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    let response = await cache.match(cacheKey);
    if (response) return response;

    try {
      const clientId     = env.WCL_CLIENT_ID;
      const clientSecret = env.WCL_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("WCL credentials not found");

      const accessToken = await getAccessToken(clientId, clientSecret);
      let result;

      if (path === "/rankings") {
        const data = await queryWCL(`
          query {
            guildData {
              guild(name: "Fluke", serverSlug: "frostmane", serverRegion: "US") {
                zoneRanking {
                  progress {
                    worldRank { number color }
                    regionRank { number color }
                    serverRank { number color }
                  }
                  speed: {
                    world:  zoneRankings.speed?.worldRank  ?? null,
                    region: zoneRankings.speed?.regionRank ?? null,
                    server: zoneRankings.speed?.serverRank ?? null,
                  },
                }
              }
            }
          }
        `, accessToken);

        const zoneRanking = data.data?.guildData?.guild?.zoneRanking ?? {};
        result = {
          progress: {
            world:  zoneRanking.progress?.worldRank  ?? null,
            region: zoneRanking.progress?.regionRank ?? null,
            server: zoneRanking.progress?.serverRank ?? null,
          },
          speed: {
            world:  zoneRanking.speed?.worldRank  ?? null,
            server: zoneRanking.speed?.serverRank ?? null,
          },
        };

      } else if (path === "/lastraid") {
        const data = await queryWCL(`
          query {
            reportData {
              reports(
                guildName: "Fluke",
                guildServerSlug: "frostmane",
                guildServerRegion: "US",
                limit: 1
              ) {
                data {
                  code
                  title
                  startTime
                  endTime
                  fights(killType: All) {
                    name
                    kill
                    encounterID
                    startTime
                    endTime
                  }
                }
              }
            }
          }
        `, accessToken);

        const report = data.data?.reportData?.reports?.data?.[0] ?? null;
        if (!report) throw new Error("No reports found");

        // Filter to boss fights only (encounterID > 0), deduplicated by name
        // keeping the kill if one exists, otherwise the last attempt
        const bossMap = new Map();
        for (const fight of report.fights) {
          if (fight.encounterID === 0) continue; // skip trash
          const existing = bossMap.get(fight.name);
          if (!existing || fight.kill) {
            bossMap.set(fight.name, fight);
          }
        }

        const bosses = Array.from(bossMap.values());
        const kills  = bosses.filter(b => b.kill).length;
        const total  = bosses.length;

        // Raid duration from first fight start to last fight end
        const fightTimes = report.fights.filter(f => f.encounterID > 0);
        const raidStart  = Math.min(...fightTimes.map(f => f.startTime));
        const raidEnd    = Math.max(...fightTimes.map(f => f.endTime));
        const durationMs = raidEnd - raidStart;
        const hours      = Math.floor(durationMs / 3600000);
        const minutes    = Math.floor((durationMs % 3600000) / 60000);
        const duration   = `${hours}h ${String(minutes).padStart(2, '0')}m`;

        const date = new Date(report.startTime).toLocaleDateString('en-US', {
          month: 'long', day: 'numeric'
        });

        result = {
          code:     report.code,
          title:    report.title,
          date,
          duration,
          kills,
          total,
          bosses:   bosses.map(b => ({ name: b.name, kill: b.kill })),
          url:      `https://www.warcraftlogs.com/reports/${report.code}`,
        };

      } else {
        return new Response(JSON.stringify({ error: "Unknown route. Use /rankings or /lastraid" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      response = new Response(JSON.stringify(result), { headers: corsHeaders });
      response.headers.append("Cache-Control", `public, max-age=${CACHE_TTL}`);
      await cache.put(cacheKey, response.clone());
      return response;

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};