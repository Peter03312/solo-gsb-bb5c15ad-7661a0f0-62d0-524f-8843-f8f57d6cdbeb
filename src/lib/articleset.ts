import type { NumStyle } from '../../shared/model';
import { formatOrdinal } from './numeral';

/** 条级目标集合中的一个目标（渲染时按文档顺序排列） */
export interface ArticleSetMember {
  id: string;
  ordinal: number;
  /** 条序号后缀原文，如“一”；无后缀为空串 */
  suffix: string;
  style: NumStyle;
}

export interface ArticleOrdinalInfo {
  id: string;
  ordinal: number;
}

/**
 * 目标集合能否精确表示为闭区间“第X条至第Y条”：
 * 序号去重后连续，且区间内不再落入集合之外的条（含“之一”后缀条），
 * 保证区间展开后的目标集合与原集合完全一致。
 */
export function canRenderAsRange(
  members: ArticleSetMember[],
  allArticles: ArticleOrdinalInfo[],
): boolean {
  if (members.length < 2) return false;
  const ords = [...new Set(members.map((m) => m.ordinal))].sort((a, b) => a - b);
  for (let i = 1; i < ords.length; i++) {
    if (ords[i] !== ords[i - 1] + 1) return false;
  }
  const ids = new Set(members.map((m) => m.id));
  const lo = ords[0];
  const hi = ords[ords.length - 1];
  return allArticles.every((a) => a.ordinal < lo || a.ordinal > hi || ids.has(a.id));
}

/**
 * 渲染条级目标集合（members 须按文档顺序排列）：
 * 目标仍连续时输出闭区间“第X条至第Y条”，否则展开为顿号列表；
 * 数字风格沿用各成员原风格，rangeEndStyle 可单独指定区间终点风格。
 */
export function renderArticleSet(
  members: ArticleSetMember[],
  allArticles: ArticleOrdinalInfo[],
  rangeEndStyle?: NumStyle,
): string {
  if (members.length === 0) return '';
  if (canRenderAsRange(members, allArticles)) {
    let lo = members[0];
    let hi = members[0];
    for (const m of members) {
      if (m.ordinal < lo.ordinal) lo = m;
      if (m.ordinal > hi.ordinal) hi = m;
    }
    return (
      `第${formatOrdinal(lo.ordinal, lo.style)}条` +
      `至第${formatOrdinal(hi.ordinal, rangeEndStyle ?? hi.style)}条`
    );
  }
  return members
    .map((m) => `第${formatOrdinal(m.ordinal, m.style)}条${m.suffix ? `之${m.suffix}` : ''}`)
    .join('、');
}
