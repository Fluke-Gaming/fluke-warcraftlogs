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
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // expire 60s early to be safe

  return cachedToken;
}

export default {
  async fetch(request, env) {
    // Allowed origins for CORS
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

    // Handle preflight OPTIONS requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const cache = caches.default;
    const cacheKey = new Request(request.url, request);

    // Serve from cache if available
    let response = await cache.match(cacheKey);
    if (response) return response;

    try {
      const clientId     = env.WCL_CLIENT_ID;
      const clientSecret = env.WCL_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("WCL credentials not found");

      // Step 1: fetch OAuth token
      const access_token = await getAccessToken(clientId, clientSecret);

      // Step 2: query GraphQL
      const query = `
        query {
          guildData {
            guild(name: "Fluke", serverSlug: "frostmane", serverRegion: "US") {
              zoneRanking {
                progress {
                  worldRank { number color }
                  regionRank { number color }
                  serverRank { number color }
                }
                speed {
                  worldRank { number color }
                  regionRank { number color }
                  serverRank { number color }
                }
              }
            }
          }
        }
      `;

      const gqlRes = await fetch("https://www.warcraftlogs.com/api/v2/client", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${access_token}`,
        },
        body: JSON.stringify({ query }),
      });
      if (!gqlRes.ok) throw new Error(`WCL GraphQL error: ${gqlRes.statusText}`);
      const gqlData = await gqlRes.json();
      // console.log(JSON.stringify(gqlData, null, 2));

      if (gqlData.errors) throw new Error(gqlData.errors[0].message);

      const zoneRankings = gqlData.data?.guildData?.guild?.zoneRanking ?? {};

      const result = {
        progress: {
          world:  zoneRankings.progress?.worldRank  ?? null,
          region: zoneRankings.progress?.regionRank ?? null,
          server: zoneRankings.progress?.serverRank ?? null,
        },
        speed: {
          world:  zoneRankings.speed?.worldRank  ?? null,
          region: zoneRankings.speed?.regionRank ?? null,
          server: zoneRankings.speed?.serverRank ?? null,
        },
      };

      // Create response with CORS headers
      response = new Response(JSON.stringify(result), { headers: corsHeaders });

      // Cache the response
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