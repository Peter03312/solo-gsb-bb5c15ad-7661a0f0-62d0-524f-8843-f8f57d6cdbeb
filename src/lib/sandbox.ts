import type {
  Analysis,
  ClauseDocument,
  ClauseNode,
  Issue,
  RefOccurrence,
} from '../../shared/model';
import { analyze, locateSentence } from './analyzer';
import { applyStructuralChange, type RewriteChange, type RewriteResult } from './rewriter';
import { shortArticleLabel } from './labels';
import { formatOrdinal } from './numeral';
import { uid } from './uid';

/**
 * 修订沙盒：条级删除 / 移位 / 换号的预演。
 * 预演在文档克隆上复用 applyStructuralChange（原子引用改写）与 analyze（问题检测），
 * 不改动正文、不写入撤销历史；预演记录生成时的正文版本号与歧义确认记录，
 * 正文或确认记录变化后预演失效并禁止应用，未失效时可作为一步提交（整体撤销 / 重做）。
 */

/** 条级预演操作：删除 / 移位（移动到第 toIndex+1 位）/ 换号（改为第 newOrdinal 条） */
export type SandboxOp =
  | { kind: 'delete'; articleId: string }
  | { kind: 'move'; articleId: string; toIndex: number }
  | { kind: 'renumber'; articleId: string; newOrdinal: number };

/** 预演结果（会话内临时数据，不持久化、不进入撤销历史） */
export interface SandboxPreview {
  id: string;
  op: SandboxOp;
  /** 操作的人类可读描述（按生成时的条款编号） */
  label: string;
  createdAt: number;
  /** 生成时的正文版本号（store 单调递增；正文变化后预演失效） */
  docRevision: number;
  /** 生成时的文档 updatedAt（展示用） */
  docVersion: number;
  /** 生成时的歧义确认记录（确认变化会使改写计划失真，预演同样失效） */
  confirmed: Record<string, string>;
  /** 将被改写的引用（按文档顺序；区间基于当前正文偏移，可点击定位） */
  changes: RewriteChange[];
  /** 将保持原文、不自动改写的引用（断链 / 歧义 / 目标被删） */
  skipped: RewriteResult['skipped'];
  /** 将新增的断链 / 循环问题（按稳定问题身份对齐得出） */
  issuesAdded: Issue[];
  /** 将消失的断链 / 循环问题 */
  issuesRemoved: Issue[];
  rewrittenCount: number;
  /** 预演在克隆上得到的调整后文档；应用时整体作为一步提交 */
  resultDoc: ClauseDocument;
}

/** 与正文编辑入口完全一致的条级结构变更（删除 / 移位 / 换号） */
export function sandboxMutator(op: SandboxOp): (root: ClauseNode[]) => void {
  switch (op.kind) {
    case 'delete':
      return (root) => {
        const idx = root.findIndex((a) => a.id === op.articleId);
        if (idx >= 0) root.splice(idx, 1);
      };
    case 'move':
      return (root) => {
        const idx = root.findIndex((a) => a.id === op.articleId);
        if (idx < 0) return;
        const [node] = root.splice(idx, 1);
        const clamped = Math.max(0, Math.min(op.toIndex, root.length));
        root.splice(clamped, 0, node);
      };
    case 'renumber':
      return (root) => {
        if (!Number.isInteger(op.newOrdinal) || op.newOrdinal < 1) return;
        const idx = root.findIndex((a) => a.id === op.articleId);
        if (idx < 0) return;
        const target = root[op.newOrdinal - 1];
        if (!target || target.id === op.articleId) return;
        const [node] = root.splice(idx, 1);
        root.splice(op.newOrdinal - 1, 0, node);
      };
  }
}

/** 操作描述（按当前文档编号渲染） */
export function describeSandboxOp(op: SandboxOp, analysis: Analysis): string {
  const article = analysis.nodes[op.articleId];
  const label = article
    ? shortArticleLabel(article.ordinal, article.suffix)
    : '（未知条款）';
  switch (op.kind) {
    case 'delete':
      return `删除${label}`;
    case 'move':
      return `将${label}移至第 ${op.toIndex + 1} 位`;
    case 'renumber':
      return `将${label}改为第${formatOrdinal(op.newOrdinal)}条`;
  }
}

/**
 * 在当前文档的克隆上预演一次条级操作：
 * 1. 复用 applyStructuralChange 计算结构变更与原子引用改写；
 * 2. 复用 analyze 对预演文档重新检测问题；
 * 3. 按稳定问题身份（类型 + 源节点 ID + 引用原文 + 同文序次；循环为排序节点 ID 集合）
 *    对齐当前与预演的检测结果，得出将新增 / 将消失的断链与循环问题。
 * 全程不修改传入的 doc / analysis。
 */
