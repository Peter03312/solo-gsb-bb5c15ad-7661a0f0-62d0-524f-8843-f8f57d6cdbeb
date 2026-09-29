import type {
  Analysis,
  ClauseDocument,
  ClauseNode,
  NodeKind,
  RefOccurrence,
} from '../../shared/model';
import { formatOrdinal } from './numeral';

// ---------- 节点差异 ----------

export interface NodeDiffEntry {
  nodeId: string;
  kind: NodeKind;
  added: boolean;
  removed: boolean;
  /** 位置移动：父节点变化或同级序次变化 */
  moved: boolean;
  /** 正文修改：text / 条标题 / 后缀发生变化（移动且修改时与 moved 同时保留） */
  contentModified: boolean;
  oldText?: string;
  newText?: string;
  oldTitle?: string;
  newTitle?: string;
  oldSuffix?: string;
  newSuffix?: string;
  /** 旧版本中的结构位置标签，如“第五条第二款第（一）项” */
  oldLabel?: string;
  newLabel?: string;
}

export interface RefDiffEntry {
  /** 稳定 id，用于列表 key */
  key: string;
  kind: 'added' | 'removed' | 'retarget';
  /** 源节点 id（稳定 ID，可用于跳转当前版本） */
  nodeId: string;
  /** 引用原文 */
  raw: string;
  /** 同文序次：同节点内同原文的第几次出现 */
  occurrenceIndex: number;
  sourceLabel: string;
  oldStatus?: RefOccurrence['resolution']['status'];
  newStatus?: RefOccurrence['resolution']['status'];
  oldTargetId?: string;
  newTargetId?: string;
  oldTargetLabel?: string;
  newTargetLabel?: string;
}

export interface DocumentDiff {
  entries: Map<string, NodeDiffEntry>;
  refAdded: RefDiffEntry[];
  refRemoved: RefDiffEntry[];
  refRetargeted: RefDiffEntry[];
  counts: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
    refAdded: number;
    refRemoved: number;
    refRetargeted: number;
  };
  docTitleChanged: boolean;
}

interface IndexedNode {
  node: ClauseNode;
  parentId: string | null;
  ordinal: number;
}

function indexTree(root: ClauseNode[]): Map<string, IndexedNode> {
  const map = new Map<string, IndexedNode>();
  for (const article of root) {
    map.set(article.id, { node: article, parentId: null, ordinal: article.ordinal });
    for (const paragraph of article.children) {
      map.set(paragraph.id, { node: paragraph, parentId: article.id, ordinal: paragraph.ordinal });
      for (const item of paragraph.children) {
        map.set(item.id, { node: item, parentId: paragraph.id, ordinal: item.ordinal });
      }
    }
  }
  return map;
}

/** 以分析结果中的结构位置生成“第X条[之Y][第N款][第M项]”标签 */
function labelAt(analysis: Analysis, nodeId: string): string | undefined {
  const p = analysis.placement[nodeId];
  if (!p) return undefined;
  let s = `第${formatOrdinal(p.article.ordinal)}条`;
  if (p.article.suffix) s += `之${p.article.suffix}`;
  if (p.paragraphIndex > 0) s += `第${formatOrdinal(p.paragraphIndex)}款`;
  if (p.itemIndex > 0) s += `第${formatOrdinal(p.itemIndex)}项`;
  return s;
}

/** 引用对齐键：源节点 ID + 引用原文 + 同文序次（同一节点内同原文第 N 次出现） */
function refSignature(nodeId: string, raw: string, occurrenceIndex: number): string {
  return `${nodeId}::${raw}::${occurrenceIndex}`;
}

