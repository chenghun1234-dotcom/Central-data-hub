/**
 * Central Data Hub (Single Source of Truth)
 * Multi-tenant SaaS Backend for RapidAPI
 * Operating Cost: 0 Won (Google Sheets + GAS)
 * Version: 1.1.0 - Production Hardened
 *
 * ✅ BUG FIXES v1.1:
 * - [BUG FIX] RapidAPI headers are not in e.parameter — they come via e.headers or proxy.
 *   추가 보안 키(PROXY_SECRET)를 GAS 프로젝트 속성(Script Properties)에서 읽어 검증합니다.
 * - [BUG FIX] handleDashboard()가 헤더 행(row[0] = "UserID")을 데이터로 포함하는 문제 수정 (slice(1) 추가)
 * - [BUG FIX] sendToWebhook의 Discord 메시지에 data.agent_id가 없을 때 TypeError 발생 방지
 * - [BUG FIX] getDataRange().getValues()가 빈 시트에서 호출될 때 항상 안전하도록 처리
 * - [IMPROVEMENT] 입력값 유효성 검사(Validation) 추가
 * - [IMPROVEMENT] GAS 할당량 절약을 위한 캐싱(CacheService) 적용
 * - [IMPROVEMENT] /delete-logs 엔드포인트 추가 (데이터 보존 기간 관리)
 */

// ─── 보안 설정 (Script Properties에 저장) ───────────────────────────────────
// GAS 에디터 > 프로젝트 설정 > 스크립트 속성에서 PROXY_SECRET 값을 설정하세요.
const PROXY_SECRET = PropertiesService.getScriptProperties().getProperty('PROXY_SECRET') || '';

// ─── 진입점 ─────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    // [HARDENING] Cloudflare Gateway에서 전달한 보안 키 검증
    const querySecret = e.parameter.proxy_secret;
    const body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const bodySecret = body.proxy_secret;

    if (PROXY_SECRET && (querySecret !== PROXY_SECRET && bodySecret !== PROXY_SECRET)) {
      return createResponse({ 
        error: "Unauthorized", 
        message: "This endpoint must be accessed via the authorized Cloudflare Gateway or provide a valid PROXY_SECRET." 
      }, 401);
    }

    // [MULTI-TENANT] Cloudflare Worker가 헤더에서 추출해 쿼리 파라미터로 넘겨준 user_id 우선 사용
    const userId = e.parameter.user_id || body.user_id || 'LOCAL_USER';
    const path = e.parameter.path || '';

    if (!path) return createResponse({ error: "Missing 'path' query parameter" }, 400);

    if (path === 'register-channel') return handleRegisterChannel(body, userId);
    if (path === 'report-task') return handleReportTask(body, userId);
    if (path === 'heartbeat') return handleHeartbeat(body, userId);
    if (path === 'delete-logs') return handleDeleteLogs(body, userId);

    return createResponse({ error: "Invalid endpoint: " + path }, 404);
  } catch (err) {
    return createResponse({ error: "Post Error: " + err.toString() }, 500);
  }
}

function doGet(e) {
  try {
    // [HARDENING] GET 요청도 보안 키 검증 (Dashboard 등 민감 정보 보호)
    const querySecret = e.parameter.proxy_secret;
    if (PROXY_SECRET && querySecret !== PROXY_SECRET) {
      return createResponse({ error: "Unauthorized: Missing or invalid proxy_secret" }, 401);
    }

    const userId = e.parameter.user_id || 'LOCAL_USER';
    const path = e.parameter.path || '';

    if (path === 'dashboard') return handleGetDashboard(userId, e.parameter);
    if (path === 'status' || path === 'ping') return createResponse({ status: "UP", version: "1.2.0", message: "Connect to Central Hub Success", timestamp: new Date().toISOString() });
    if (path === 'stats') return handleGetStats(userId);

    return createResponse({
      message: "Central Data Hub API v1.1.0 is online",
      endpoints: ["POST /register-channel", "POST /report-task", "POST /heartbeat", "GET /dashboard", "GET /stats", "GET /status"]
    }, 200);
  } catch (err) {
    return createResponse({ error: "Get Error: " + err.toString() }, 500);
  }
}

// ─── 핸들러 ─────────────────────────────────────────────────────────────────

/**
 * POST /register-channel
 * 사용자 채널(Discord/Slack) 및 에이전트 등록
 */
