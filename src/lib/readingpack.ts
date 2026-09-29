import type {
  Analysis,
  ClauseDocument,
  ClauseNode,
  NodePlacement,
  RefOccurrence,
} from '../../shared/model';
import { formatOrdinal } from './numeral';
import { confirmedEqual } from './sandbox';

/**
 * 引用阅读包：用户选定一条后，沿当前已确认的引用关系向目标方向（本条款引用了谁）
 * 逐层收集直接及间接依赖的条款。组合引用的每个已解析目标都参与收集；
 * 循环与多路径汇合只收录一次，最终按原文档顺序展示完整条款及其款、项，
 * 保留原编号与正文、不改写原文。
 *
 * 阅读包为纯计算的会话内产物：不修改正文、不进入撤销历史、不持久化；
 * 正文或歧义确认变化后旧阅读包立即标记失效，必须重新生成，禁止复制旧结果。
 */

/** 阅读包中的一条收录条款（文章粒度） */
export interface ReadingPackEntry {
  articleId: string;
  /** 最短引用距离：0 = 起点条款本身，1 = 直接依赖，其余为间接依赖 */
  distance: number;
  /** 该条款是否处于引用循环上 */
  inCycle: boolean;
}

/** 收录条款中的断链或歧义引用（避免摘录被误认为自足） */
export interface ReadingPackWarning {
  /** 稳定标识（来源节点 + 引用 key），用于列表 key 与去重 */
  id: string;
  kind: 'broken' | 'ambiguous';
  /** 引用所在节点 id（点击跳回正文） */
  sourceNodeId: string;
  /** 所属条 id（用于判断来源条是否仍在包内 / 已删除） */
  sourceArticleId: string;
  /** 生成时的来源定位文字，如「第五条第二款第（一）项」 */
  sourceLabel: string;
  /** 引用原文 */
  raw: string;
  /** 断链 / 歧义原因 */
  reason: string;
  /** 引用 key（当前正文仍可定位时据此跳转到源句） */
  refKey: string;
  /** 歧义候选的定位文字（未确认歧义，需用户裁定后重新生成） */
  candidateLabels?: string[];
  /** 组合引用中已解析目标的定位文字（部分缺失时仍可查） */
  resolvedLabels?: string[];
  /** 组合引用中缺失目标的原文与原因 */
  missingTargets?: { raw: string; reason: string }[];
}

export interface ReadingPack {
  /** 起点条款 id */
  sourceId: string;
  /** 生成时间 */
  createdAt: number;
  /** 生成时的文档标题快照（纯文本复制用，正文变化不影响失效判定） */
  docTitle: string;
  /** 生成时的正文版本号（仅正文内容变化时递增；批注 / 规则提交不递增） */
  docRevision: number;
  /** 生成时的文档 updatedAt（展示用） */
  docVersion: number;
  /** 生成时的歧义确认记录（确认变化使阅读包失效） */
  confirmed: Record<string, string>;
  /** 收录条款，按原文档顺序（含起点本身，distance=0） */
  entries: ReadingPackEntry[];
  /** 收录条款中的断链 / 歧义引用，按文档顺序（条、节点、偏移） */
  warnings: ReadingPackWarning[];
  /** 收录条款总数（含起点） */
  total: number;
  /** 最大引用距离（0 表示仅起点本身） */
  maxDistance: number;
  /** 遍历中被去重的循环回指 / 多路径汇合边数 */
  dedupedPaths: number;
}

function articleLabelOf(a: ClauseNode): string {
  return `第${formatOrdinal(a.ordinal)}条${a.suffix ? `之${a.suffix}` : ''}`;
}

/** 节点的人类可读定位（生成时刻的编号快照用于纯文本 / 展示） */
function placementLabel(p: NodePlacement): string {
  let s = articleLabelOf(p.article);
  if (p.paragraphIndex > 0) s += `第${formatOrdinal(p.paragraphIndex)}款`;
  if (p.itemIndex > 0) s += `第${formatOrdinal(p.itemIndex)}项`;
  return s;
}

