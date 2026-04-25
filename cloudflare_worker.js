/**
 * Central Data Hub — All-in-One Integrated Worker
 * 이 워커는 정적 페이지(UI) 서비스와 API 게이트웨이 역할을 동시에 수행합니다.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParam = url.searchParams.get("path");

    // 1. API 요청 처리 (Gateway Mode)
    // 쿼리에 path가 있거나 POST 요청인 경우
    if (pathParam || request.method === "POST") {
      const GAS_URL = env.GAS_URL;
      if (!GAS_URL) return new Response("GAS_URL 환경변수가 설정되지 않았습니다.", { status: 500 });
      
      const targetUrl = new URL(GAS_URL);
      const userId = request.headers.get("X-RapidAPI-User") || "LOCAL_USER";
      const proxySecret = request.headers.get("X-RapidAPI-Proxy-Secret") || env.PROXY_SECRET;

      // 파라미터 복사
      url.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));
      targetUrl.searchParams.set("user_id", userId);
      if (proxySecret) targetUrl.searchParams.set("proxy_secret", proxySecret);

      const forwardHeaders = new Headers();
      forwardHeaders.set("Content-Type", "application/json");

      let body = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        try { body = await request.text(); } catch(e) {}
      }

      try {
        const response = await fetch(targetUrl.toString(), {
          method: request.method,
          headers: forwardHeaders,
          body: body,
          redirect: "follow"
        });
        
        // CORS 헤더 추가 (브라우저 테스트용)
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Gateway Error", details: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 2. UI 서비스 (Embedded Landing Page)
    // 메인 주소 접속 시 HTML을 직접 반환합니다.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(getHTMLContent(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

function getHTMLContent() {
  return `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Central Data Hub | Premium SSOT</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;700;800&display=swap" rel="stylesheet">
    <style>
        :root { --primary: #00f2fe; --bg: #050505; --glass: rgba(255,255,255,0.03); --glass-border: rgba(255,255,255,0.1); }
        body { background: var(--bg); color: #fff; font-family: 'Outfit', sans-serif; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; overflow: hidden; }
        .glass-card { background: var(--glass); backdrop-filter: blur(20px); border: 1px solid var(--glass-border); padding: 3rem; border-radius: 30px; text-align: center; max-width: 600px; box-shadow: 0 25px 50px rgba(0,0,0,0.5); }
        h1 { font-size: 3.5rem; margin: 0; background: linear-gradient(to right, #00f2fe, #4facfe); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { color: rgba(255,255,255,0.6); line-height: 1.6; font-size: 1.1rem; }
        .status-badge { display: inline-block; padding: 6px 15px; background: rgba(0,242,254,0.1); color: var(--primary); border-radius: 20px; font-size: 0.8rem; font-weight: 700; margin-bottom: 1.5rem; border: 1px solid rgba(0,242,254,0.3); }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 2rem; }
        .mini-card { background: rgba(255,255,255,0.02); padding: 1.5rem; border-radius: 20px; border: 1px solid var(--glass-border); text-align: left; }
        .mini-card h3 { margin: 0 0 0.5rem 0; font-size: 1rem; color: var(--primary); }
        .mini-card p { font-size: 0.85rem; margin: 0; }
    </style>
</head>
<body>
    <div class="glass-card">
        <div class="status-badge">SYSTEM OPERATIONAL</div>
        <h1>Central Data Hub</h1>
        <p>Enterprise-grade Multi-tenant SaaS Gateway.<br>Operating cost: $0.00 / mo</p>
        
        <div class="grid">
            <div class="mini-card">
                <h3>SSOT Registry</h3>
                <p>중앙 집중식 데이터 관리 및 에이전트 오케스트레이션.</p>
            </div>
            <div class="mini-card">
                <h3>Edge Gateway</h3>
                <p>Cloudflare Workers 기반의 고성능 트래픽 포워딩.</p>
            </div>
        </div>
        <p style="margin-top: 2rem; font-size: 0.8rem; opacity: 0.4;">© 2024 Central Data Hub. Powered by Google Apps Script.</p>
    </div>
</body>
</html>
  `;
}