function handleRegisterChannel(data, userId) {
  // [IMPROVEMENT] 입력값 검증
  if (!data.channel_type || !data.webhook_url) {
    return createResponse({ error: "Missing required fields: channel_type, webhook_url" }, 400);
  }
  if (!['discord', 'slack', 'telegram'].includes(data.channel_type)) {
    return createResponse({ error: "Invalid channel_type. Use: discord, slack, telegram" }, 400);
  }

  const sheet = getOrCreateSheet("Users");
  const rows = sheet.getDataRange().getValues();
  let userRowIndex = -1;

  // 헤더 행(i=0)을 건너뛰고 검색 — [BUG FIX는 이미 i=1부터 시작하므로 OK]
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) { userRowIndex = i + 1; break; }
  }

  const now = new Date().toISOString();
  if (userRowIndex === -1) {
    sheet.appendRow([userId, data.channel_type, data.webhook_url, data.agent_name || 'Unnamed', now, now]);
  } else {
    sheet.getRange(userRowIndex, 2, 1, 4).setValues([[data.channel_type, data.webhook_url, data.agent_name || 'Unnamed', now]]);
  }

  // 캐시 무효화
  CacheService.getScriptCache().remove('users_' + userId);

  return createResponse({ status: "SUCCESS", message: "Channel registered", user_id: userId });
}

/**
 * POST /heartbeat
 * 서비스 상태 보고 (Cloudflare Workers 등 모니터링 에이전트용)
 */
function handleHeartbeat(data, userId) {
  if (!data.service_name || !data.status) {
    return createResponse({ error: "Missing required fields: service_name, status" }, 400);
  }

  const sheet = getOrCreateSheet("Heartbeats");
  sheet.appendRow([userId, data.service_name, data.status, data.latency || 0, new Date().toISOString()]);

  // 장애 시 즉각 알림
  if (data.status !== "HEALTHY") {
    const userConfig = getUserConfig(userId);
    if (userConfig && userConfig.webhook_url) {
      sendToWebhook(userConfig.webhook_url, userConfig.channel_type, {
        agent_id: "SYSTEM_MONITOR",
        status: "CRITICAL",
        message: `🚨 서비스 장애 감지!\n서비스: ${data.service_name}\n상태: ${data.status}\n응답시간: ${data.latency || 'N/A'}ms`
      });
    }
  }

  return createResponse({ status: "ACK", received: new Date().toISOString() });
}

/**
 * POST /report-task
 * 에이전트 업무 결과 보고 및 메신저 전송
 */
function handleReportTask(data, userId) {
  // [IMPROVEMENT] 입력값 검증
  if (!data.agent_id || !data.status) {
    return createResponse({ error: "Missing required fields: agent_id, status" }, 400);
  }

  const logSheet = getOrCreateSheet("ActivityLogs");
  logSheet.appendRow([userId, data.agent_id, data.status, data.message || '', new Date().toISOString()]);

  const userConfig = getUserConfig(userId);
  if (userConfig && userConfig.webhook_url) {
    // [BUG FIX] data 객체를 직접 전달하면 Discord 메시지의 data.agent_id가 null일 수 있었음
    sendToWebhook(userConfig.webhook_url, userConfig.channel_type, {
      agent_id: data.agent_id,
      status: data.status,
      message: data.message || '(메시지 없음)'
    });
  }

  return createResponse({ status: "SUCCESS", message: "Task reported", agent_id: data.agent_id });
}

/**
 * GET /dashboard
 * 활동 로그 조회 (페이지네이션 지원)
 */
function handleGetDashboard(userId, params) {
  const sheet = getOrCreateSheet("ActivityLogs");
  const rows = sheet.getDataRange().getValues();

  // [BUG FIX] 헤더 행 제거 (slice(1)) — 기존엔 헤더가 데이터로 포함될 수 있었음
  const allRows = rows.slice(1);
  const userRows = allRows
    .filter(row => row[0] === userId)
    .map(row => ({
      agent_id: row[1],
      status: row[2],
      message: row[3],
      timestamp: row[4]
    }))
    .reverse();

  // 페이지네이션
  const limit = parseInt(params && params.limit) || 50;
  const offset = parseInt(params && params.offset) || 0;
  const paginated = userRows.slice(offset, offset + limit);

  return createResponse({
    userId: userId,
    total: userRows.length,
    limit: limit,
    offset: offset,
    tasks: paginated
  });
}

/**
 * GET /stats
 * 사용자별 성능 지수(Performance Index) 계산
 */
function handleGetStats(userId) {
  const sheet = getOrCreateSheet("ActivityLogs");
  const rows = sheet.getDataRange().getValues().slice(1); // 헤더 제거
  const userRows = rows.filter(row => row[0] === userId);

  if (userRows.length === 0) {
    return createResponse({ userId: userId, stats: null, message: "No data yet" });
  }

  const total = userRows.length;
  const success = userRows.filter(r => r[2] === 'SUCCESS').length;
  const errors = userRows.filter(r => r[2] === 'ERROR' || r[2] === 'CRITICAL').length;
  const successRate = ((success / total) * 100).toFixed(1);

  return createResponse({
    userId: userId,
    stats: {
      total_tasks: total,
      success: success,
      errors: errors,
      success_rate_percent: parseFloat(successRate),
      performance_grade: successRate >= 95 ? 'A' : successRate >= 80 ? 'B' : 'C'
    }
  });
}

