import type {
  Annotation,
  AnnotationCandidate,
  AnnotationReviewReason,
  ClauseDocument,
  ClauseNode,
} from '../../shared/model';
import { uid } from './uid';

/** 前后文锚点各截取的字符数 */
export const ANCHOR_CTX = 24;

function clipBefore(text: string, offset: number, len: number): string {
  return text.slice(Math.max(0, offset - len), offset);
}

function clipAfter(text: string, offset: number, len: number): string {
  return text.slice(offset, offset + len);
}

/** 由当前选区创建批注锚点（此时片段必然在 nodeId 中唯一定位） */
export function createAnnotation(
  nodeId: string,
  start: number,
  end: number,
  text: string,
  content: string,
  now = Date.now(),
): Annotation {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.max(s, Math.max(start, end));
  return {
    id: uid('ann'),
    nodeId,
    start: s,
    end: e,
    quote: text.slice(s, e),
    prefix: clipBefore(text, s, ANCHOR_CTX),
    suffix: clipAfter(text, e, ANCHOR_CTX),
    content,
    status: 'anchored',
    createdAt: now,
    updatedAt: now,
  };
}

function walk(nodes: ClauseNode[], fn: (n: ClauseNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

/** 找出 quote 在 text 中的全部出现位置（按原始字符偏移） */
export function findAll(text: string, quote: string): { start: number; end: number }[] {
  if (!quote) return [];
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    out.push({ start: i, end: i + quote.length });
    from = i + 1;
  }
  return out;
}

/** 宽松匹配用归一化：去除全部空白与常见标点，转小写 */
function normalize(s: string): string {
  return s.replace(/[\s　，。、；：！？“”‘’'"（）()【】《》〈〉·…—–-]/g, '').toLowerCase();
}

interface NormIndex {
  node: ClauseNode;
  norm: string;
  /** norm 中第 j 个字符 -> 原文偏移 */
  map: number[];
}

function buildIndex(doc: ClauseDocument): Map<string, NormIndex> {
  const idx = new Map<string, NormIndex>();
  walk(doc.root, (node) => {
    if (!node.text) return;
    const norm = normalize(node.text);
    // 归一化后第 j 个字符 -> 原文字符偏移
    const map: number[] = [];
    for (let i = 0; i < node.text.length; i++) {
      if (normalize(node.text[i]) !== '') map.push(i);
    }
    idx.set(node.id, { node, norm, map });
  });
  return idx;
}

/** 在归一化文本中查找归一化 quote 的全部出现，映射回原文偏移；
 *  区间两端会扩展以包含被剥离的标点/空白（如“第五条、第二款”）。 */
function findNormalized(
  entry: NormIndex,
  normQuote: string,
): { start: number; end: number }[] {
  if (!normQuote) return [];
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const i = entry.norm.indexOf(normQuote, from);
    if (i < 0) break;
    const rawStart = entry.map[i];
    const rawEnd = entry.map[Math.min(i + normQuote.length - 1, entry.map.length - 1)] + 1;
    // 向前扩展：紧邻的被剥离字符（如插入的标点），直到文本起点或前一个有效字符
    let s = rawStart;
    while (s > 0 && normalize(entry.node.text[s - 1]) === '') s--;
    // 向后扩展
    let e = rawEnd;
    while (e < entry.node.text.length && normalize(entry.node.text[e]) === '') e++;
    out.push({ start: s, end: e });
    from = i + 1;
  }
  return out;
}

/** 候选与前后文锚点的相似度：公共前缀长度 + 公共后缀长度 */
function scoreCandidate(
  node: ClauseNode,
  occ: { start: number; end: number },
  a: Annotation,
): number {
  const text = node.text;
  const before = clipBefore(text, occ.start, ANCHOR_CTX);
  const after = clipAfter(text, occ.end, ANCHOR_CTX);
  let score = 0;
  const maxI = Math.min(before.length, a.prefix.length);
  for (let i = 1; i <= maxI; i++) {
    if (before[before.length - i] === a.prefix[a.prefix.length - i]) score++;
    else break;
  }
  const maxJ = Math.min(after.length, a.suffix.length);
  for (let j = 0; j < maxJ; j++) {
    if (after[j] === a.suffix[j]) score++;
    else break;
  }
  return score;
}

function makeCandidates(
  index: Map<string, NormIndex>,
  occurrences: Map<string, { start: number; end: number }[]>,
  a: Annotation,
): AnnotationCandidate[] {
  const out: AnnotationCandidate[] = [];
  for (const [nodeId, occs] of occurrences) {
    const entry = index.get(nodeId);
    if (!entry) continue;
    for (const occ of occs) {
      out.push({ nodeId, start: occ.start, end: occ.end, score: scoreCandidate(entry.node, occ, a) });
    }
  }
  const old = a.start;
  // 评分降序；评分相同：优先原节点，其次靠近原偏移
  out.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const xo = x.nodeId === a.nodeId ? -1 : 1;
    const yo = y.nodeId === a.nodeId ? -1 : 1;
    if (xo !== yo) return xo - yo;
    return Math.abs(x.start - old) - Math.abs(y.start - old);
  });
  return out.slice(0, 8);
}

function anchoredAt(a: Annotation, nodeId: string, occ: { start: number; end: number }, text: string, now: number): Annotation {
  return {
    ...a,
    nodeId,
    start: occ.start,
    end: occ.end,
    prefix: clipBefore(text, occ.start, ANCHOR_CTX),
    suffix: clipAfter(text, occ.end, ANCHOR_CTX),
    status: 'anchored',
    reason: undefined,
    candidates: undefined,
    updatedAt: now,
  };
}

