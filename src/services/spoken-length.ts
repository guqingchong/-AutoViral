/**
 * 口播"朗读字符"口径 v1(2026-09-10 定稿)——时长估算的统一事实源。
 *
 * 背景:旧口径"4.5 字/秒"只数汉字,阿拉伯数字按 1 字计——而 TTS 朗读时
 * 数字要逐位展开(41518 读作 5 个音节、14.7% 读作"百分之十四点七"7 个音节),
 * 导致时长估算系统性偏乐观(2026-09-10 w_20260910_1758_479 第 2 轮评审实测暴露)。
 *
 * 口径规则(与 skills/trend-research、skills/content-planning 文档同步,改动必须三方一致):
 * - 汉字:每字 = 1
 * - 数字:逐位展开,每位 = 1;小数点 = 1(读"点");全角数字同
 * - 百分号 %/％:= 3(读"百分之")
 * - 拉丁字母:每个 = 1(REITs=5,AI=2)
 * - 标点、空白、markdown 记号:不计
 * - 〔…〕/【…】画面角标内容:整体剔除(不朗读)
 */

/** 全角数字 → 半角 */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 剔除画面角标〔…〕/【…】(支持嵌套失败时按最近闭合处理,宁可多剔不少剔) */
export function stripVisualMarkers(text: string): string {
  return text.replace(/〔[^〕]*〕/g, " ").replace(/【[^】]*】/g, " ");
}

/** 计算一段口播文本的朗读字符数 */
export function spokenLength(text: string): number {
  const t = toHalfWidth(stripVisualMarkers(text));
  let n = 0;
  for (const ch of t) {
    if (/[一-鿿㐀-䶿]/.test(ch)) n += 1; // 汉字(CJK 统一表意文字 + 扩展A)
    else if (/[0-9]/.test(ch)) n += 1;   // 数字逐位
    else if (ch === ".") n += 1;          // 小数点读"点"(句读标点已在下方排除——句号的"。"不在此列)
    else if (ch === "%" || ch === "％") n += 3; // 读"百分之"
    else if (/[a-zA-Z]/.test(ch)) n += 1; // 拉丁字母逐个
    // 其余(标点/空白/符号)不计
  }
  return n;
}

/** 估算朗读秒数(默认 4.5 朗读字符/秒,与 speechBudget.charsPerSec 口径一致) */
export function estimateSpeechSeconds(text: string, charsPerSec = 4.5): number {
  return spokenLength(text) / charsPerSec;
}

/** 文章常规字数(研究文章 wordCount 的实测口径,区别于口播朗读口径):
 *  汉字逐字计;连续的拉丁字母串/数字串各计 1 个词(如 "REITs"=1、"41518"=1);
 *  标点、空白、markdown 记号不计。与大众"字数"直觉一致。 */
export function articleWordCount(text: string): number {
  const t = toHalfWidth(stripVisualMarkers(text))
    .replace(/https?:\/\/\S+/g, " ")
    // 结构锚点标记(锚点 sec-N)不是文章文字,剔除(指令规定的 sections 锚点标注格式)
    .replace(/[（(]\s*锚点\s*[\w-]+\s*[）)]/g, " ");
  let n = 0;
  for (const ch of t) {
    if (/[一-鿿㐀-䶿]/.test(ch)) n += 1;
  }
  const latinRuns = t.match(/[a-zA-Z0-9]+(?:\.[0-9]+)?/g);
  if (latinRuns) n += latinRuns.length;
  return n;
}

/** 从 article.md 全文中提取"口播正文"用于朗读口径实测:
 *  剔除代码块、引用行(>)、标题行(#)、信源清单小节、URL。
 *  划分依据是成稿约定(标题/元信息/信源清单均不朗读,正文段落才进 TTS)。 */
export function extractSpokenBody(articleMd: string): string {
  const lines = articleMd.replace(/```[\s\S]*?```/g, "\n").split("\n");
  const out: string[] = [];
  let skipSection = false;
  for (const line of lines) {
    const s = line.trim();
    const heading = /^(#{1,3})\s+(.*)$/.exec(s);
    if (heading) {
      // 信源清单/来源附录类小节整体剔除(到下一个同级或更高级标题为止——简化为遇任何标题即恢复)
      skipSection = /信源|来源清单|参考文献|附录/.test(heading[2]);
      continue; // 标题本身不朗读
    }
    if (skipSection) continue;
    if (!s || s.startsWith(">")) continue; // 元信息引用块不朗读
    out.push(s.replace(/https?:\/\/\S+/g, " "));
  }
  return out.join("\n");
}