/**
 * POST /delete-logs
 * 보관 기간 초과 데이터 삭제 (Freemium 차별화)
 */
function handleDeleteLogs(data, userId) {
  const daysToKeep = parseInt(data.days_to_keep) || 30;
  const sheet = getOrCreateSheet("ActivityLogs");
  const rows = sheet.getDataRange().getValues();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);

  let deleted = 0;
  // 역순으로 삭제 (행 번호 오류 방지)
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === userId && new Date(rows[i][4]) < cutoff) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }

  return createResponse({ status: "SUCCESS", deleted_rows: deleted, days_kept: daysToKeep });
}

// ─── 유틸리티 함수 ───────────────────────────────────────────────────────────

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Spreadsheet not found or script not bound to spreadsheet.");

  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(name);
      if (name === "Users") {
        sheet.appendRow(["UserID", "ChannelType", "WebhookURL", "AgentName", "CreatedAt", "UpdatedAt"]);
      } else if (name === "ActivityLogs") {
        sheet.appendRow(["UserID", "AgentID", "Status", "Message", "Timestamp"]);
      } else if (name === "Heartbeats") {
        sheet.appendRow(["UserID", "ServiceName", "Status", "Latency", "Timestamp"]);
      }
    } catch (err) {
      console.error("Failed to create sheet " + name + ": " + err.toString());
      // 만약 동시 요청으로 이미 생성되었다면 다시 시도
      sheet = ss.getSheetByName(name);
      if (!sheet) throw err;
    }
  }
  return sheet;
}

/**
 * 사용자 설정 조회 (캐싱 적용으로 GAS 할당량 절약)
 */
function getUserConfig(userId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'users_' + userId;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sheet = getOrCreateSheet("Users");
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) {
      const config = { channel_type: rows[i][1], webhook_url: rows[i][2], agent_name: rows[i][3] };
      cache.put(cacheKey, JSON.stringify(config), 300); // 5분 캐시
      return config;
    }
  }
  return null;
}

/**
 * [BUG FIX] Discord 임베드(Embed) 형식으로 개선, agent_id null 방어 처리
 */
function sendToWebhook(url, type, data) {
  let payload = {};
  const agentId = data.agent_id || 'Unknown Agent';
  const status = data.status || 'UNKNOWN';
  const message = data.message || '';
  const emoji = status === 'SUCCESS' ? '✅' : status === 'CRITICAL' ? '🚨' : '⚠️';

  if (type === "discord") {
    payload = {
      embeds: [{
        title: `${emoji} Agent Report: ${agentId}`,
        description: message,
        color: status === 'SUCCESS' ? 0x00ff88 : status === 'CRITICAL' ? 0xff0000 : 0xffaa00,
        fields: [{ name: "Status", value: status, inline: true }],
        timestamp: new Date().toISOString()
      }]
    };
  } else if (type === "slack") {
    payload = {
      text: `${emoji} *Agent Report: ${agentId}*`,
      attachments: [{
        color: status === 'SUCCESS' ? 'good' : 'danger',
        fields: [
          { title: "Status", value: status, short: true },
          { title: "Details", value: message, short: false }
        ]
      }]
    };
  } else {
    // Generic / Telegram bot webhook
    payload = { text: `${emoji} [${agentId}] ${status}: ${message}` };
  }

  try {
    const options = { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true };
    UrlFetchApp.fetch(url, options);
  } catch (err) {
    // 웹훅 실패를 로그에만 기록하고 전체 요청은 성공으로 처리
    console.error("Webhook delivery failed: " + err.toString());
  }
}

function createResponse(data, code = 200) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: 일일 자동 리포트 (GAS Time-based Trigger로 매일 오전 9시 실행)
// 설정 방법: GAS 에디터 > 트리거 > "sendDailyReport" 함수를 매일 오전 9시로 설정
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 모든 등록 사용자에게 전날의 에이전트 활동 요약을 자동으로 전송합니다.
 * GAS Time-based Trigger > "sendDailyReport" > 매일 오전 8-9시 실행으로 등록하세요.
 */