function targetLabel(analysis: Analysis, occ: RefOccurrence): string | undefined {
  if (occ.resolution.status === 'ok' && occ.resolution.targetId) {
    return occ.resolution.canonical || labelAt(analysis, occ.resolution.targetId);
  }
  if (occ.resolution.status === 'ambiguous') return '歧义（未确认）';
  // 组合引用部分缺失：列出已解析目标与缺失原因
  if (occ.resolution.targetIds?.length) {
    const resolved = occ.resolution.targetIds
      .map((id) => labelAt(analysis, id))
      .filter(Boolean)
      .join('、');
    return `部分缺失（已解析：${resolved}）：${occ.resolution.reason ?? ''}`;
  }
  return `断链：${occ.resolution.reason ?? '目标不存在'}`;
}

/** 引用的目标集合签名：单目标退化为单元素，组合引用比较整个稳定 ID 集合 */
function targetSetKey(occ: RefOccurrence): string {
  const ids =
    occ.resolution.targetIds ??
    (occ.resolution.targetId ? [occ.resolution.targetId] : []);
  return ids.join('');
}

/**
 * 比较两份文档分析结果：
 * - 节点以稳定 ID 对齐，分别标记新增、删除、正文修改、位置移动（可同时成立）；
 * - 引用以 源节点 ID + 原文 + 同文序次 对齐，列出新增、移除、目标变化。
 */
