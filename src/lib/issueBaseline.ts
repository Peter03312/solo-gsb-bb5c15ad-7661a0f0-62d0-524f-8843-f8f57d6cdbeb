import type {
  Analysis,
  ClauseDocument,
  Issue,
  IssueBaseline,
  IssueType,
  RefOccurrence,
} from '../../shared/model';
import { analyze, locateSentence } from './analyzer';
import { renumberAll } from './tree';
import { uid } from './uid';

/** 深拷贝可序列化内容（基线与正文完全脱离引用关系） */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 递归冻结基线对象，保证保存后只读、不随后续编辑变化 */
function deepFreeze<T>(value: T): T {
  if (typeof Object.freeze !== 'function' || !value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return value;
}

/** 以当前文档与歧义确认记录创建只读命名问题基线 */
export function createIssueBaseline(
  doc: ClauseDocument,
  confirmed: Record<string, string>,
  name: string,
  now = Date.now(),
): IssueBaseline {
  const baseline: IssueBaseline = {
    id: uid('ibl'),
    name,
    createdAt: now,
    doc: deepClone(doc),
    confirmed: deepClone(confirmed),
  };
  return deepFreeze(baseline);
}

/**
 * 校验并规整外部数据中的问题基线（旧数据 / 导入文件缺少 issueBaselines 时返回空列表）。
 * 手工编辑过的 JSON 可能序号错乱，这里重新规范化 ordinal，保证重新分析结果可信；
 * 问题身份不入库，比较时一律按基线文档重新 analyze 重建。
 */
export function sanitizeIssueBaselines(value: unknown): IssueBaseline[] {
  if (!Array.isArray(value)) return [];
  const out: IssueBaseline[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Partial<IssueBaseline>;
    if (!b.doc || !Array.isArray(b.doc.root) || typeof b.doc.title !== 'string') continue;
    // 深拷贝后再 renumber：导入数据可能是冻结对象（本应用导出的基线）或含共享引用
    const doc: ClauseDocument = deepClone({
      id: typeof b.doc.id === 'string' ? b.doc.id : uid('doc'),
      title: b.doc.title,
      root: b.doc.root,
      updatedAt: typeof b.doc.updatedAt === 'number' ? b.doc.updatedAt : 0,
    });
    renumberAll(doc.root);
    const confirmed: Record<string, string> = {};
    if (b.confirmed && typeof b.confirmed === 'object') {
      for (const [k, v] of Object.entries(b.confirmed)) {
        if (typeof v === 'string') confirmed[k] = v;
      }
    }
    out.push(
      deepFreeze({
        id: typeof b.id === 'string' && b.id ? b.id : uid('ibl'),
        name: typeof b.name === 'string' && b.name.trim() ? b.name : '未命名基线',
        createdAt: typeof b.createdAt === 'number' ? b.createdAt : 0,
        doc,
        confirmed,
      }),
    );
  }
  return out;
}

// ---------- 基线比较 ----------

export type IssueDiffStatus = 'added' | 'resolved' | 'persisting';

export interface IssueDiffEntry {
  status: IssueDiffStatus;
  type: IssueType;
  /** 稳定问题身份（跨基线 / 实时结果的对齐键） */
  identity: string;
  /** 当前（新增 / 仍存在）或基线（已解决）一侧的问题 */
  current?: Issue;
  baseline?: Issue;
  /**
   * 现存源句定位（用于点击跳转）：
   * 新增 / 仍存在直接取当前问题；已解决时按基线问题的源节点 ID、引用原文与同文序次
   * 在当前文档中重建定位（源节点已删除时为 null，不可跳转）。
   */
  jump: { nodeId: string; start: number; end: number; refKey?: string } | null;
}

export interface IssueBaselineDiff {
  added: IssueDiffEntry[];
  resolved: IssueDiffEntry[];
  persisting: IssueDiffEntry[];
  counts: { added: number; resolved: number; persisting: number };
}

/**
 * 按稳定问题身份在基线分析结果与实时分析结果之间对齐问题：
 * - 仅实时结果存在：新增；
 * - 仅基线存在：已解决；
 * - 两侧都有：仍存在（显示当前定位）。
 * 问题身份由类型、源节点稳定 ID、引用原文与同文序次（循环为排序节点 ID 集合）构成，
 * 字符偏移变化不会制造新问题。
 */
export function diffIssueBaseline(baselineAnalysis: Analysis, live: Analysis): IssueBaselineDiff {
  const baseByIdentity = new Map<Issue['identity'], Issue>();
  for (const issue of baselineAnalysis.issues) baseByIdentity.set(issue.identity, issue);
  const liveByIdentity = new Map<Issue['identity'], Issue>();
  for (const issue of live.issues) liveByIdentity.set(issue.identity, issue);

  const added: IssueDiffEntry[] = [];
  const persisting: IssueDiffEntry[] = [];
  const resolved: IssueDiffEntry[] = [];

  // 新增 / 仍存在：按实时结果的文档顺序输出
  for (const issue of live.issues) {
    const base = baseByIdentity.get(issue.identity);
    if (!base) {
      added.push({
        status: 'added',
        type: issue.type,
        identity: issue.identity,
        current: issue,
        jump: jumpOfLiveIssue(issue),
      });
    } else {
      persisting.push({
        status: 'persisting',
        type: issue.type,
        identity: issue.identity,
        current: issue,
        baseline: base,
        jump: jumpOfLiveIssue(issue),
      });
    }
  }

  // 已解决：按基线文档顺序输出
  for (const issue of baselineAnalysis.issues) {
    if (liveByIdentity.has(issue.identity)) continue;
    resolved.push({
      status: 'resolved',
      type: issue.type,
      identity: issue.identity,
      baseline: issue,
      jump: relocatedJump(issue, live),
    });
  }

  return {
    added,
    resolved,
    persisting,
    counts: { added: added.length, resolved: resolved.length, persisting: persisting.length },
  };
}

function jumpOfLiveIssue(issue: Issue): IssueDiffEntry['jump'] {
  return {
    nodeId: issue.sourceNodeId,
    start: issue.sentenceStart,
    end: issue.sentenceEnd,
    refKey: issue.refKey,
  };
}

/**
 * 已解决问题在当前文档中重建源句定位：
 * 非循环问题按源节点 ID + 引用原文 + 同文序次重新扫描该节点（偏移可能已变化）；
 * 循环问题以环上第一个现存节点为定位；源节点（或环上全部节点）已删除则不可跳转。
 */
function relocatedJump(issue: Issue, live: Analysis): IssueDiffEntry['jump'] {
  const node = live.nodes[issue.sourceNodeId];
  if (!node) return null;
  if (issue.type !== 'cycle') {
    const occ = findOccurrence(live, issue);
    if (!occ) {
      // 引用原文已消失但源节点仍在：退回定位整个当前节点
      return { nodeId: node.id, start: 0, end: Math.max(1, node.text.length) };
    }
    const sentence = locateSentence(node.text, occ.span.start, occ.span.end);
    return { nodeId: node.id, start: sentence.start, end: sentence.end, refKey: occ.key };
  }
  const cycleNode = issue.cycleNodeIds?.find((id) => live.nodes[id]);
  if (!cycleNode) return null;
  return { nodeId: cycleNode, start: 0, end: Math.max(1, live.nodes[cycleNode].text.length) };
}

/** 按问题身份在实时分析中找回对应的引用出现（同节点、同原文、同文序次） */
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

/** 重新分析基线文档（比较时调用；问题身份由此重建，不依赖保存时的分析结果） */
export function analyzeIssueBaseline(baseline: IssueBaseline): Analysis {
  return analyze(baseline.doc, { confirmed: baseline.confirmed });
}