function sendDailyReport() {
  const usersSheet = getOrCreateSheet("Users");
  const logsSheet = getOrCreateSheet("ActivityLogs");
  const heartbeatSheet = getOrCreateSheet("Heartbeats");

  const userRows = usersSheet.getDataRange().getValues().slice(1); // 헤더 제거
  const logRows = logsSheet.getDataRange().getValues().slice(1);
  const hbRows = heartbeatSheet.getDataRange().getValues().slice(1);

  // 어제 날짜 범위 계산
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  userRows.forEach(userRow => {
    const userId = userRow[0];
    const channelType = userRow[1];
    const webhookUrl = userRow[2];
    if (!webhookUrl) return;

    // 어제 이 사용자의 로그 필터링
    const userLogs = logRows.filter(r => {
      if (r[0] !== userId) return false;
      const ts = new Date(r[4]);
      return ts >= yesterday && ts < today;
    });

    const userHb = hbRows.filter(r => {
      if (r[0] !== userId) return false;
      const ts = new Date(r[4]);
      return ts >= yesterday && ts < today;
    });

    const total = userLogs.length;
    if (total === 0 && userHb.length === 0) return; // 활동 없으면 전송 안 함

    const success = userLogs.filter(r => r[2] === 'SUCCESS').length;
    const errors = userLogs.filter(r => r[2] === 'ERROR' || r[2] === 'CRITICAL').length;
    const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : 0;
    const grade = successRate >= 95 ? 'A 🏆' : successRate >= 80 ? 'B ✅' : successRate >= 60 ? 'C ⚠️' : 'D 🚨';

    const downServices = userHb.filter(r => r[2] !== 'HEALTHY').map(r => r[1]);
    const avgLatency = userHb.length > 0
      ? (userHb.reduce((acc, r) => acc + (Number(r[3]) || 0), 0) / userHb.length).toFixed(0)
      : 'N/A';

    const dateStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}`;

    // 채널별 포맷
    if (channelType === 'discord') {
      const payload = {
        embeds: [{
          title: `📊 일일 에이전트 리포트 — ${dateStr}`,
          color: successRate >= 80 ? 0x00d26a : 0xff4444,
          fields: [
            { name: '📋 총 업무', value: `${total}건`, inline: true },
            { name: '✅ 성공', value: `${success}건`, inline: true },
            { name: '❌ 실패', value: `${errors}건`, inline: true },
            { name: '📈 성공률', value: `${successRate}%`, inline: true },
            { name: '🏅 성능 등급', value: grade, inline: true },
            { name: '⚡ 평균 응답시간', value: `${avgLatency}ms`, inline: true },
            ...(downServices.length > 0 ? [{ name: '🚨 장애 서비스', value: downServices.join(', '), inline: false }] : [])
          ],
          footer: { text: 'Central Data Hub | Zero-Cost SSOT' },
          timestamp: new Date().toISOString()
        }]
      };
      sendToWebhook(webhookUrl, 'discord', { agent_id: 'DAILY_REPORT' });
      // 직접 임베드 전송
      UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } else {
      // Slack / Generic
      sendToWebhook(webhookUrl, channelType, {
        agent_id: 'DAILY_REPORT',
        status: successRate >= 80 ? 'SUCCESS' : 'WARNING',
        message: `📊 일일 리포트 (${dateStr})\n총 업무: ${total}건 | 성공: ${success} | 실패: ${errors}\n성공률: ${successRate}% | 등급: ${grade}\n평균 응답: ${avgLatency}ms${downServices.length > 0 ? '\n🚨 장애: ' + downServices.join(', ') : ''}`
      });
    }
  });
}

/**
 * [유지보수] GAS 트리거를 프로그래밍 방식으로 생성합니다.
 * 이 함수를 GAS 에디터에서 한 번만 수동으로 실행하세요 (Run > setupTrigger).
 * 이후 매일 자동으로 sendDailyReport()가 실행됩니다.
 */
function setupDailyTrigger() {
  // 기존 트리거 삭제 (중복 방지)
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendDailyReport') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 매일 오전 8~9시 사이에 실행
  ScriptApp.newTrigger('sendDailyReport')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  console.log('✅ Daily report trigger set: runs every day at 8-9 AM.');
}

/**
 * [유지보수] 30일 이상 된 모든 사용자의 로그를 자동으로 정리합니다.
 * 매주 월요일 새벽에 실행하도록 트리거 등록을 권장합니다.
 */
function autoCleanupOldLogs() {
  const usersSheet = getOrCreateSheet("Users");
  const userRows = usersSheet.getDataRange().getValues().slice(1);
  const logsSheet = getOrCreateSheet("ActivityLogs");
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30); // 30일 보관

  const rows = logsSheet.getDataRange().getValues();
  let deleted = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (new Date(rows[i][4]) < cutoff) {
      logsSheet.deleteRow(i + 1);
      deleted++;
    }
  }
  console.log(`🧹 Auto cleanup: deleted ${deleted} rows older than 30 days.`);
}

