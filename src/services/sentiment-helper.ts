/**
 * Regex-based sentiment classifier for Chinese comments.
 *
 * Classifies comments into: positive, negative, neutral, question.
 * Uses regex rules (not LLM) for speed and cost efficiency.
 * Handles 10k+ comments per batch without API calls.
 */

import type { DbCommentSentiment } from "../db/types.js";

const POSITIVE_PATTERNS = [
  /[👍🌟💯🔥❤️😍🥰]/u,
  /太棒了|很好|不错|厉害|牛逼|优秀|支持|加油|期待|喜欢|赞|好看|精彩|收藏|学到了|干货|有用|牛|绝了|爱了|yyds|YYDS|太强了|宝藏|关注了/iu,
  /(?<![不没])错/iu,
];

const NEGATIVE_PATTERNS = [
  /[👎💩🤮😡🤬]/u,
  /垃圾|差评|不好|失望|无聊|骗人|举报|抄袭|举报了|取关|拉黑|什么鬼|太差|浪费时间|真垃圾|恶心|吐了|辣鸡/iu,
];

const QUESTION_PATTERNS = [
  /\?|？/,
  /怎么|如何|为什么|能不能|可以吗|行不行|有没有|会不会|请问|求教|哪位|谁知道|啥时候|什么时候|多少/iu,
];

export function classifySentiment(text: string): DbCommentSentiment {
  if (!text?.trim()) return "neutral";

  // Check questions first — they're actionable
  for (const re of QUESTION_PATTERNS) {
    if (re.test(text)) return "question";
  }

  // Then negative (alerts)
  for (const re of NEGATIVE_PATTERNS) {
    if (re.test(text)) return "negative";
  }

  // Then positive
  for (const re of POSITIVE_PATTERNS) {
    if (re.test(text)) return "positive";
  }

  return "neutral";
}

/**
 * Classify a batch of comments. Returns counts per sentiment.
 */
export function classifyBatch(
  comments: Array<{ content: string }>
): Array<{ content: string; sentiment: DbCommentSentiment }> {
  const counts = { positive: 0, negative: 0, neutral: 0, question: 0 };
  const results = comments.map((c) => {
    const sentiment = classifySentiment(c.content);
    counts[sentiment]++;
    return { content: c.content, sentiment };
  });

  // Log batch summary
  if (comments.length > 0) {
    console.log(
      `[sentiment] batch=${comments.length} pos=${counts.positive} neg=${counts.negative} neut=${counts.neutral} q=${counts.question}`
    );
  }

  return results;
}
