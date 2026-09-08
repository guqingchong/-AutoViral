/**
 * WebSearch / WebFetch / PlatformSearch 工具(2026-09-03)。
 * provider 无关的客户端联网能力,所有模型可用——不再只有 Kimi 能联网。
 * 后端实现见 services/web-search-service.ts。
 */

import type { ToolExecutor } from "./index.js";
import { webSearch, webFetch, platformSearch } from "../../services/web-search-service.js";

export const webSearchExecutor: ToolExecutor = {
  def: {
    name: "WebSearch",
    description:
      "联网搜索(Bing 国内版,客户端执行,任何模型可用)。返回标题/URL/摘要列表。" +
      "涉及时效话题、政策核查、数据查证时必用;每组查询词只搜 1 次,不相关时按" +
      "「去限定词 → 换同义词 → 换角度」改写。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询词,如「城市体检 政策」「数字孪生 案例」" },
        maxResults: { type: "number", description: "返回条数 1-10,默认 8" },
      },
      required: ["query"],
    },
  },
  async execute(input): Promise<string> {
    const query = String(input.query ?? "").trim();
    if (!query) throw new Error("WebSearch: query 必填");
    const results = await webSearch(query, Number(input.maxResults) || 8);
    if (!results.length) return `(「${query}」无搜索结果,请改写查询词:去限定词/换同义词/换角度)`;
    // X16 验收修复:tier 透传给模型(此前渲染时丢弃,agent 看不到信源等级)
    return results
      .map((r, i) => `${i + 1}. [${r.tier ?? "unverified"}] ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
};

export const webFetchExecutor: ToolExecutor = {
  def: {
    name: "WebFetch",
    description:
      "抓取指定 URL 的网页正文(自动去脚本/样式/导航,提取纯文本)。" +
      "用于核查 WebSearch 结果中的信源原文;政策文件、新闻报道须抓原文核对后才能引用。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的网页 URL" },
        maxChars: { type: "number", description: "正文最大字符数 500-20000,默认 6000" },
      },
      required: ["url"],
    },
  },
  async execute(input): Promise<string> {
    const url = String(input.url ?? "").trim();
    if (!/^https?:\/\//.test(url)) throw new Error("WebFetch: url 必须是 http(s) 链接");
    const text = await webFetch(url, Number(input.maxChars) || 6000);
    return text || "(页面无文本内容——可能是 JS 渲染页或需登录,换其他信源)";
  },
};

export const platformSearchExecutor: ToolExecutor = {
  def: {
    name: "PlatformSearch",
    description:
      "平台站内搜索。支持 bilibili(B站视频,免登录)、youtube、zhihu(知乎问答/文章,官方 API)、" +
      "douyin/xiaohongshu(复用发布登录态,有防风控限速)。" +
      "返回视频/问答/笔记链接清单,可用 WebFetch 抓页面看详情。查中文场景案例/竞品视频时优先 bilibili;查专业观点用 zhihu。",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", description: "bilibili / youtube / zhihu —— 其他平台(如 douyin/xiaohongshu)走 scraper 登录态,由服务层路由" },
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "返回条数 1-10,默认 5" },
      },
      required: ["platform", "query"],
    },
  },
  async execute(input): Promise<string> {
    const platform = String(input.platform ?? "").trim();
    const query = String(input.query ?? "").trim();
    if (!platform || !query) throw new Error("PlatformSearch: platform 和 query 必填");
    // 平台白名单校验放宽：zhihu 走 service 层（zhihuSearch），bilibili/youtube 走 yt-dlp，
    // 其余平台（douyin/xiaohongshu 等）由 service 层按需路由/报错——executor 不预判拒绝。
    const results = await platformSearch(platform, query, Number(input.limit) || 5);
    if (!results.length) return `(${platform} 搜索「${query}」无结果)`;
    return results
      .map((r, i) => `${i + 1}. ${r.title || r.url}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n");
  },
};
