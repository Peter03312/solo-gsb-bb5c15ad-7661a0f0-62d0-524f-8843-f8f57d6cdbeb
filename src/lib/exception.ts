import type {
  Analysis,
  Issue,
  IssueException,
  IssueExceptionEntry,
  IssueExceptionStatus,
  IssueType,
} from '../../shared/model';
import { uid } from './uid';

/** 可做例外处置的问题类型：断链与自引用（歧义有确认流程，循环为结构性环） */
export const EXCEPTIONABLE_TYPES: ReadonlySet<IssueType> = new Set(['broken', 'self']);

/** 该问题是否允许接受例外 */
export function isExceptionableIssue(issue: Issue): boolean {
  return EXCEPTIONABLE_TYPES.has(issue.type);
}

/** 来源句原文归一化：去除首尾空白后逐字比对（正文前后加字不改变句子） */
function sentenceOf(analysis: Analysis, issue: Issue): string {
  const node = analysis.nodes[issue.sourceNodeId];
  if (!node) return '';
  return node.text.slice(issue.sentenceStart, issue.sentenceEnd).trim();
}

/**
 * 对当前断链 / 自引用问题填写理由并接受例外：
 * 记录绑定稳定问题身份，并保存处置时的来源节点 ID 与来源句原文证据。
 */
export function acceptIssueException(issue: Issue, analysis: Analysis, reason: string, now = Date.now()): IssueException {
  return {
    id: uid('iex'),
    identity: issue.identity,
    type: issue.type,
    reason,
    acceptedAt: now,
    sourceNodeId: issue.sourceNodeId,
    sourceSentence: sentenceOf(analysis, issue),
  };
}

/**
 * 待复核项重新确认：以当前实时问题刷新来源节点与来源句证据，
 * 理由沿用复核框中的内容（未修改即原理由），刷新处置时间。
 */
export function reconfirmIssueException(
  record: IssueException,
  issue: Issue,
  analysis: Analysis,
  reason: string,
  now = Date.now(),
): IssueException {
  return {
    ...record,
    identity: issue.identity,
    type: issue.type,
    reason,
    acceptedAt: now,
    sourceNodeId: issue.sourceNodeId,
    sourceSentence: sentenceOf(analysis, issue),
  };
}

/**
 * 校验并规整外部数据中的例外处置记录（旧数据 / 导入文件缺少 issueExceptions 时返回空列表）。
 * 实时状态不入库：加载后一律按当前分析重算已接受 / 待复核 / 已消失。
 */
export function sanitizeIssueExceptions(value: unknown): IssueException[] {
  if (!Array.isArray(value)) return [];
  const out: IssueException[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<IssueException>;
    if (typeof r.identity !== 'string' || !r.identity) continue;
    if (!r.type || !EXCEPTIONABLE_TYPES.has(r.type)) continue;
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (!reason) continue;
    const sourceNodeId = typeof r.sourceNodeId === 'string' ? r.sourceNodeId : '';
    const sourceSentence = typeof r.sourceSentence === 'string' ? r.sourceSentence.trim() : '';
    if (!sourceNodeId || !sourceSentence) continue;
    const acceptedAt =
      typeof r.acceptedAt === 'number' && Number.isFinite(r.acceptedAt) ? r.acceptedAt : 0;
    // 同一身份多条记录（手工编辑 JSON）：保留第一条
    if (seen.has(r.identity)) continue;
    seen.add(r.identity);
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : uid('iex'),
      identity: r.identity,
      type: r.type,
      reason,
      acceptedAt,
      sourceNodeId,
      sourceSentence,
    });
  }
  return out;
}

// ---------- 当前状态汇总（实时重算，不入库） ----------

/**
 * 把例外处置记录与当前实时分析逐条比对：
 * - 身份仍在当前问题集合中、且来源句原文与处置证据一致 → 已接受；
 * - 身份仍在但来源句已变化（正文编辑 / 自动改写使该句文字改变）→ 待复核；
 * - 身份已从当前问题中消失（问题被改正 / 删除 / 类型变化）→ 已消失。
 * 仅断链 / 自引用类型的身份参与判定。
 */
export function buildIssueExceptionView(
  analysis: Analysis,
  records: readonly IssueException[],
): IssueExceptionEntry[] {
  const liveByIdentity = new Map<string, Issue>();
  for (const issue of analysis.issues) {
    if (EXCEPTIONABLE_TYPES.has(issue.type)) liveByIdentity.set(issue.identity, issue);
  }
  return records.map((record) => {
    const currentIssue = liveByIdentity.get(record.identity) ?? null;
    if (!currentIssue) {
      return { record, status: 'gone' satisfies IssueExceptionStatus, currentIssue: null, currentSentence: null };
    }
    const currentSentence = sentenceOf(analysis, currentIssue);
    const status: IssueExceptionStatus =
      currentSentence === record.sourceSentence ? 'accepted' : 'review';
    return { record, status, currentIssue, currentSentence };
  });
}

/** 从当前分析中取出某条处置记录对应的实时条目（不存在时为 null） */
export function findExceptionEntry(
  entries: readonly IssueExceptionEntry[],
  identity: string,
): IssueExceptionEntry | null {
  return entries.find((e) => e.record.identity === identity) ?? null;
}