/**
 * 从起点条款沿「引用目标」方向构建引用阅读包。
 *
 * - 边直接采用 analysis.edges（已应用歧义确认；组合引用的每个已解析目标各一条边）；
 * - 条内自指边（源条 === 目标条）不构成跨条款依赖，不参与遍历；
 * - BFS 按最短距离分层，循环回指与多路径汇合只计一次并计入 dedupedPaths；
 * - 结果（含起点）统一按原文档顺序排列。
 */
export function buildReadingPack(
  doc: ClauseDocument,
  analysis: Analysis,
  sourceId: string,
  docRevision: number,
  confirmed: Record<string, string>,
): ReadingPack | { error: string } {
  const source = doc.root.find((a) => a.id === sourceId);
  if (!source || source.kind !== 'article') return { error: '起点条款不存在，无法生成阅读包' };

  // 正向邻接：源条 -> 其引用到的目标条集合（同一条对只遍历一次）
  const outbound = new Map<string, Set<string>>();
  for (const e of analysis.edges) {
    if (e.sourceArticleId === e.targetArticleId) continue; // 条内自指不构成条款间依赖
    let set = outbound.get(e.sourceArticleId);
    if (!set) outbound.set(e.sourceArticleId, (set = new Set()));
    set.add(e.targetArticleId);
  }

  const order = new Map(analysis.articles.map((a, i) => [a.id, i] as const));
  const dist = new Map<string, number>([[sourceId, 0]]);
  let dedupedPaths = 0;
  let frontier = [sourceId];
  let distance = 0;

  while (frontier.length > 0) {
    distance += 1;
    const reached: string[] = [];
    for (const id of frontier) {
      for (const dst of outbound.get(id) ?? []) {
        if (dist.has(dst)) {
          // 循环回指或多路径汇合：只收录一次
          dedupedPaths += 1;
          continue;
        }
        dist.set(dst, distance);
        reached.push(dst);
      }
    }
    if (reached.length === 0) break;
    reached.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    frontier = reached;
  }

  // 循环节点集合（分析层已检出的条级有向环）
  const cycleSet = new Set<string>();
  for (const issue of analysis.issues) {
    if (issue.type !== 'cycle') continue;
    for (const id of issue.cycleNodeIds ?? []) cycleSet.add(id);
  }

  const includedIds = new Set(dist.keys());
  const entries: ReadingPackEntry[] = analysis.articles
    .filter((a) => includedIds.has(a.id))
    .map((a) => ({
      articleId: a.id,
      distance: dist.get(a.id)!,
      inCycle: cycleSet.has(a.id),
    }));

  // 收录条款中的断链 / 未确认歧义引用（按文档顺序：条序 -> 节点扫描序 -> 偏移）
  const warnings: ReadingPackWarning[] = [];
  const articleOrder = new Map(analysis.articles.map((a, i) => [a.id, i] as const));
  const includedOccurrences = analysis.occurrences
    .filter((o) => {
      const p = analysis.placement[o.nodeId];
      return p && includedIds.has(p.article.id);
    })
    .sort((a, b) => {
      const pa = analysis.placement[a.nodeId];
      const pb = analysis.placement[b.nodeId];
      const ai = articleOrder.get(pa.article.id) ?? 0;
      const bi = articleOrder.get(pb.article.id) ?? 0;
      if (ai !== bi) return ai - bi;
      // 同条内按出现顺序（同节点按偏移）
      if (a.nodeId === b.nodeId) return a.span.start - b.span.start;
      return pa.paragraphIndex - pb.paragraphIndex || pa.itemIndex - pb.itemIndex;
    });

  for (const occ of includedOccurrences) {
    const w = warningOf(occ, analysis);
    if (w) warnings.push(w);
  }

  const maxDistance = entries.reduce((m, e) => Math.max(m, e.distance), 0);

  return {
    sourceId,
    createdAt: Date.now(),
    docTitle: doc.title,
    docRevision,
    docVersion: doc.updatedAt,
    confirmed,
    entries,
    warnings,
    total: entries.length,
    maxDistance,
    dedupedPaths,
  };
}

