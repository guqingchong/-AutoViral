/**
 * Phase 1 验收 live 驱动（2026-08-17）：
 * 创建交互式作品(videoSource=search → 首步 material-search 路由 kimi),
 * 经 WS 走 API loop,自动应答提问,观察:
 *   ① $web_search 真实调用 ② AskUserQuestion 闭环 ③ 阶段推进 ④ 事件序列
 * 用法: node scripts/live-acceptance-research.mjs [超时分钟]
 */
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:3271";
const TIMEOUT_MIN = Number(process.argv[2] ?? 15);
const MAX_REPLIES = 12;

const log = [];
function rec(type, data) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${type} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
  log.push(line);
  console.log(line.slice(0, 220));
}

// 1. 创建作品
const work = await fetch(`${BASE}/api/works`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "验收-LLM直连调研",
    type: "short-video",
    platforms: ["douyin"],
    videoSource: "search",
    videoSearchQuery: "2026年8月 专项债 化债 最新政策",
    topicHint: "2026年8月专项债与地方政府化债最新政策动向",
  }),
}).then((r) => r.json());
if (!work.id) { console.error("创建作品失败:", work); process.exit(1); }
rec("work_created", { id: work.id, pipeline: Object.keys(work.pipeline ?? {}) });

// 2. 经 session 端点启动(走 createSession → useApiDriver → API loop;
//    直接 WS send 会绕过 createSession 落入 CLI 路径——2026-08-17 踩中)
const start = await fetch(`${BASE}/api/works/${work.id}/session`, { method: "POST" }).then((r) => r.json());
rec("session_start", start);

// 3. WS 连接收事件流
const ws = new WebSocket(`ws://localhost:3271/ws/browser/${work.id}`);
const sawSearch = { called: false, gotRealInfo: false };
let turns = 0;
let replies = 0;
let done = false;

function sendChat(text) {
  // 走 HTTP chat 端点(session.loop 存在时免 resume 续跑)
  fetch(`${BASE}/api/works/${work.id}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then((r) => r.json()).then((d) => rec("chat_sent", d?.status ?? d)).catch((e) => rec("chat_err", e.message));
}

ws.on("open", () => rec("ws_open", work.id));

ws.on("message", async (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const { event, data } = msg;
  if (event === "tool_use") {
    rec("tool_use", data?.name);
    if (data?.name === "$web_search") sawSearch.called = true;
  } else if (event === "session_ready") {
    rec("session_ready", { driver: data?.driver, model: data?.model });
  } else if (event === "assistant_text" || event === "text") {
    const t = data?.text ?? "";
    if (sawSearch.called && /2026|热搜|近日|本周|月.{0,4}日/.test(t)) sawSearch.gotRealInfo = true;
  } else if (event === "turn_complete") {
    turns++;
    rec("turn_complete", { turns, idle: data?.idle, len: data?.result?.length });
    if (done) return;
    // 查 pipeline 状态:到 plan 阶段后再跑一个回合即收工
    try {
      const w = await fetch(`${BASE}/api/works/${work.id}`).then((r) => r.json());
      const active = Object.entries(w.pipeline ?? {}).find(([, s]) => s.status === "active")?.[0];
      const completed = Object.entries(w.pipeline ?? {}).filter(([, s]) => s.status === "completed").map(([k]) => k);
      rec("pipeline", { active, completed });
      if (completed.includes("research") || active === "plan") {
        rec("reached_plan", "调研阶段已完成,验收观察目标达成");
        done = true;
        ws.close();
        return;
      }
    } catch { /* 轮询失败不阻断 */ }
    if (replies >= MAX_REPLIES) { rec("give_up", "自动应答次数用尽"); done = true; ws.close(); return; }
    replies++;
    rec("auto_reply", `#${replies}`);
    setTimeout(() => sendChat("可以,按你的建议继续。"), 1500);
  } else if (event === "error" || event === "research_error") {
    rec("ERROR", data);
  }
});

ws.on("close", () => rec("ws_close", ""));
ws.on("error", (e) => rec("ws_error", e.message));

// 3. 超时收口
setTimeout(() => { rec("timeout", `${TIMEOUT_MIN}min`); done = true; ws.close(); }, TIMEOUT_MIN * 60_000);

process.on("exit", () => {
  writeFileSync(`scripts/live-acceptance-${work.id}.log`, log.join("\n"), "utf-8");
  console.log(`\n=== 结果: $web_search调用=${sawSearch.called} 真实信息=${sawSearch.gotRealInfo} 回合=${turns} 应答=${replies} ===`);
  console.log(`日志: scripts/live-acceptance-${work.id}.log`);
});
