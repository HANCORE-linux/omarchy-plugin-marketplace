const allowedOrigins = new Set([
  "https://omarchyplugins.com",
  "https://www.omarchyplugins.com",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const eventTypes = new Set(["view", "copy", "heart"]);
const defaultCatalogUrl = "https://omarchyplugins.com/catalog.json";
const defaultDailyEventLimit = 10_000;
const catalogCacheLifetime = 5 * 60 * 1000;
let catalogCache = { url: "", expiresAt: 0, pluginIds: new Set() };

function validPluginId(value) {
  return pluginIdPattern.test(value) && !unsafeObjectKeys.has(value.toLowerCase());
}

function corsHeaders(origin) {
  if (!allowedOrigins.has(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function eventLimit(value) {
  const limit = Math.trunc(Number(value));
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 1_000_000)
    : defaultDailyEventLimit;
}

function validCatalogUrl(value) {
  try {
    const url = new URL(value || defaultCatalogUrl);
    const local = ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function parseEngagementEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pluginId = String(value.pluginId || "");
  const type = String(value.type || "");
  if (
    !validPluginId(pluginId)
    || !eventTypes.has(type)
    || Object.keys(value).some((key) => !["pluginId", "type"].includes(key))
  ) return null;
  return { pluginId, type };
}

async function catalogPluginIds(env, fetchImpl, now = Date.now()) {
  const url = validCatalogUrl(env.CATALOG_URL);
  if (!url) throw new Error("CATALOG_URL is invalid");
  if (catalogCache.url === url && catalogCache.expiresAt > now) {
    return catalogCache.pluginIds;
  }
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Catalog returned ${response.status}`);
  const catalog = await response.json();
  if (!catalog || !Array.isArray(catalog.plugins)) throw new Error("Catalog response is invalid");
  const pluginIds = new Set(
    catalog.plugins
      .map((plugin) => plugin?.id)
      .filter((pluginId) => validPluginId(String(pluginId || ""))),
  );
  catalogCache = { url, expiresAt: now + catalogCacheLifetime, pluginIds };
  return pluginIds;
}

function safeCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function normalizedRows(results) {
  const plugins = {};
  for (const row of results || []) {
    const pluginId = String(row.plugin_id || "");
    if (!validPluginId(pluginId)) continue;
    plugins[pluginId] = {
      views: safeCount(row.views),
      copies: safeCount(row.copies),
      hearts: safeCount(row.hearts),
    };
  }
  return plugins;
}

const engagementTotalsSql = `
  SELECT SUM(views) AS views, SUM(copies) AS copies, SUM(hearts) AS hearts
  FROM plugin_engagement_daily
  WHERE plugin_id = ?1
`;

function normalizedTotals(row) {
  return {
    views: safeCount(row?.views),
    copies: safeCount(row?.copies),
    hearts: safeCount(row?.hearts),
  };
}

async function statsResponse(env) {
  const result = await env.ENGAGEMENT_DB.prepare(`
    SELECT plugin_id, SUM(views) AS views, SUM(copies) AS copies, SUM(hearts) AS hearts
    FROM plugin_engagement_daily
    GROUP BY plugin_id
    ORDER BY plugin_id
  `).all();
  return json(
    { schemaVersion: 1, plugins: normalizedRows(result.results) },
    200,
    {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  );
}

function browserStatsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cachedStatsResponse(request, env, cache, waitUntil) {
  const cacheKey = new Request(new URL("/v1/stats", request.url), { method: "GET" });
  if (cache?.match) {
    const cached = await cache.match(cacheKey);
    if (cached) return browserStatsResponse(cached);
  }
  const response = await statsResponse(env);
  if (cache?.put) {
    const write = cache.put(cacheKey, response.clone()).catch(() => {});
    waitUntil(write);
  }
  return browserStatsResponse(response);
}

async function readLimitedBody(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

const engagementUpsertSql = `
  INSERT INTO plugin_engagement_daily (plugin_id, day, views, copies, hearts)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(plugin_id, day) DO UPDATE SET
    views = CASE WHEN excluded.views > 0
      THEN MIN(plugin_engagement_daily.views + excluded.views, ?6)
      ELSE plugin_engagement_daily.views END,
    copies = CASE WHEN excluded.copies > 0
      THEN MIN(plugin_engagement_daily.copies + excluded.copies, ?6)
      ELSE plugin_engagement_daily.copies END,
    hearts = CASE WHEN excluded.hearts > 0
      THEN MIN(plugin_engagement_daily.hearts + excluded.hearts, ?6)
      ELSE plugin_engagement_daily.hearts END
  WHERE
    (excluded.views > 0 AND plugin_engagement_daily.views < ?6)
    OR (excluded.copies > 0 AND plugin_engagement_daily.copies < ?6)
    OR (excluded.hearts > 0 AND plugin_engagement_daily.hearts < ?6)
  RETURNING plugin_id
`;

export function engagementUpsertStatement() {
  return engagementUpsertSql;
}

async function eventResponse(request, env, origin, fetchImpl) {
  if (!allowedOrigins.has(origin)) return json({ error: "Origin not allowed" }, 403);
  const contentType = request.headers.get("Content-Type") || "";
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json({ error: "Expected a JSON request" }, 415, corsHeaders(origin));
  }
  if (Number.isFinite(contentLength) && contentLength > 1024) {
    return json({ error: "Request body too large" }, 413, corsHeaders(origin));
  }

  if (!env.ENGAGEMENT_RATE_LIMITER?.limit) {
    return json({ error: "Rate limiter unavailable" }, 503, corsHeaders(origin));
  }
  const actor = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimit = await env.ENGAGEMENT_RATE_LIMITER.limit({ key: `events:${actor}` });
  if (!rateLimit.success) {
    return json(
      { error: "Rate limit exceeded" },
      429,
      { ...corsHeaders(origin), "Retry-After": "60" },
    );
  }

  let event;
  try {
    const body = await readLimitedBody(request, 1024);
    if (body === null) {
      return json({ error: "Request body too large" }, 413, corsHeaders(origin));
    }
    event = parseEngagementEvent(JSON.parse(body));
  } catch {
    event = null;
  }
  if (!event) return json({ error: "Invalid engagement event" }, 400, corsHeaders(origin));

  let pluginIds;
  try {
    pluginIds = await catalogPluginIds(env, fetchImpl);
  } catch {
    return json({ error: "Plugin catalog unavailable" }, 503, corsHeaders(origin));
  }
  if (!pluginIds.has(event.pluginId)) {
    return json({ error: "Unknown plugin" }, 404, corsHeaders(origin));
  }

  const day = new Date().toISOString().slice(0, 10);
  const views = event.type === "view" ? 1 : 0;
  const copies = event.type === "copy" ? 1 : 0;
  const hearts = event.type === "heart" ? 1 : 0;
  const limit = eventLimit(env.DAILY_EVENT_LIMIT);
  const [writeResult, totalsResult] = await env.ENGAGEMENT_DB.batch([
    env.ENGAGEMENT_DB.prepare(engagementUpsertSql)
      .bind(event.pluginId, day, views, copies, hearts, limit),
    env.ENGAGEMENT_DB.prepare(engagementTotalsSql).bind(event.pluginId),
  ]);

  if (!writeResult?.results?.length) {
    return json({ recorded: false, reason: "daily-limit" }, 202, corsHeaders(origin));
  }
  return json({
    recorded: true,
    plugin: normalizedTotals(totalsResult?.results?.[0]),
  }, 202, corsHeaders(origin));
}

export async function handleRequest(request, env, {
  fetchImpl = fetch,
  cache = globalThis.caches?.default,
  waitUntil = () => {},
} = {}) {
  if (!env?.ENGAGEMENT_DB) return json({ error: "Service unavailable" }, 503);
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";

  if (request.method === "OPTIONS") {
    if (!allowedOrigins.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (url.pathname === "/v1/stats") {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET", ...corsHeaders(origin) });
    }
    try {
      return await cachedStatsResponse(request, env, cache, waitUntil);
    } catch {
      return json({ error: "Stats unavailable" }, 503, corsHeaders(origin));
    }
  }
  if (url.pathname === "/v1/events") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST", ...corsHeaders(origin) });
    }
    try {
      return await eventResponse(request, env, origin, fetchImpl);
    } catch {
      return json({ error: "Event service unavailable" }, 503, corsHeaders(origin));
    }
  }
  return json({ error: "Not found" }, 404, corsHeaders(origin));
}

export default {
  fetch(request, env, context) {
    return handleRequest(request, env, {
      cache: globalThis.caches?.default,
      waitUntil: context.waitUntil.bind(context),
    });
  },
};

# Fix for issue #370: safe input handling
