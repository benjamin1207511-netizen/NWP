// functions/api/models-proxy.js
// Open-Meteo 代理，带确定性 10 分钟时间桶缓存
// 同窗口内所有用户共享一份缓存，跨窗口自动回源拉新数据

const ALLOWED_DOMAINS = new Set([
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
]);

// ⚠️ 上线后建议改成你自己的域名，例如 'https://你的域名.pages.dev'
// 用 '*' 表示允许所有来源（测试方便，但不安全）
const ALLOWED_ORIGIN = '*';

const TTL_MS = 10 * 60 * 1000;

export async function onRequest(context) {
  const { request, waitUntil } = context;

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return new Response('missing url', { status: 400 });

  let t;
  try { t = new URL(targetUrl); } catch { return new Response('bad url', { status: 400 }); }
  if (!ALLOWED_DOMAINS.has(t.hostname)) {
    return new Response('forbidden', { status: 403 });
  }

  // 10 分钟时间桶
  const bucket = Math.floor(Date.now() / TTL_MS);

  // 上游 URL 附加 _ts，仅用于区分缓存窗口（对 Open-Meteo 是无害参数）
  const upstream = new URL(t.toString());
  upstream.searchParams.set('_ts', String(bucket));

  const cache = caches.default;
  // cacheKey 必须包含 pathname，否则三个不同接口会撞 key
  const cacheKey = new Request('https://internal.cache/models' + upstream.pathname + upstream.search);

  const cors = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Content-Type': 'application/json',
  };

  // 查缓存
  const cached = await cache.match(cacheKey);
  if (cached) {
    const h = new Headers(cors);
    h.set('X-Cache', 'HIT');
    h.set('Cache-Control', 'no-store');
    return new Response(cached.body, { status: 200, headers: h });
  }

  // 回源
  const resp = await fetch(upstream.toString(), {
    headers: { 'User-Agent': 'NWP-Studio/1.0' },
  });
  const body = await resp.text();

  // 成功则写缓存
  if (resp.ok) {
    const ch = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${TTL_MS / 1000}`,
    });
    waitUntil(cache.put(cacheKey, new Response(body, { status: 200, headers: ch })));
  }

  const h = new Headers(cors);
  h.set('X-Cache', 'MISS');
  h.set('Cache-Control', 'no-store');
  return new Response(body, { status: resp.status, headers: h });
}