/** 收录条款内的一次引用是否构成阅读包警告：断链，或尚未确认的歧义 */
function warningOf(occ: RefOccurrence, analysis: Analysis): ReadingPackWarning | null {
  const r = occ.resolution;
  const placement = analysis.placement[occ.nodeId];
  if (!placement) return null;
  const sourceLabel = placementLabel(placement);
  const base = {
    id: `rpw:${occ.key}`,
    sourceNodeId: occ.nodeId,
    sourceArticleId: placement.article.id,
    sourceLabel,
    raw: occ.span.raw,
    refKey: occ.key,
  };
  if (r.status === 'broken') {
    return {
      ...base,
      kind: 'broken',
      reason: r.reason ?? '目标不存在',
      ...(r.missingTargets?.length ? { missingTargets: r.missingTargets } : {}),
      ...(r.targetIds?.length
        ? {
            resolvedLabels: r.targetIds
              .map((id) => analysis.placement[id])
              .filter(Boolean)
              .map((p) => placementLabel(p)),
          }
        : {}),
    };
  }
  if (r.status === 'ambiguous') {
    // 已确认的歧义（resolution.ambiguity 保留但状态为 ok）不列入；它已按所确认目标参与收集
    return {
      ...base,
      kind: 'ambiguous',
      reason: r.reason ?? '存在多个候选目标，尚未确认',
      ...(r.candidates?.length
        ? {
            candidateLabels: r.candidates
              .map((id) => analysis.placement[id])
              .filter(Boolean)
              .map((p) => placementLabel(p)),
          }
        : {}),
    };
  }
  return null;
}

/** 失效判定：正文版本号变化（正文 / 结构编辑，含撤销重做）或歧义确认记录变化 */
export function isReadingPackStale(
  pack: ReadingPack,
  docRevision: number,
  confirmed: Record<string, string>,
): boolean {
  return pack.docRevision !== docRevision || !confirmedEqual(pack.confirmed, confirmed);
}

// ---------- 从条目跳回正文（始终按当前解析结果重定位，不复制旧偏移） ----------

export interface ReadingPackJump {
  nodeId: string;
  start: number;
  end: number;
  refKey?: string;
}

/** 警告行跳回正文：按引用 key 在当前分析中找回源句；来源节点已删除则不可跳转 */
export function readingPackWarningJump(
  warning: ReadingPackWarning,
  live: Analysis,
): ReadingPackJump | null {
  const occ = live.occurrences.find((o) => o.key === warning.refKey);
  const node = live.nodes[warning.sourceNodeId];
  if (occ && node) {
    const text = node.text;
    let s = occ.span.start;
    let e = occ.span.end;
    const boundaries = new Set(['。', '！', '？', '；', ';', '…', '\n']);
    while (s > 0 && !boundaries.has(text[s - 1])) s -= 1;
    while (e < text.length && !boundaries.has(text[e - 1])) e += 1;
    if (e < text.length) e += 1;
    return { nodeId: occ.nodeId, start: s, end: e, refKey: occ.key };
  }
  if (node) {
    return { nodeId: node.id, start: 0, end: Math.max(1, node.text.length) };
  }
  return null;
}

// ---------- 纯文本导出（保留原编号与正文，不改写原文；失效阅读包禁止复制） ----------

