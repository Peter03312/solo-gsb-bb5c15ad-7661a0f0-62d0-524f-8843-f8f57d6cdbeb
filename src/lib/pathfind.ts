import type { Analysis, ArticleEdge, ClauseNode, RefKind, RefOccurrence } from '../../shared/model';
import { locateSentence } from './analyzer';
import { formatOrdinal } from './numeral';

/**
 * 引用路径核对：用户选定起点条与终点条后，基于「当前已确认的条级引用边」
 * （analysis.edges，已应用歧义确认）在条级有向图上寻找一条跳数最少的有向路径。
 *
 * - 组合引用（articleList / articleRange）的每个已解析目标在分析层各是一条边，
 *   各自独立参与寻路；
 * - 同一条对存在多处引用时，按「正文顺序」（条序 → 款/项位置 → 节点内偏移）
 *   选最先出现、且当前正文仍可展示的一处作为证据；
 * - BFS 以已访问条集合收敛，循环回指不会导致重复搜索；
 * - 条级邻接与引用证据索引以分析快照为单位构建并复用（见 getPathIndex）：
 *   每处引用只索引一次，切换起点 / 终点反复查询时不重建索引、不逐边扫描全部引用；
 * - 结果为随当前分析即时重算的纯计算产物：正文或歧义确认变化（含撤销 / 重做）后
 *   store 产生新的分析对象，索引按新快照重建，不缓存旧偏移、不展示旧证据。
 */

/** 路径上一跳的可展示证据 */
export interface PathHop {
  /** 该跳边的来源条 id */
  sourceArticleId: string;
  /** 该跳边的目标条 id（下一跳的来源条；末跳即终点条） */
  targetArticleId: string;
  /** 产生该引用的来源节点 id（条头 / 款 / 项），点击定位正文用 */
  sourceNodeId: string;
  /** 引用解析到的具体目标节点 id（可能精确到款 / 项） */
  targetNodeId: string;
  /** 引用类型（组合引用时标明，供界面加注） */
  kind: RefKind;
  /** 引用 key（当前分析中的稳定 key，供正文高亮联动） */
  refKey: string;
  /** 引用原文，如「第三条、第五条」 */
  refRaw: string;
  /** 来源句在来源节点正文中的区间（按当前正文实时计算，非缓存偏移） */
  sentenceStart: number;
  sentenceEnd: number;
  /** 来源句原文（按当前正文截取） */
  sentenceText: string;
  /** 引用原文在来源句中的相对位置（用于句内加粗展示） */
  refInSentenceStart: number;
  refInSentenceEnd: number;
  /** 该引用是否为组合引用（条级组合 / 闭区间） */
  combined: boolean;
}

/** 起点 === 终点时的零跳结果 */
export interface SameArticleResult {
  kind: 'same';
  sourceId: string;
  targetId: string;
  hops: [];
}

/** 找到的一条最短有向路径 */
export interface ReferencePath {
  kind: 'path';
  sourceId: string;
  targetId: string;
  /** 路径跳数（边数；最短跳数） */
  hopsCount: number;
  hops: PathHop[];
  /** BFS 中遇到的循环回指 / 已访问汇合边数（不会导致重复搜索，仅作统计） */
  dedupedEdges: number;
}

/** 起点、终点间不存在有向路径 */
export interface NoPathResult {
  kind: 'no-path';
  sourceId: string;
  targetId: string;
  hops: [];
  /** BFS 从起点可达但未能到达终点的条数量 */
  reachedCount: number;
  dedupedEdges: number;
}

/** 起点或终点条款在当前文档中不存在（已删除） */
export interface MissingEndpointResult {
  kind: 'missing-endpoint';
  sourceId: string;
  targetId: string;
  hops: [];
  missing: 'source' | 'target';
}

export type PathCheckResult =
  | SameArticleResult
  | ReferencePath
  | NoPathResult
  | MissingEndpointResult;

/** 条的人类可读编号，如「第五条之一」 */
export function articleLabelOf(a: ClauseNode): string {
  return `第${formatOrdinal(a.ordinal)}条${a.suffix ? `之${a.suffix}` : ''}`;
}

