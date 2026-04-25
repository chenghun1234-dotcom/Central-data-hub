/**
 * Central Data Hub — Cloudflare Worker Monitoring Agent
 * Phase 4: 무료 서비스 모니터링 에이전트
 *
 * 배포 방법:
 * 1. https://dash.cloudflare.com/ 로 이동
 * 2. Workers & Pages > Create Worker > 코드 붙여넣기
 * 3. Settings > Variables에서 환경변수 설정:
 *    - GAS_URL: 배포된 GAS 웹앱 URL
 *    - HUB_USER_ID: 본인의 RapidAPI User ID
 *    - PROXY_SECRET: GAS Script Properties에 설정한 값과 동일
 * 4. Triggers > Cron Triggers > "*/5 * * * *" (5분마다 실행)
 *
 * 무료 티어: 일 100,000회 요청 / Cron 최대 5개
 */

// ─── 모니터링할 서비스 목록 ───────────────────────────────────────────────────
const SERVICES_TO_MONITOR = [
  {
    name: "Main API Server",
    url: "https://your-api.vercel.app/health",   // ← 실제 URL로 변경
    method: "GET",
    expectedStatus: 200
  },
  {
    name: "RapidAPI Endpoint",
    url: "https://your-rapidapi-endpoint.com/status",  // ← 실제 URL로 변경
    method: "GET",
    expectedStatus: 200
  },
  // 추가 서비스는 여기에 계속 추가하세요
];

// ─── 메인 진입점 (Cron Trigger 및 API Gateway) ─────────────────────────────
export default {
  // 1. Cron Trigger가 이 함수를 실행 (5분마다 서비스 체크)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthChecks(env));
  },

  // 2. RapidAPI Gateway 및 정적 자원 서비스 로직
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // [경로 1] 헬스체크 수동 실행
    if (url.pathname === "/health-check-now") {
      await runHealthChecks(env);
      return new Response(JSON.stringify({ message: "Manual health check triggered" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // [경로 2] API 요청 (쿼리에 path가 있거나 POST 요청인 경우)
    if (url.searchParams.has("path") || request.method === "POST") {
      const GAS_URL = env.GAS_URL;
      if (!GAS_URL) return new Response("GAS_URL not configured in Environment Variables", { status: 500 });
      
      const targetUrl = new URL(GAS_URL);
      
      // 요청 파라미터 복사 및 유저 정보 주입
      const userId = request.headers.get("X-RapidAPI-User") || "LOCAL_USER";
      const proxySecret = request.headers.get("X-RapidAPI-Proxy-Secret") || env.PROXY_SECRET;

      url.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));
      targetUrl.searchParams.set("user_id", userId);
      if (proxySecret) targetUrl.searchParams.set("proxy_secret", proxySecret);

      const forwardHeaders = new Headers();
      forwardHeaders.set("Content-Type", "application/json");

      let body = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        body = await request.text();
      }

      try {
        return await fetch(targetUrl.toString(), {
          method: request.method,
          headers: forwardHeaders,
          body: body,
          redirect: "follow"
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "GAS Forwarding Failed", details: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // [경로 3] 그 외의 경우 (Landing Page 등 정적 자원 서비스)
    // Cloudflare "Workers with Assets" 기능 활용
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// ─── 헬스 체크 실행 ─────────────────────────────────────────────────────────
async function runHealthChecks(env) {
  const GAS_URL = env.GAS_URL;
  const HUB_USER_ID = env.HUB_USER_ID;
  const PROXY_SECRET = env.PROXY_SECRET;

  const results = await Promise.allSettled(
    SERVICES_TO_MONITOR.map(service => checkService(service))
  );

  // 각 서비스 결과를 중앙 허브로 보고
  for (let i = 0; i < results.length; i++) {
    const service = SERVICES_TO_MONITOR[i];
    let status, latency;

    if (results[i].status === 'fulfilled') {
      status = results[i].value.ok ? 'HEALTHY' : 'DEGRADED';
      latency = results[i].value.latency;
    } else {
      status = 'DOWN';
      latency = 0;
    }

    await reportToHub(GAS_URL, HUB_USER_ID, PROXY_SECRET, {
      service_name: service.name,
      status: status,
      latency: latency
    });
  }
}

// ─── 개별 서비스 체크 ────────────────────────────────────────────────────────
async function checkService(service) {
  const startTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10초 타임아웃

  try {
    const response = await fetch(service.url, {
      method: service.method || 'GET',
      signal: controller.signal
    });
    clearTimeout(timeout);

    const latency = Date.now() - startTime;
    return {
      ok: response.status === (service.expectedStatus || 200),
      latency: latency,
      httpStatus: response.status
    };
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`${service.name} unreachable: ${err.message}`);
  }
}

// ─── 중앙 허브로 결과 보고 ───────────────────────────────────────────────────
async function reportToHub(gasUrl, userId, proxySecret, data) {
  const payload = {
    user_id: userId,
    proxy_secret: proxySecret,
    service_name: data.service_name,
    status: data.status,
    latency: data.latency
  };

  try {
    const response = await fetch(`${gasUrl}?path=heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log(`[HUB REPORT] ${data.service_name}: ${data.status} | Latency: ${data.latency}ms | HUB: ${result.status}`);
  } catch (err) {
    console.error(`[HUB REPORT FAILED] ${data.service_name}: ${err.message}`);
  }
}