function review(
  a: Annotation,
  reason: AnnotationReviewReason,
  candidates: AnnotationCandidate[],
  now: number,
): Annotation {
  const best = candidates[0];
  return {
    ...a,
    status: 'review',
    reason,
    candidates,
    // 当前定位回落到评分最高的候选；无候选时保留旧值
    ...(best ? { nodeId: best.nodeId, start: best.start, end: best.end } : {}),
    updatedAt: now,
  };
}

/**
 * 单条批注重定位：
 * 1) 原节点精确匹配：唯一→锚定；多处→待复核；
 * 2) 原节点归一化匹配（忽略空白/标点差异）：唯一→锚定；
 * 3) 全文归一化匹配：唯一且不在原节点→锚定；多处→待复核；
 * 4) 均失败→待复核（missing / node-missing），保留候选。
 */
function relocateOne(a: Annotation, index: Map<string, NormIndex>, now: number): Annotation {
  const entry = index.get(a.nodeId);

  if (entry) {
    const exact = findAll(entry.node.text, a.quote);
    if (exact.length === 1) {
      const occ = exact[0];
      if (occ.start === a.start && a.status === 'anchored') return a;
      return anchoredAt(a, a.nodeId, occ, entry.node.text, now);
    }
    if (exact.length > 1) {
      // 片段多处出现：旧偏移仍命中也不能视为唯一定位，须人工复核
      return review(a, 'multi-in-node', makeCandidates(index, new Map([[a.nodeId, exact]]), a), now);
    }
    const norm = findNormalized(entry, normalize(a.quote));
    if (norm.length === 1) {
      return anchoredAt(a, a.nodeId, norm[0], entry.node.text, now);
    }
    if (norm.length > 1) {
      return review(a, 'multi-in-node', makeCandidates(index, new Map([[a.nodeId, norm]]), a), now);
    }
  }

  const normQuote = normalize(a.quote);
  const global = new Map<string, { start: number; end: number }[]>();
  for (const [nodeId, e] of index) {
    // 原节点已做过精确/归一化匹配，此处仅在其他节点中搜索迁移后的位置
    if (nodeId === a.nodeId) continue;
    const occs = findNormalized(e, normQuote);
    if (occs.length) global.set(nodeId, occs);
  }
  const total = [...global.values()].reduce((n, l) => n + l.length, 0);
  if (total === 1) {
    const [nodeId, occs] = [...global.entries()][0];
    const e = index.get(nodeId)!;
    return anchoredAt(a, nodeId, occs[0], e.node.text, now);
  }
  if (total > 1) {
    return review(a, 'multi-match', makeCandidates(index, global, a), now);
  }
  return review(a, entry ? 'missing' : 'node-missing', a.candidates ?? [], now);
}

export interface RelocateResult {
  annotations: Annotation[];
  /** 本次由锚定转为待复核（或复核原因变化）的批注意 id */
  reviewIds: string[];
}

/** 正文或结构调整后对全部批注尝试重定位 */
export function relocateAnnotations(
  annotations: Annotation[],
  doc: ClauseDocument,
  now = Date.now(),
): RelocateResult {
  const index = buildIndex(doc);
  const out: Annotation[] = [];
  const reviewIds: string[] = [];
  for (const a of annotations) {
    const next = relocateOne(a, index, now);
    if (next.status === 'review' && next.id !== undefined && (a.status !== 'review' || a.reason !== next.reason)) {
      reviewIds.push(next.id);
    }
    out.push(next);
  }
  return { annotations: out, reviewIds };
}

export const REVIEW_REASON_TEXT: Record<AnnotationReviewReason, string> = {
  'multi-in-node': '片段在原条款中出现多处',
  'multi-match': '片段在全文中存在多处匹配',
  missing: '片段在原条款中已缺失',
  'node-missing': '原条款节点已删除，且未找到相同片段',
};

/**
 * 规整外部数据（旧持久化 / 导入 JSON）中的批注列表。
 * 仅保留字段完整、引用片段非空的条目；非法状态按 anchored 加载，随后重定位校正。
 */
export function sanitizeAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  const out: Annotation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Partial<Annotation>;
    if (typeof a.nodeId !== 'string' || !a.nodeId) continue;
    if (typeof a.quote !== 'string' || !a.quote) continue;
    if (typeof a.content !== 'string') continue;
    out.push({
      id: typeof a.id === 'string' && a.id ? a.id : uid('ann'),
      nodeId: a.nodeId,
      start: Number.isFinite(a.start) ? Math.max(0, Math.floor(a.start as number)) : 0,
      end: Number.isFinite(a.end) ? Math.max(0, Math.floor(a.end as number)) : a.quote.length,
      quote: a.quote,
      prefix: typeof a.prefix === 'string' ? a.prefix : '',
      suffix: typeof a.suffix === 'string' ? a.suffix : '',
      content: a.content,
      status: a.status === 'review' ? 'review' : 'anchored',
      reason: a.reason,
      candidates: Array.isArray(a.candidates)
        ? a.candidates.filter(
            (c) =>
              c &&
              typeof c.nodeId === 'string' &&
              Number.isFinite(c.start) &&
              Number.isFinite(c.end),
          )
        : undefined,
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : now,
      updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : now,
    });
  }
  return out;
}