/** 候选边的正文顺序键：条序 → 款位置 → 项位置 → 节点内字符偏移 */
function edgeOrderKey(
  e: ArticleEdge,
  analysis: Analysis,
  occByKey: Map<string, RefOccurrence>,
): string {
  const occ = occByKey.get(e.refKey);
  const p = analysis.placement[e.sourceNodeId];
  const ai = p ? p.articleIndex : Number.MAX_SAFE_INTEGER;
  const pi = p ? p.paragraphIndex : Number.MAX_SAFE_INTEGER;
  const ii = p ? p.itemIndex : Number.MAX_SAFE_INTEGER;
  const off = occ ? occ.span.start : Number.MAX_SAFE_INTEGER;
  // 定宽分段拼接，保证字典序即正文顺序
  return `${String(ai).padStart(6, '0')}:${String(pi).padStart(4, '0')}:${String(ii).padStart(
    4,
    '0',
  )}:${String(off).padStart(6, '0')}`;
}

/**
 * 条级路径索引：以一份分析快照为单位构建，供该快照下的多次路径查询复用。
 * 只持有派生自该快照的结构，不缓存任何跨快照状态。
 */
export interface PathIndex {
  /**
   * 正向邻接：来源条 -> 按目标条文档顺序排列的 { 目标条, 边 }。
   * 同一条对的多处引用已收敛为正文顺序最靠前的一条边；条内自指边已剔除。
   */
  adj: Map<string, { to: string; edge: ArticleEdge }[]>;
  /** 引用 key -> 引用出现（证据句定位用；每处引用只索引一次） */
  occByKey: Map<string, RefOccurrence>;
}

/**
 * 索引缓存：以分析对象身份为键。store 在正文 / 结构 / 歧义确认变化
 * （含撤销 / 重做）后总是产生新的 Analysis 对象，因此缓存只对当前快照命中；
 * 旧快照的索引随对象回收，不会被后续查询误用。
 */
const indexCache = new WeakMap<Analysis, PathIndex>();

/**
 * 建立（或复用）当前分析快照的条级邻接与引用证据索引。
 * 同一份分析下切换起点 / 终点反复查询时复用已建索引，只重跑 BFS，不重建图。
 */
export function getPathIndex(analysis: Analysis): PathIndex {
  let index = indexCache.get(analysis);
  if (!index) {
    index = buildPathIndex(analysis);
    indexCache.set(analysis, index);
  }
  return index;
}

/**
 * 单遍构建索引：
 * - 每处引用只索引一次（refKey -> occurrence），条对收敛与证据定位均为 O(1) 查表，
 *   不再为比较每条边反复扫描全部引用；
 * - 每条边只参与一次条对比较，同一条对保留正文顺序最靠前的一处；
 * - 邻接表按目标条文档顺序预排序，BFS 同层展开顺序确定可复现。
 */
function buildPathIndex(analysis: Analysis): PathIndex {
  // 每处引用只索引一次：key -> occurrence
  const occByKey = new Map<string, RefOccurrence>();
  for (const occ of analysis.occurrences) occByKey.set(occ.key, occ);

  // 条对 -> 正文顺序最靠前的候选边（同一来源条到同一目标条的多处引用取最先出现者）
  const bestEdge = new Map<string, { edge: ArticleEdge; orderKey: string }>();
  for (const e of analysis.edges) {
    if (e.sourceArticleId === e.targetArticleId) continue; // 条内自指不构成条款间路径
    const k = `${e.sourceArticleId}>${e.targetArticleId}`;
    const orderKey = edgeOrderKey(e, analysis, occByKey);
    const cur = bestEdge.get(k);
    if (!cur || orderKey < cur.orderKey) bestEdge.set(k, { edge: e, orderKey });
  }

  // 正向邻接：来源条 -> 按目标条文档顺序排列的 { 目标条, 边 }
  const order = new Map(analysis.articles.map((a, i) => [a.id, i] as const));
  const adj = new Map<string, { to: string; edge: ArticleEdge }[]>();
  for (const { edge } of bestEdge.values()) {
    const list = adj.get(edge.sourceArticleId) ?? [];
    list.push({ to: edge.targetArticleId, edge });
    adj.set(edge.sourceArticleId, list);
  }
  for (const list of adj.values()) {
    list.sort((a, b) => (order.get(a.to) ?? 0) - (order.get(b.to) ?? 0));
  }

  return { adj, occByKey };
}

