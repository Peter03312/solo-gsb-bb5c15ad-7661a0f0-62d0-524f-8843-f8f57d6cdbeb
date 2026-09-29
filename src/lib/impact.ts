import type { Analysis } from '../../shared/model';

/**
 * 引用影响分析：基于当前确认后的解析图（analysis.edges 已应用歧义确认），
 * 沿「谁引用了它」的反向边做广度优先遍历，找出所有直接及间接引用目标条款的源条款。
 * 结果为纯计算产物，仅用于当前会话展示，不修改正文、不进入撤销历史。
 */

export interface ImpactEntry {
  articleId: string;
  /** 距目标条款的最短引用距离（1 = 直接引用目标） */
  distance: number;
  /** 该条款是否处于引用循环上（循环路径已在分析层检出） */
  inCycle: boolean;
}

export interface ImpactLayer {
  distance: number;
  entries: ImpactEntry[];
}

export interface ImpactReport {
  targetId: string;
  /** 按距离分层（距离从 1 开始），层内按文档顺序排列 */
  layers: ImpactLayer[];
  /** 受影响条款总数（不含目标本身） */
  total: number;
  /** 受影响条款中处于引用循环上的数量 */
  cycleCount: number;
  /** 目标条款自身是否处于引用循环中（存在回到目标的循环路径） */
  targetInCycle: boolean;
  /** 遍历中被去重的重复 / 循环路径条数（同一条款只按最短距离列出一次） */
  dedupedPaths: number;
}

/**
 * 计算目标条款的引用影响报告。
 * - 每个条款只出现一次，按最短距离分层（循环与汇聚路径自动去重）；
 * - 处于引用循环上的条款以 inCycle 标注；
 * - 条内自指边（绝对形式回指本条）不构成条款间影响路径，不参与遍历。
 */
export function computeImpact(analysis: Analysis, targetId: string): ImpactReport {
  // 反向邻接：targetArticleId -> 引用它的源条集合
  const inbound = new Map<string, Set<string>>();
  for (const e of analysis.edges) {
    if (e.sourceArticleId === e.targetArticleId) continue; // 条内自指不构成条款间影响
    let set = inbound.get(e.targetArticleId);
    if (!set) inbound.set(e.targetArticleId, (set = new Set()));
    set.add(e.sourceArticleId);
  }

  // 分析层已检出的循环（条级有向环），用于标注循环路径上的条款
  const cycleSet = new Set<string>();
  for (const issue of analysis.issues) {
    if (issue.type !== 'cycle') continue;
    for (const id of issue.cycleNodeIds ?? []) cycleSet.add(id);
  }

  const order = new Map(analysis.articles.map((a, i) => [a.id, i] as const));
  const dist = new Map<string, number>([[targetId, 0]]);
  const layers: ImpactLayer[] = [];
  let dedupedPaths = 0;
  let frontier = [targetId];
  let distance = 0;

  while (frontier.length > 0) {
    distance += 1;
    const reached: string[] = [];
    for (const id of frontier) {
      for (const src of inbound.get(id) ?? []) {
        if (dist.has(src)) {
          // 指向已访问条款的边：循环回指或汇聚重复路径，去重不计入
          dedupedPaths += 1;
          continue;
        }
        dist.set(src, distance);
        reached.push(src);
      }
    }
    if (reached.length === 0) break;
    reached.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    layers.push({
      distance,
      entries: reached.map((articleId) => ({
        articleId,
        distance,
        inCycle: cycleSet.has(articleId),
      })),
    });
    frontier = reached;
  }

  const total = layers.reduce((n, l) => n + l.entries.length, 0);
  const cycleCount = layers.reduce(
    (n, l) => n + l.entries.filter((e) => e.inCycle).length,
    0,
  );
  return {
    targetId,
    layers,
    total,
    cycleCount,
    targetInCycle: cycleSet.has(targetId),
    dedupedPaths,
  };
}
