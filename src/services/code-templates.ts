/**
 * 内置 code 模板种子注册(2026-08-24 kind="code" 集成)。
 *
 * code 模板不由 AI 生成(质量由代码渲染保证),服务启动时幂等写入:
 * 已存在则跳过(保留用户改名/停用等编辑),不存在才创建。
 *
 * 约定:layers[0] = { scene, params? } 场景配置;variables 声明 host_video
 * 后,渲染端点会强制要求传入数字人源片(api.ts /api/works/:id/render)。
 */
import { getTemplate, createTemplate } from "../db/templates-repo.js";

export const KEYNOTE_LEATHER_TEMPLATE_ID = "tpl_code_keynote_leather";

export function ensureBuiltinCodeTemplates(): void {
  if (getTemplate(KEYNOTE_LEATHER_TEMPLATE_ID)) return;
  createTemplate({
    id: KEYNOTE_LEATHER_TEMPLATE_ID,
    name: "Keynote 皮革·数字人口播(横屏)",
    content_form: "video",
    canvas: { width: 1920, height: 1080, fps: 30, backgroundColor: "#1c120d" },
    // host_video:数字人口播源片(渲染端点据此强制必填);
    // subtitleCn/subtitleEn/kicker:声明后 agent 可按作品覆盖模板默认文案
    variables: [
      { name: "host_video", type: "video", label: "数字人口播视频" },
      { name: "subtitleCn", type: "text", label: "中文主字幕(≤40字,可选)" },
      { name: "subtitleEn", type: "text", label: "英文副字幕(≤80字符,可选)" },
      { name: "kicker", type: "text", label: "顶部小标(可选)" },
    ],
    layers: [
      {
        scene: "keynote-leather",
        params: { kicker: "KEYNOTE" },
      },
    ],
    audio: [],
    transitions: [],
    status: "approved",
    kind: "code",
  });
}
