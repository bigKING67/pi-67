const CONTINUATION_COMMAND_PATTERN =
  /^\s*(?:(?:继续|接着)(?:上一轮|上一步|优化|完善|打磨|处理|修复|调整|检查|推进|实现|开发|改进|排查|测试|验证|收口|迭代)(?:一下|下去|呀|吧)?|(?:继续(?:呀|吧)?|接着(?:来|吧)?|下一步|然后呢|再来|往下|go on|continue|next|proceed)(?=\s|$|[，。,.!！?？]))/i;

const RETRY_CONTINUATION_PATTERN =
  /(?:再试(?:一下|下)?|重试|重新试(?:一下|下)?|try\s+again|retry)/i;

const NEGATIVE_RETRY_CONTINUATION_PATTERN =
  /(?:不要|不用|无需|别|禁止|do\s+not|don't|dont|without|no).{0,16}(?:再试|重试|重新试|try\s+again|retry)/i;

export function isContinuationPrompt(value: string): boolean {
  const text = String(value || "").trim();
  if (CONTINUATION_COMMAND_PATTERN.test(text)) return true;
  if (NEGATIVE_RETRY_CONTINUATION_PATTERN.test(text)) return false;
  return text.length <= 160 && RETRY_CONTINUATION_PATTERN.test(text);
}