export function buildSandboxPreview(
  doc: ClauseDocument,
  analysis: Analysis,
  confirmed: Record<string, string>,
  op: SandboxOp,
  docRevision: number,
): SandboxPreview | { error: string } {
  const article = analysis.nodes[op.articleId];
  if (!article || article.kind !== 'article') return { error: '目标条款不存在，无法预演' };
  if (op.kind === 'move' && (!Number.isInteger(op.toIndex) || op.toIndex < 0)) {
    return { error: '移位目标位置无效' };
  }
  if (
    op.kind === 'renumber' &&
    (!Number.isInteger(op.newOrdinal) || op.newOrdinal < 1 || op.newOrdinal > doc.root.length)
  ) {
    return { error: `换号只接受 1 ～ ${doc.root.length} 的条号` };
  }

  const label = describeSandboxOp(op, analysis);
  const result = applyStructuralChange(doc, analysis, sandboxMutator(op));

  // 无实际结构变化（如移动到原位 / 换号为自身）时不生成预演
  const beforeOrder = doc.root.map((a) => a.id).join('|');
  const afterOrder = result.doc.root.map((a) => a.id).join('|');
  if (beforeOrder === afterOrder) return { error: '该操作不产生任何结构变化，无需预演' };

  const previewAnalysis = analyze(result.doc, { confirmed });

  // 源节点随操作被删除的引用不列入“不自动改写”（其文本已随节点消失）
  const skipped = result.skipped.filter((s) => previewAnalysis.nodes[s.nodeId]);

  // 只对比断链与循环问题（稳定身份对齐，字符偏移变化不制造差异）
  const isWatched = (i: Issue) => i.type === 'broken' || i.type === 'cycle';
  const currentByIdentity = new Map(
    analysis.issues.filter(isWatched).map((i) => [i.identity, i] as const),
  );
  const previewByIdentity = new Map(
    previewAnalysis.issues.filter(isWatched).map((i) => [i.identity, i] as const),
  );
  const issuesAdded = previewAnalysis.issues.filter(
    (i) => isWatched(i) && !currentByIdentity.has(i.identity),
  );
  const issuesRemoved = analysis.issues.filter(
    (i) => isWatched(i) && !previewByIdentity.has(i.identity),
  );

  return {
    id: uid('sbx'),
    op,
    label,
    createdAt: Date.now(),
    docRevision,
    docVersion: doc.updatedAt,
    confirmed,
    changes: result.changes,
    skipped,
    issuesAdded,
    issuesRemoved,
    rewrittenCount: result.rewritten,
    resultDoc: result.doc,
  };
}

// ---------- 失效判定与点击定位 ----------

/** 歧义确认记录内容比较（store 每次提交都会重建对象，需按内容而非引用判断变化） */
export function confirmedEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

// 以下定位辅助始终按当前正文重定位，预演生成后的偏移变化不影响跳转

export interface SandboxJump {
  nodeId: string;
  start: number;
  end: number;
  refKey?: string;
}

/** 将被改写的引用定位到当前正文：优先按引用 key 找回当前出现，失败则退到整个节点 */
export function sandboxRewriteJump(change: RewriteChange, live: Analysis): SandboxJump | null {
  const occ = live.occurrences.find((o) => o.key === change.refKey);
  if (occ && live.nodes[occ.nodeId]) {
    const sentence = locateSentence(live.nodes[occ.nodeId].text, occ.span.start, occ.span.end);
    return { nodeId: occ.nodeId, start: sentence.start, end: sentence.end, refKey: occ.key };
  }
  const node = live.nodes[change.nodeId];
  if (!node) return null;
  return { nodeId: change.nodeId, start: 0, end: Math.max(1, node.text.length) };
}

/** 未自动改写的引用定位到当前正文（按源节点 + 引用原文找回当前出现） */
export function sandboxSkippedJump(
  skipped: RewriteResult['skipped'][number],
  live: Analysis,
): SandboxJump | null {
  const occ = live.occurrences.find(
    (o) => o.nodeId === skipped.nodeId && o.span.raw === skipped.raw,
  );
  if (occ && live.nodes[occ.nodeId]) {
    const sentence = locateSentence(live.nodes[occ.nodeId].text, occ.span.start, occ.span.end);
    return { nodeId: occ.nodeId, start: sentence.start, end: sentence.end, refKey: occ.key };
  }
  const node = live.nodes[skipped.nodeId];
  if (!node) return null;
  return { nodeId: skipped.nodeId, start: 0, end: Math.max(1, node.text.length) };
}

/**
 * 问题定位到当前正文：
 * 非循环问题按源节点 ID + 引用原文 + 同文序次在当前分析中重定位源句；
 * 循环问题以环上第一个现存节点为定位；源节点（或环上全部节点）已删除则不可跳转。
 */
export function sandboxIssueJump(issue: Issue, live: Analysis): SandboxJump | null {
  const node = live.nodes[issue.sourceNodeId];
  if (node && issue.type !== 'cycle') {
    const occ = findOccurrence(live, issue);
    if (!occ) {
      // 引用原文已消失但源节点仍在：退回定位整个当前节点
      return { nodeId: node.id, start: 0, end: Math.max(1, node.text.length) };
    }
    const sentence = locateSentence(node.text, occ.span.start, occ.span.end);
    return { nodeId: node.id, start: sentence.start, end: sentence.end, refKey: occ.key };
  }
  const cycleNode = issue.cycleNodeIds?.find((id) => live.nodes[id]);
  if (cycleNode) {
    return { nodeId: cycleNode, start: 0, end: Math.max(1, live.nodes[cycleNode].text.length) };
  }
  if (node) return { nodeId: node.id, start: 0, end: Math.max(1, node.text.length) };
  return null;
}

/** 按问题身份在当前分析中找回对应的引用出现（同节点、同原文、同文序次） */
function findOccurrence(live: Analysis, issue: Issue): RefOccurrence | undefined {
  // 身份格式：type::nodeId::raw::occurrenceIndex（原文理论上可含 “::”，取首尾之外的中间段拼回）
  const parts = issue.identity.split('::');
  if (parts.length < 4) return undefined;
  const occurrenceIndex = Number(parts[parts.length - 1]);
  if (!Number.isInteger(occurrenceIndex)) return undefined;
  const raw = parts.slice(2, -1).join('::');
  return live.occurrences.find(
    (o) =>
      o.nodeId === issue.sourceNodeId &&
      o.span.raw === raw &&
      o.occurrenceIndex === occurrenceIndex,
  );
}