/** 条 / 款 / 项的结构编号（原文结构位置编号，非正文文字的一部分，用于呈现层级） */
function structuralHeading(node: ClauseNode, paragraphIndex: number, itemIndex: number): string {
  if (node.kind === 'article') {
    return articleLabelOf(node) + (node.title ? `【${node.title}】` : '');
  }
  if (node.kind === 'paragraph') return `第${formatOrdinal(paragraphIndex)}款`;
  return `（${formatOrdinal(itemIndex)}）`;
}

/**
 * 把阅读包渲染为可复制的纯文本：
 * 收录条款按原文档顺序完整列出（含款、项与原编号、正文，不改写原文），
 * 末尾另列断链 / 歧义引用，标明来源、原文与原因。
 */
export function renderReadingPackText(
  pack: ReadingPack,
  doc: ClauseDocument,
): string {
  const lines: string[] = [];
  const stamp = formatStamp(pack.createdAt);
  const source = doc.root.find((a) => a.id === pack.sourceId);
  const sourceLabel = source ? articleLabelOf(source) : '（起点条款已删除）';

  lines.push(`【引用阅读包】${pack.docTitle || '未命名条款集'}`);
  lines.push(`起点条款：${sourceLabel}`);
  lines.push(`生成时间：${stamp}（基于当时的正文与歧义确认记录）`);
  lines.push(
    `收录条款：${pack.total} 条（含起点；循环与多路径汇合只收录一次${
      pack.dedupedPaths > 0 ? `，已去重 ${pack.dedupedPaths} 条回指 / 汇合路径` : ''
    }）`,
  );
  lines.push(
    '说明：本阅读包为原文摘录，不是自足文件——末尾列有断链 / 歧义引用，引用前请核对原文档。',
  );
  lines.push('');

  const byId = new Map(doc.root.map((a) => [a.id, a]));
  pack.entries.forEach((entry, idx) => {
    const article = byId.get(entry.articleId);
    if (!article) {
      lines.push(`${idx + 1}. （收录条款已从当前文档删除）`);
      lines.push('');
      return;
    }
    const tag =
      entry.distance === 0
        ? '起点'
        : entry.distance === 1
          ? '直接依赖'
          : `间接依赖（第 ${entry.distance} 层）`;
    const cycleTag = entry.inCycle ? ' · ↻ 处于引用循环' : '';
    lines.push(`${idx + 1}. ${structuralHeading(article, 0, 0)}  ［${tag}${cycleTag}］`);
    if (article.text) lines.push(article.text);
    article.children.forEach((paragraph, pi) => {
      const pLabel = structuralHeading(paragraph, pi + 1, 0);
      lines.push(paragraph.text ? `${pLabel} ${paragraph.text}` : pLabel);
      paragraph.children.forEach((item, ii) => {
        const iLabel = structuralHeading(item, pi + 1, ii + 1);
        lines.push(`  ${item.text ? `${iLabel}${item.text}` : iLabel}`);
      });
    });
    lines.push('');
  });

  lines.push('————————————');
  if (pack.warnings.length === 0) {
    lines.push('收录条款中没有断链或未确认的歧义引用。');
  } else {
    lines.push(`断链 / 歧义引用（${pack.warnings.length} 处；摘录不完整，请回原文档核对）：`);
    lines.push('');
    pack.warnings.forEach((w, i) => {
      const kindLabel = w.kind === 'broken' ? '断链' : '歧义（未确认）';
      lines.push(`${i + 1}. [${kindLabel}] 来源：${w.sourceLabel}`);
      lines.push(`   原文：${w.raw}`);
      lines.push(`   原因：${w.reason}`);
      if (w.resolvedLabels?.length) {
        lines.push(`   已解析目标：${w.resolvedLabels.join('、')}`);
      }
      for (const m of w.missingTargets ?? []) {
        lines.push(`   缺失目标：${m.raw}（${m.reason}）`);
      }
      if (w.candidateLabels?.length) {
        lines.push(`   候选目标：${w.candidateLabels.join('、')}`);
      }
    });
  }

  return lines.join('\n');
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