export function diffDocuments(
  oldAnalysis: Analysis,
  newAnalysis: Analysis,
  oldDoc: ClauseDocument,
  newDoc: ClauseDocument,
): DocumentDiff {
  const oldIndex = indexTree(oldDoc.root);
  const newIndex = indexTree(newDoc.root);
  const entries = new Map<string, NodeDiffEntry>();

  let added = 0;
  let removed = 0;
  let modified = 0;
  let moved = 0;

  for (const [id, n] of newIndex) {
    const o = oldIndex.get(id);
    if (!o) {
      entries.set(id, {
        nodeId: id,
        kind: n.node.kind,
        added: true,
        removed: false,
        moved: false,
        contentModified: false,
        newText: n.node.text,
        newTitle: n.node.title,
        newSuffix: n.node.suffix,
        newLabel: labelAt(newAnalysis, id),
      });
      added += 1;
      continue;
    }
    const contentModified =
      o.node.text !== n.node.text ||
      (o.node.title ?? '') !== (n.node.title ?? '') ||
      (o.node.suffix ?? '') !== (n.node.suffix ?? '');
    const isMoved = o.parentId !== n.parentId || o.ordinal !== n.ordinal;
    if (contentModified || isMoved) {
      entries.set(id, {
        nodeId: id,
        kind: n.node.kind,
        added: false,
        removed: false,
        moved: isMoved,
        contentModified,
        oldText: o.node.text,
        newText: n.node.text,
        oldTitle: o.node.title,
        newTitle: n.node.title,
        oldSuffix: o.node.suffix,
        newSuffix: n.node.suffix,
        oldLabel: labelAt(oldAnalysis, id),
        newLabel: labelAt(newAnalysis, id),
      });
      if (contentModified) modified += 1;
      if (isMoved) moved += 1;
    }
  }

  for (const [id, o] of oldIndex) {
    if (newIndex.has(id)) continue;
    entries.set(id, {
      nodeId: id,
      kind: o.node.kind,
      added: false,
      removed: true,
      moved: false,
      contentModified: false,
      oldText: o.node.text,
      oldTitle: o.node.title,
      oldSuffix: o.node.suffix,
      oldLabel: labelAt(oldAnalysis, id),
    });
    removed += 1;
  }

  // ---- 引用差异：源节点 ID + 原文 + 同文序次 ----
  const oldRefs = new Map<string, RefOccurrence>();
  const newRefs = new Map<string, RefOccurrence>();
  for (const occ of oldAnalysis.occurrences) {
    oldRefs.set(refSignature(occ.nodeId, occ.span.raw, occ.occurrenceIndex), occ);
  }
  for (const occ of newAnalysis.occurrences) {
    newRefs.set(refSignature(occ.nodeId, occ.span.raw, occ.occurrenceIndex), occ);
  }

  const refRetargeted: RefDiffEntry[] = [];
  const refRemoved: RefDiffEntry[] = [];
  const refAdded: RefDiffEntry[] = [];

  // 旧侧序：目标变化与移除按旧文档遍历顺序输出
  for (const occ of oldAnalysis.occurrences) {
    const sig = refSignature(occ.nodeId, occ.span.raw, occ.occurrenceIndex);
    const next = newRefs.get(sig);
    const sourceLabel =
      labelAt(oldAnalysis, occ.nodeId) ??
      labelAt(newAnalysis, occ.nodeId) ??
      '（已删除节点）';
    if (!next) {
      refRemoved.push({
        key: `del:${sig}`,
        kind: 'removed',
        nodeId: occ.nodeId,
        raw: occ.span.raw,
        occurrenceIndex: occ.occurrenceIndex,
        sourceLabel,
        oldStatus: occ.resolution.status,
        oldTargetId: occ.resolution.targetId,
        oldTargetLabel: targetLabel(oldAnalysis, occ),
      });
      continue;
    }
    const sameTarget =
      occ.resolution.status === next.resolution.status &&
      targetSetKey(occ) === targetSetKey(next);
    if (!sameTarget) {
      refRetargeted.push({
        key: `mov:${sig}`,
        kind: 'retarget',
        nodeId: occ.nodeId,
        raw: occ.span.raw,
        occurrenceIndex: occ.occurrenceIndex,
        sourceLabel,
        oldStatus: occ.resolution.status,
        newStatus: next.resolution.status,
        oldTargetId: occ.resolution.targetId,
        newTargetId: next.resolution.targetId,
        oldTargetLabel: targetLabel(oldAnalysis, occ),
        newTargetLabel: targetLabel(newAnalysis, next),
      });
    }
  }

  // 新侧序：新增引用按新文档遍历顺序输出
  for (const occ of newAnalysis.occurrences) {
    const sig = refSignature(occ.nodeId, occ.span.raw, occ.occurrenceIndex);
    if (oldRefs.has(sig)) continue;
    refAdded.push({
      key: `add:${sig}`,
      kind: 'added',
      nodeId: occ.nodeId,
      raw: occ.span.raw,
      occurrenceIndex: occ.occurrenceIndex,
      sourceLabel:
        labelAt(newAnalysis, occ.nodeId) ?? labelAt(oldAnalysis, occ.nodeId) ?? '（节点）',
      newStatus: occ.resolution.status,
      newTargetId: occ.resolution.targetId,
      newTargetLabel: targetLabel(newAnalysis, occ),
    });
  }

  return {
    entries,
    refAdded,
    refRemoved,
    refRetargeted,
    counts: {
      added,
      removed,
      modified,
      moved,
      refAdded: refAdded.length,
      refRemoved: refRemoved.length,
      refRetargeted: refRetargeted.length,
    },
    docTitleChanged: oldDoc.title !== newDoc.title,
  };
}

// ---------- 正文逐字差异（LCS，长文本退化为整段增删） ----------

export type TextSegment = { type: 'same' | 'add' | 'del'; text: string };

export const MAX_LCS_CHARS = 2000;

/** 字符级最长公共子序列差异，用于在“正文修改”行内并列高亮增删字符 */
export function diffText(oldText: string, newText: string): TextSegment[] {
  if (oldText === newText) return [{ type: 'same', text: newText }];
  if (oldText.length > MAX_LCS_CHARS || newText.length > MAX_LCS_CHARS) {
    const segs: TextSegment[] = [];
    if (oldText) segs.push({ type: 'del', text: oldText });
    if (newText) segs.push({ type: 'add', text: newText });
    return segs;
  }
  const a = [...oldText];
  const b = [...newText];
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: TextSegment[] = [];
  const push = (type: TextSegment['type'], ch: string) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += ch;
    else segs.push({ type, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i]);
      i += 1;
    } else {
      push('add', b[j]);
      j += 1;
    }
  }
  while (i < m) {
    push('del', a[i]);
    i += 1;
  }
  while (j < n) {
    push('add', b[j]);
    j += 1;
  }
  return segs;
}