/**
 * 在当前条级引用图上寻找 sourceId → targetId 的一条最短有向路径。
 *
 * 邻接与证据索引复用 getPathIndex(analysis)：同一条对的多处引用只保留正文顺序
 * 最靠前的一处作为证据；组合引用的各已解析目标是不同条对（或同条对的不同边，
 * 取最先出现者）；条内自指边（源条 === 目标条）不构成条款间路径，不参与遍历。
 * BFS 的同层邻接按目标条文档顺序展开，使最短路径在等长情形下确定可复现。
 * 每次调用仅做端点检查与 BFS，不重建索引；证据句与句内区间按传入的当前分析
 * 实时截取，不读取旧快照。
 */
export function findReferencePath(
  analysis: Analysis,
  sourceId: string,
  targetId: string,
): PathCheckResult {
  if (!analysis.nodes[sourceId] || !analysis.placement[sourceId]?.article) {
    return { kind: 'missing-endpoint', sourceId, targetId, hops: [], missing: 'source' };
  }
  if (!analysis.nodes[targetId] || !analysis.placement[targetId]?.article) {
    return { kind: 'missing-endpoint', sourceId, targetId, hops: [], missing: 'target' };
  }

  if (sourceId === targetId) {
    return { kind: 'same', sourceId, targetId, hops: [] };
  }

  // 复用当前快照的条级邻接与引用证据索引：切换起点 / 终点不重建，仅做 BFS
  const index = getPathIndex(analysis);

  // BFS：记录父指针以重建一条最短路径；visited 收敛保证循环不重复搜索
  const parent = new Map<string, { from: string; edge: ArticleEdge }>();
  const visited = new Set<string>([sourceId]);
  let dedupedEdges = 0;
  const queue: string[] = [sourceId];
  let head = 0;
  let found = false;

  while (head < queue.length) {
    const cur = queue[head++];
    for (const { to, edge } of index.adj.get(cur) ?? []) {
      if (visited.has(to)) {
        // 循环回指或更短距离已到达：不重复搜索
        dedupedEdges += 1;
        continue;
      }
      visited.add(to);
      parent.set(to, { from: cur, edge });
      if (to === targetId) {
        found = true;
        break;
      }
      queue.push(to);
    }
    if (found) break;
  }

  if (!found) {
    return {
      kind: 'no-path',
      sourceId,
      targetId,
      hops: [],
      reachedCount: visited.size - 1,
      dedupedEdges,
    };
  }

  // 自终点沿父指针回溯，再反转为起点 → 终点
  const edges: ArticleEdge[] = [];
  let cur = targetId;
  while (cur !== sourceId) {
    const p = parent.get(cur)!;
    edges.push(p.edge);
    cur = p.from;
  }
  edges.reverse();

  const hops: PathHop[] = edges.map((e) => {
    const occ = index.occByKey.get(e.refKey)!;
    const node = analysis.nodes[e.sourceNodeId];
    const text = node?.text ?? '';
    const span = occ.span;
    const sentence = locateSentence(text, span.start, span.end);
    return {
      sourceArticleId: e.sourceArticleId,
      targetArticleId: e.targetArticleId,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      kind: e.kind,
      refKey: e.refKey,
      refRaw: span.raw,
      sentenceStart: sentence.start,
      sentenceEnd: sentence.end,
      sentenceText: text.slice(sentence.start, sentence.end),
      refInSentenceStart: span.start - sentence.start,
      refInSentenceEnd: span.end - sentence.start,
      combined: e.kind === 'articleList' || e.kind === 'articleRange',
    };
  });

  return {
    kind: 'path',
    sourceId,
    targetId,
    hopsCount: hops.length,
    hops,
    dedupedEdges,
  };
}
