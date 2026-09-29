import type { Analysis } from '../../shared/model';
import { formatOrdinal } from './numeral';

/** 生成节点的人类可读定位，如“第五条第二款第（一）项” */
export function labelOfNode(analysis: Analysis, nodeId: string): string {
  const p = analysis.placement[nodeId];
  if (!p) return '（已删除节点）';
  let s = `第${formatOrdinal(p.article.ordinal)}条`;
  if (p.article.suffix) s += `之${p.article.suffix}`;
  if (p.paragraphIndex > 0) s += `第${formatOrdinal(p.paragraphIndex)}款`;
  if (p.itemIndex > 0) s += `第${formatOrdinal(p.itemIndex)}项`;
  return s;
}

export function shortArticleLabel(ordinal: number, suffix?: string): string {
  return `第${formatOrdinal(ordinal)}条${suffix ? `之${suffix}` : ''}`;
}
