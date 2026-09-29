import type { ClauseDocument, ClauseNode, TermHit, TermRule } from '../../shared/model';
import { uid } from './uid';

/** 命中上下文预览在正文两侧各截取的字符数 */
export const TERM_CTX = 12;

/** 一条规则经预处理后实际参与扫描的变体（去空白、去重，并剔除与规范词相同者） */
export interface EffectiveRule {
  rule: TermRule;
  index: number;
  canonical: string;
  variants: string[];
}

/** 创建新规则（variants 调用方可稍后补充） */
export function createTermRule(canonical = '', variants: string[] = [], now = Date.now()): TermRule {
  return {
    id: uid('trm'),
    canonical: canonical.trim(),
    variants: variants.map((v) => v.trim()).filter(Boolean),
    createdAt: now,
  };
}

/** 计算规则实际生效的变体：trim 后去重；与规范词完全相同或为空的变体不参与扫描 */
export function effectiveVariants(rule: TermRule): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rule.variants) {
    const v = raw.trim();
    if (!v || v === rule.canonical.trim() || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function walk(nodes: ClauseNode[], fn: (n: ClauseNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

interface Candidate {
  ruleIndex: number;
  ruleId: string;
  canonical: string;
  variant: string;
  nodeId: string;
  start: number;
  end: number;
}

/** 找出 text 中 variant 的全部出现（重叠起点也保留，如 'aaa' 中两次 'aa'） */
function findAll(text: string, variant: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (!variant) return out;
  let from = 0;
  for (;;) {
    const i = text.indexOf(variant, from);
    if (i < 0) break;
    out.push({ start: i, end: i + variant.length });
    from = i + 1;
  }
  return out;
}

/**
 * 扫描全文，返回经重叠消解后的命中列表。
 *
 * 重叠消解优先级（对所有候选全局排序后贪心跳过交叠者）：
 *   1) 起点靠前；
 *   2) 同一起点变体更长；
 *   3) 同长时规则顺序靠前。
 * 由此得到的命中两两互不交叠（可相邻），且同一起点仅保留最优候选。
 */
export function scanTerms(doc: ClauseDocument, rules: TermRule[]): TermHit[] {
  const effective: EffectiveRule[] = rules
    .map((rule, index) => ({
      rule,
      index,
      canonical: rule.canonical.trim(),
      variants: effectiveVariants(rule),
    }))
    // 规范词为空的规则视为尚未填写完整：不扫描、不参与替换（避免替换成空串误删正文）
    .filter((er) => er.canonical !== '');

  const candidates: Candidate[] = [];
  const nodeTextMap = new Map<string, string>();
  walk(doc.root, (node) => {
    if (!node.text) return;
    nodeTextMap.set(node.id, node.text);
    for (const er of effective) {
      for (const variant of er.variants) {
        for (const occ of findAll(node.text, variant)) {
          candidates.push({
            ruleIndex: er.index,
            ruleId: er.rule.id,
            canonical: er.canonical,
            variant,
            nodeId: node.id,
            start: occ.start,
            end: occ.end,
          });
        }
      }
    }
  });

  // 跨节点需保证“条款顺序在前的节点整体优先”：先按文档遍历序（节点首次出现次序），
  // 节点内再按起点/变体长度/规则顺序排序。
  const nodeOrder = new Map<string, number>();
  walk(doc.root, (n) => {
    nodeOrder.set(n.id, nodeOrder.size);
  });
  candidates.sort((a, b) => {
    const ao = nodeOrder.get(a.nodeId) ?? 0;
    const bo = nodeOrder.get(b.nodeId) ?? 0;
    if (ao !== bo) return ao - bo;
    if (a.start !== b.start) return a.start - b.start;
    if (b.end - a.end !== 0) return b.end - a.end;
    return a.ruleIndex - b.ruleIndex;
  });

  // 贪心：仅保留与已选命中不交叠的候选
  const lastByNode = new Map<string, Candidate>();
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    const last = lastByNode.get(c.nodeId);
    // 候选按起点升序排列：与最近接受的命中重叠即跳过（更长/更早规则的已占先）
    if (last && c.start < last.end) continue;
    accepted.push(c);
    lastByNode.set(c.nodeId, c);
  }

  return accepted.map((c) => ({
    key: hitKey(c.nodeId, c.start, c.end, c.ruleId),
    ruleId: c.ruleId,
    ruleIndex: c.ruleIndex,
    canonical: c.canonical,
    variant: c.variant,
    nodeId: c.nodeId,
    start: c.start,
    end: c.end,
    nodeText: nodeTextMap.get(c.nodeId) ?? '',
  }));
}

export function hitKey(nodeId: string, start: number, end: number, ruleId: string): string {
  return `term:${nodeId}:${start}:${end}:${ruleId}`;
}

/** 命中所在节点与上下文（用于侧栏预览） */
export function hitContext(
  nodes: Record<string, ClauseNode>,
  hit: { nodeId: string; start: number; end: number },
): { before: string; match: string; after: string } | null {
  const node = nodes[hit.nodeId];
  if (!node) return null;
  return {
    before: node.text.slice(Math.max(0, hit.start - TERM_CTX), hit.start),
    match: node.text.slice(hit.start, hit.end),
    after: node.text.slice(hit.end, hit.end + TERM_CTX),
  };
}

export interface TermReplaceResult {
  /** 实际替换的命中数 */
  replaced: number;
  /** 因节点 ID 或原文区间已变化而拒绝（整批未动）时，失效的命中数 */
  stale: number;
  doc: ClauseDocument;
}

/**
 * 命中是否仍是当前正文中同一节点、同一原文区间：
 * 节点存在、扫描快照时的节点全文与当前一致，且该区间原文仍等于变体。
 * 节点全文比较可覆盖区间整体平移（如前文插入）等仅比区间文本无法察觉的变化。
 */
export function isHitCurrent(node: ClauseNode | undefined, hit: TermHit): boolean {
  if (!node) return false;
  if (node.text !== hit.nodeText) return false;
  if (hit.start < 0 || hit.end <= hit.start || hit.end > node.text.length) return false;
  return node.text.slice(hit.start, hit.end) === hit.variant;
}

/**
 * 按扫描快照中已勾选的命中执行批量替换：
 * 1) 先逐项核对节点 ID 与原文区间（该位置原文必须仍等于变体）；任一项变化则整批拒绝；
 * 2) 全部有效时按节点分组、组内从后向前单遍替换，因此替换生成的规范词不会被递归处理；
 * 3) 结果作为一次文档提交，支持整体撤销/重做。
 */
export function replaceTermHits(
  doc: ClauseDocument,
  hits: TermHit[],
): TermReplaceResult | { replaced: 0; stale: number; doc: ClauseDocument } {
  if (hits.length === 0) return { replaced: 0, stale: 0, doc };

  const nodes = new Map<string, ClauseNode>();
  walk(doc.root, (n) => nodes.set(n.id, n));

  let stale = 0;
  for (const hit of hits) {
    if (!isHitCurrent(nodes.get(hit.nodeId), hit)) stale++;
  }
  if (stale > 0) return { replaced: 0, stale, doc };

  // 按节点分组，每组从后向前替换（偏移不会互相干扰）
  const byNode = new Map<string, TermHit[]>();
  for (const hit of hits) {
    const list = byNode.get(hit.nodeId);
    if (list) list.push(hit);
    else byNode.set(hit.nodeId, [hit]);
  }
  let replaced = 0;
  for (const [nodeId, list] of byNode) {
    const node = nodes.get(nodeId)!;
    const sorted = [...list].sort((a, b) => b.start - a.start);
    let text = node.text;
    for (const hit of sorted) {
      // 二次防御：单遍自后向前，区间上方已校验
      text = text.slice(0, hit.start) + hit.canonical + text.slice(hit.end);
      replaced++;
    }
    node.text = text;
  }
  return { replaced, stale: 0, doc };
}

/**
 * 规整外部数据（旧持久化 / 导入 JSON）中的规范用语规则。
 * 规范词与变体均非空才保留；变体去空白、去重。旧数据缺少 termRules 时按空规则加载。
 */
export function sanitizeTermRules(value: unknown): TermRule[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  const out: TermRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<TermRule>;
    if (typeof r.canonical !== 'string' || !r.canonical.trim()) continue;
    const seen = new Set<string>();
    const variants: string[] = [];
    for (const v of Array.isArray(r.variants) ? r.variants : []) {
      if (typeof v !== 'string') continue;
      const t = v.trim();
      if (!t || t === r.canonical.trim() || seen.has(t)) continue;
      seen.add(t);
      variants.push(t);
    }
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : uid('trm'),
      canonical: r.canonical.trim(),
      variants,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    });
  }
  return out;
}
