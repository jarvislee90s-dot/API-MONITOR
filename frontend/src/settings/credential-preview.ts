// 统一处理 credential 预览字符串的截断，避免长 URL/cookie 撑爆 Level 2 / Level 3 卡片。
// 最大展示长度 = 28；超过则取前 12 + 中间省略号 + 后 12。
const PREVIEW_MAX_LENGTH = 28;
const PREVIEW_HEAD_LENGTH = 12;
const PREVIEW_TAIL_LENGTH = 12;
const PREVIEW_ELLIPSIS = "…";

export function formatPreviewValue(value: string): string {
  if (value.length <= PREVIEW_MAX_LENGTH) return value;
  return `${value.slice(0, PREVIEW_HEAD_LENGTH)}${PREVIEW_ELLIPSIS}${value.slice(-PREVIEW_TAIL_LENGTH)}`;
}
