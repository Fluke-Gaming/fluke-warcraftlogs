return 200;

// // --------------------------------------------------
// // WORKER: WARCRAFT LOGS PROXY
// // --------------------------------------------------

// const CACHE_TTL = 300; // 5 minutes

// export default {
//   async fetch(request, env) {
//     // Allowed origins for CORS
//     const ALLOWED_ORIGINS = [
//       "https://flukegaming.com",
//       "https://test.flukegaming.com"
//     ];

//     const origin = request.headers.get("Origin") || "";
//     const corsHeaders = {
//       "Access-Control-Allow-Methods": "GET, OPTIONS",
//       "Access-Control-Allow-Headers": "Content-Type",
//       "Content-Type": "application/json",
//     };

//     if (ALLOWED_ORIGINS.includes(origin)) {
//       corsHeaders["Access-Control-Allow-Origin"] = origin;
//     }

//     // Handle preflight OPTIONS requests
//     if (request.method === "OPTIONS") {
//       return new Response(null, { headers: corsHeaders });
//     }

//     const cache = caches.default;
//     const cacheKey = new Request(request.url, request);

//     // Serve from cache if available
//     let response = await cache.match(cacheKey);
//     if (response) return response;

//     try {
//       // Access your secret via env
//       const apiKey = env.GCALENDAR_API_KEY;
//       const calendar = env.CALENDAR_ID;
//       if (!apiKey) throw new Error("GCALENDAR_API_KEY secret not found");

//       // Google Calendar API URL for upcoming events
//       const url = `https://www.googleapis.com/calendar/v3/calendars/${calendar}/events?key=${apiKey}&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`;

//       const res = await fetch(url);
//       if (!res.ok) throw new Error(`Google API error: ${res.statusText}`);
//       const data = await res.json();

//       const now = new Date();
//       const upcomingEvents = data.items
//       .filter(event => {
//         const start = new Date(event.start.dateTime || event.start.date);
//         return start > now;
//       })
//       .sort((a, b) => {
//         const aStart = new Date(a.start.dateTime || a.start.date);
//         const bStart = new Date(b.start.dateTime || b.start.date);
//         return aStart - bStart;
//       })
//       .slice(0, 10);

//       const simplified = upcomingEvents.map(event => ({
//         title: event.summary,
//         start: event.start.dateTime || event.start.date,
//         end: event.end.dateTime || event.end.date,
//         description: event.description || null
//       }));

//       // Create response with CORS headers
//       response = new Response(JSON.stringify(simplified), { headers: corsHeaders });

//       // Cache the response
//       response.headers.append("Cache-Control", `public, max-age=${CACHE_TTL}`);
//       await cache.put(cacheKey, response.clone());

//       return response;
//     } catch (err) {
//       return new Response(JSON.stringify({ error: err.message }), {
//         status: 500,
//         headers: corsHeaders,
//       });
//     }
//   },
// };