import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type {
  Analysis,
  Issue,
  IssueBaseline,
  IssueExceptionEntry,
  IssueType,
  RefOccurrence,
} from '../../shared/model';
import { labelOfNode } from '../lib/labels';
import {
  analyzeIssueBaseline,
  diffIssueBaseline,
  type IssueBaselineDiff,
  type IssueDiffEntry,
  type IssueDiffStatus,
} from '../lib/issueBaseline';
import { isExceptionableIssue } from '../lib/exception';

const TYPE_META: Record<IssueType, { label: string; cls: string; icon: string }> = {
  broken: { label: '断链', cls: 'it-broken', icon: '⛓' },
  self: { label: '自引用', cls: 'it-self', icon: '↺' },
  cycle: { label: '循环引用', cls: 'it-cycle', icon: '🔄' },
  ambiguous: { label: '歧义引用', cls: 'it-ambiguous', icon: '❓' },
};

const ORDER: IssueType[] = ['broken', 'cycle', 'self', 'ambiguous'];

/** 例外处置筛选：全部实时问题 / 未处置（无例外记录的断链、自引用）/ 已接受 / 待复核 / 已消失（留痕列表） */
type ExceptionFilter = 'all' | 'open' | 'accepted' | 'review' | 'gone';

function formatTime(ms: number): string {
  if (!ms) return '时间未知';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function IssuePanel() {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, issueBaselines, exceptionView } = store.getSnapshot();
  const [filter, setFilter] = useState<IssueType | 'all'>('all');
  const [exFilter, setExFilter] = useState<ExceptionFilter>('all');
  const [activeBaselineId, setActiveBaselineId] = useState<string | null>(null);

  // 当前选中的基线被删除后自动退出比较
  useEffect(() => {
    if (activeBaselineId && !issueBaselines.some((b) => b.id === activeBaselineId)) {
      setActiveBaselineId(null);
    }
  }, [issueBaselines, activeBaselineId]);

  const groups = useMemo(() => {
    const map = new Map<IssueType, Issue[]>();
    for (const issue of analysis.issues) {
      const list = map.get(issue.type) ?? [];
      list.push(issue);
      map.set(issue.type, list);
    }
    return map;
  }, [analysis]);

  const entryByIdentity = useMemo(() => {
    const map = new Map<string, IssueExceptionEntry>();
    for (const entry of exceptionView) {
      if (entry.status !== 'gone') map.set(entry.record.identity, entry);
    }
    return map;
  }, [exceptionView]);

  // 未处置：实时问题中无处置记录（或仅记录已消失）的可例外问题
  const openCount = analysis.issues.filter(
    (i) => isExceptionableIssue(i) && !entryByIdentity.has(i.identity),
  ).length;
  const acceptedCount = exceptionView.filter((e) => e.status === 'accepted').length;
  const reviewCount = exceptionView.filter((e) => e.status === 'review').length;
  const goneCount = exceptionView.filter((e) => e.status === 'gone').length;
  const exCounts: Record<ExceptionFilter, number> = {
    all: analysis.issues.length,
    open: openCount,
    accepted: acceptedCount,
    review: reviewCount,
    gone: goneCount,
  };

  // 主列表：未处置 / 已接受 / 待复核筛选下列实时问题；类型筛选同时生效；「全部」显示所有实时问题
  const visible = useMemo(() => {
    const typeOk = (issue: Issue) => filter === 'all' || issue.type === filter;
    if (exFilter === 'gone') return [];
    return analysis.issues.filter((issue) => {
      if (!typeOk(issue)) return false;
      if (exFilter === 'all') return true;
      const entry = entryByIdentity.get(issue.identity);
      if (exFilter === 'open') return !entry && isExceptionableIssue(issue);
      if (exFilter === 'accepted') return entry?.status === 'accepted';
      return entry?.status === 'review';
    });
  }, [analysis.issues, filter, exFilter, entryByIdentity]);

  const goneEntries = useMemo(
    () => exceptionView.filter((e) => e.status === 'gone'),
    [exceptionView],
  );

  const counts = ORDER.map((t) => [t, groups.get(t)?.length ?? 0] as const);

  const activeBaseline = issueBaselines.find((b) => b.id === activeBaselineId) ?? null;

  const exFilterBtn = (key: ExceptionFilter, label: string) => (
    <button
      className={`ex-filter ex-${key} ${exFilter === key ? 'active' : ''}`}
      disabled={key !== 'all' && key !== 'open' && exCounts[key] === 0}
      onClick={() => setExFilter(key)}
    >
      {label} {exCounts[key]}
    </button>
  );

  return (
    <div className="issue-panel">
      <BaselineBar
        baselines={issueBaselines}
        activeBaseline={activeBaseline}
        onSelect={setActiveBaselineId}
      />

      {activeBaseline ? (
        <BaselineCompare baseline={activeBaseline} live={analysis} onExit={() => setActiveBaselineId(null)} />
      ) : (
        <>
          <div className="issue-filters">
            <button
              className={filter === 'all' ? 'active' : ''}
              onClick={() => setFilter('all')}
            >
              全部 {analysis.issues.length}
            </button>
            {counts.map(([t, n]) => (
              <button
                key={t}
                className={`${TYPE_META[t].cls} ${filter === t ? 'active' : ''}`}
                disabled={n === 0}
                onClick={() => setFilter(t)}
              >
                {TYPE_META[t].icon} {TYPE_META[t].label} {n}
              </button>
            ))}
          </div>

          <div className="issue-filters exception-filters">
            <button
              className={`ex-filter ex-all ${exFilter === 'all' ? 'active' : ''}`}
              onClick={() => setExFilter('all')}
            >
              全部 {exCounts.all}
            </button>
            {exFilterBtn('open', '未处置')}
            {exFilterBtn('accepted', '✓ 已接受')}
            {exFilterBtn('review', '⚠ 待复核')}
            {exFilterBtn('gone', '已消失')}
          </div>

          {exFilter === 'gone' ? (
            <GoneExceptionList entries={goneEntries} />
          ) : (
            <div className="issue-list">
              {visible.length === 0 && (
                <div className="empty-hint">
                  {exFilter === 'open'
                    ? openCount === 0
                      ? '当前没有未处置的断链或自引用问题（循环与歧义引用不适用例外处置）。'
                      : '该问题类型下暂无未处置问题。'
                    : exFilter === 'accepted'
                      ? '当前没有已接受的例外。'
                      : exFilter === 'review'
                        ? '当前没有待复核的例外。'
                        : analysis.issues.length === 0
                          ? '✓ 全部引用均可唯一定位，且不存在自引用或循环。'
                          : '该类别下暂无问题。'}
                </div>
              )}
              {visible.map((issue) => (
                <IssueRow
                  key={issue.key}
                  issue={issue}
                  exceptionEntry={entryByIdentity.get(issue.identity) ?? null}
                />
              ))}
            </div>
          )}

          <div className="panel-footer">
            点击问题可跳到源句；对断链或自引用问题可填写理由「接受例外」，记录保存处置时来源句原文——来源句变化转「待复核」，问题消失转「已消失」。
          </div>
        </>
      )}
    </div>
  );
}

// ---------- 已消失例外留痕列表 ----------

function GoneExceptionList({ entries }: { entries: IssueExceptionEntry[] }) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const ordered = [...entries].sort((a, b) => b.record.acceptedAt - a.record.acceptedAt);

  return (
    <div className="issue-list exception-gone-list">
      {ordered.length === 0 && (
        <div className="empty-hint">没有已消失的例外处置记录。</div>
      )}
      {ordered.map((entry) => {
        const record = entry.record;
        const meta = TYPE_META[record.type as IssueType];
        const nodeExists = Boolean(analysis.nodes[record.sourceNodeId]);
        return (
          <div key={record.id} className="issue-row exception-gone-row">
            <div className="issue-row-head">
              <span className="issue-type-tag">
                {meta.icon} {meta.label}
              </span>
              <span className="ex-status-tag is-gone">已消失</span>
            </div>
            <div className="exception-evidence">
              <span className="exception-evidence-tag">处置时来源句：</span>
              “{record.sourceSentence.length > 80 ? record.sourceSentence.slice(0, 80) + '…' : record.sourceSentence}”
            </div>
            <div className="exception-reason">
              <span className="exception-reason-tag">理由：</span>
              {record.reason}
              <span className="exception-time">（{formatTime(record.acceptedAt)}）</span>
            </div>
            <div className="exception-actions">
              {nodeExists ? (
                <button
                  className="link-btn"
                  onClick={() => highlighter.jumpTo(record.sourceNodeId)}
                >
                  → 跳转源节点
                </button>
              ) : (
                <span className="exception-node-gone" title="源节点已从当前文档删除">
                  源节点已删除，不可跳转
                </span>
              )}
              <button
                className="link-btn subtle"
                onClick={() => {
                  if (confirm('删除该条已消失问题的例外留痕？删除不影响正文。')) {
                    store.deleteIssueException(record.id);
                  }
                }}
              >
                删除留痕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 问题基线管理栏 ----------

function BaselineBar({
  baselines,
  activeBaseline,
  onSelect,
}: {
  baselines: IssueBaseline[];
  activeBaseline: IssueBaseline | null;
  onSelect: (id: string | null) => void;
}) {
  const { store } = useApp();
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  const save = () => {
    const id = store.saveIssueBaseline(name);
    setName('');
    // 保存后立即与该基线比较
    onSelect(id);
  };

  const removeBaseline = (b: IssueBaseline) => {
    if (confirm(`确定删除问题基线「${b.name}」？基线仅为检测结果快照，删除不影响正文。`)) {
      store.deleteIssueBaseline(b.id);
    }
  };

  return (
    <div className="baseline-bar">
      <button
        className={`baseline-bar-toggle ${open || activeBaseline ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="把当前检测结果保存为命名基线，再与实时结果比较"
      >
        📌 问题基线{baselines.length > 0 ? `（${baselines.length}）` : ''} {open ? '▾' : '▸'}
      </button>

      {(open || activeBaseline) && (
        <div className="baseline-bar-body">
          <div className="baseline-save">
            <input
              className="baseline-name-input"
              placeholder="为当前检测结果命名，如「一审基线」"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
            <button className="primary small" onClick={save}>
              保存为基线
            </button>
          </div>

          {baselines.length === 0 ? (
            <div className="baseline-empty">
              尚无基线。保存后可把基线时刻的问题与实时结果按稳定身份比较（新增 / 已解决 / 仍存在），正文增删导致的字符偏移变化不会制造新问题。
            </div>
          ) : (
            <div className="baseline-chip-list">
              {baselines.map((b) => (
                <div
                  key={b.id}
                  className={`baseline-chip ${activeBaseline?.id === b.id ? 'active' : ''}`}
                >
                  <button
                    className="baseline-chip-main"
                    title={activeBaseline?.id === b.id ? '退出基线比较' : '与该基线比较实时结果'}
                    onClick={() => onSelect(activeBaseline?.id === b.id ? null : b.id)}
                  >
                    <strong>{b.name}</strong>
                    <span className="baseline-time">{formatTime(b.createdAt)}</span>
                  </button>
                  <button
                    className="danger small"
                    title="删除该基线（不影响正文）"
                    onClick={() => removeBaseline(b)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 基线比较视图 ----------

const STATUS_META: Record<IssueDiffStatus, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'bl-added' },
  resolved: { label: '已解决', cls: 'bl-resolved' },
  persisting: { label: '仍存在', cls: 'bl-persisting' },
};

function BaselineCompare({
  baseline,
  live,
  onExit,
}: {
  baseline: IssueBaseline;
  live: Analysis;
  onExit: () => void;
}) {
  const baselineAnalysis = useMemo(() => analyzeIssueBaseline(baseline), [baseline]);
  const diff: IssueBaselineDiff = useMemo(
    () => diffIssueBaseline(baselineAnalysis, live),
    [baselineAnalysis, live],
  );
  const [statusFilter, setStatusFilter] = useState<IssueDiffStatus | 'all'>('all');

  const ordered: IssueDiffEntry[] = useMemo(() => {
    const list =
      statusFilter === 'all'
        ? [...diff.added, ...diff.resolved, ...diff.persisting]
        : diff[statusFilter];
    return list;
  }, [diff, statusFilter]);

  return (
    <>
      <div className="baseline-compare-head">
        <div className="baseline-compare-title">
          与基线「<strong>{baseline.name}</strong>」比较
          <button className="link-btn subtle" onClick={onExit}>
            ✕ 退出比较
          </button>
        </div>
        <div className="baseline-status-filters">
          <button
            className={statusFilter === 'all' ? 'active' : ''}
            onClick={() => setStatusFilter('all')}
          >
            全部 {diff.counts.added + diff.counts.resolved + diff.counts.persisting}
          </button>
          <button
            className={`${STATUS_META.added.cls} ${statusFilter === 'added' ? 'active' : ''}`}
            disabled={diff.counts.added === 0}
            onClick={() => setStatusFilter('added')}
          >
            {STATUS_META.added.label} {diff.counts.added}
          </button>
          <button
            className={`${STATUS_META.resolved.cls} ${statusFilter === 'resolved' ? 'active' : ''}`}
            disabled={diff.counts.resolved === 0}
            onClick={() => setStatusFilter('resolved')}
          >
            {STATUS_META.resolved.label} {diff.counts.resolved}
          </button>
          <button
            className={`${STATUS_META.persisting.cls} ${statusFilter === 'persisting' ? 'active' : ''}`}
            disabled={diff.counts.persisting === 0}
            onClick={() => setStatusFilter('persisting')}
          >
            {STATUS_META.persisting.label} {diff.counts.persisting}
          </button>
        </div>
      </div>

      <div className="issue-list baseline-diff-list">
        {ordered.length === 0 && (
          <div className="empty-hint">
            {diff.counts.added + diff.counts.resolved === 0
              ? `✓ 与基线「${baseline.name}」相比没有新增或已解决问题，${diff.counts.persisting} 个问题仍存在。`
              : '该类别下暂无问题。'}
          </div>
        )}
        {ordered.map((entry) =>
          entry.status === 'resolved' ? (
            <ResolvedIssueRow
              key={entry.identity}
              entry={entry}
              baselineAnalysis={baselineAnalysis}
            />
          ) : (
            <CurrentIssueRow
              key={entry.identity}
              entry={entry}
              baselineAnalysis={baselineAnalysis}
            />
          ),
        )}
      </div>

      <div className="panel-footer">
        问题按「类型 + 源节点稳定 ID + 引用原文 + 同文序次」对齐（循环以排序后的稳定节点 ID 集合标识）；点击任意行可跳到现存源句，源节点已删除的已解决问题不可跳转。
      </div>
    </>
  );
}

/** 新增 / 仍存在：复用实时问题行，顶部加比较状态与基线定位 */
function CurrentIssueRow({
  entry,
  baselineAnalysis,
}: {
  entry: IssueDiffEntry;
  baselineAnalysis: Analysis;
}) {
  const { store } = useApp();
  const { analysis, exceptionView } = store.getSnapshot();
  const issue = entry.current!;
  const meta = STATUS_META[entry.status];
  const currentLabel = labelOfNode(analysis, issue.sourceNodeId);
  const baselineLabel = entry.baseline
    ? labelOfNode(baselineAnalysis, entry.baseline.sourceNodeId)
    : '';
  const exEntry =
    exceptionView.find((e) => e.record.identity === issue.identity && e.status !== 'gone') ?? null;

  return (
    <div className={`baseline-diff-wrap ${meta.cls}`}>
      <div className="baseline-diff-banner">
        <span className={`bl-badge ${meta.cls}`}>{meta.label}</span>
        <span className="bl-location">
          {entry.status === 'persisting' && baselineLabel && baselineLabel !== currentLabel ? (
            <>
              基线定位 {baselineLabel} <span className="move-arrow">→</span> 当前 {currentLabel}
            </>
          ) : (
            <>当前定位 {currentLabel}</>
          )}
        </span>
      </div>
      <IssueRow issue={issue} exceptionEntry={exEntry} />
    </div>
  );
}

/** 已解决：行内信息取自基线分析；点击按重定位结果跳到现存源句 */
function ResolvedIssueRow({
  entry,
  baselineAnalysis,
}: {
  entry: IssueDiffEntry;
  baselineAnalysis: Analysis;
}) {
  const { highlighter } = useApp();
  const issue = entry.baseline!;
  const meta = TYPE_META[issue.type];
  const sourceNode = baselineAnalysis.nodes[issue.sourceNodeId];
  const sentenceText = sourceNode
    ? sourceNode.text.slice(issue.sentenceStart, issue.sentenceEnd).trim()
    : '';
  const baselineLabel = labelOfNode(baselineAnalysis, issue.sourceNodeId);
  const canJump = Boolean(entry.jump);

  const jump = () => {
    if (!entry.jump) return;
    highlighter.jumpTo(
      entry.jump.nodeId,
      { start: entry.jump.start, end: entry.jump.end },
      entry.jump.refKey,
    );
  };

  return (
    <div className={`baseline-diff-wrap bl-resolved`}>
      <div className="baseline-diff-banner">
        <span className="bl-badge bl-resolved">已解决</span>
        <span className="bl-location">基线定位 {baselineLabel}</span>
        {canJump ? (
          <button className="link-btn bl-jump" onClick={jump}>
            → 查看现存源句
          </button>
        ) : (
          <span className="bl-gone" title="基线中的源节点已从当前文档删除">
            源节点已删除，不可跳转
          </span>
        )}
      </div>
      <div className={`issue-row ${meta.cls} is-resolved-row ${canJump ? '' : 'is-gone'}`}>
        <div className="issue-row-head">
          <span className="issue-type-tag">
            {meta.icon} {meta.label}
          </span>
          <span className="issue-source-label">{baselineLabel}（基线）</span>
        </div>
        {canJump ? (
          <button className="issue-sentence" onClick={jump} title="跳到现存源句">
            “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
          </button>
        ) : (
          <div className="issue-sentence is-static">
            “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
          </div>
        )}
        <div className="issue-message">{issue.message}</div>
        {issue.cycleNodeIds && (
          <div className="cycle-chain">
            {issue.cycleNodeIds.map((id, i) => (
              <span key={id}>
                {labelOfNode(baselineAnalysis, id)}
                {i < issue.cycleNodeIds!.length - 1 ? ' → ' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  exceptionEntry,
}: {
  issue: Issue;
  exceptionEntry: IssueExceptionEntry | null;
}) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const meta = TYPE_META[issue.type];
  const sourceNode = analysis.nodes[issue.sourceNodeId];
  const refOcc: RefOccurrence | undefined = issue.refKey
    ? analysis.occurrences.find((o) => o.key === issue.refKey)
    : undefined;

  const sentenceText = sourceNode
    ? sourceNode.text.slice(issue.sentenceStart, issue.sentenceEnd).trim()
    : '';

  const jumpSource = () => {
    highlighter.jumpTo(
      issue.sourceNodeId,
      { start: issue.sentenceStart, end: issue.sentenceEnd },
      issue.refKey,
    );
  };
  const jumpTarget = () => {
    if (issue.targetNodeId) highlighter.jumpTo(issue.targetNodeId);
  };

  const accepted = exceptionEntry?.status === 'accepted';

  return (
    <div
      className={`issue-row ${meta.cls} ${issue.confirmedTargetId ? 'is-confirmed' : ''} ${
        accepted ? 'is-exception-accepted' : ''
      } ${exceptionEntry?.status === 'review' ? 'is-exception-review' : ''}`}
    >
      <div className="issue-row-head">
        <span className="issue-type-tag">
          {meta.icon} {issue.confirmedTargetId ? `${meta.label}（已确认）` : meta.label}
        </span>
        <span className="issue-head-right">
          {exceptionEntry && <ExceptionStatusBadge status={exceptionEntry.status} />}
          <span className="issue-source-label">
            {labelOfNode(analysis, issue.sourceNodeId)}
          </span>
        </span>
      </div>
      <button className="issue-sentence" onClick={jumpSource} title="跳到源句">
        “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
      </button>
      <div className="issue-message">{issue.message}</div>

      {(issue.resolvedTargetIds?.length || issue.missingTargets?.length) && (
        <div className="combined-targets">
          {issue.resolvedTargetIds && issue.resolvedTargetIds.length > 0 && (
            <div className="combined-line">
              <span className="combined-tag">已解析：</span>
              {issue.resolvedTargetIds.map((id) => (
                <button
                  key={id}
                  className="link-btn"
                  onClick={() => highlighter.jumpTo(id)}
                >
                  {labelOfNode(analysis, id)}
                </button>
              ))}
            </div>
          )}
          {issue.missingTargets && issue.missingTargets.length > 0 && (
            <div className="combined-line">
              <span className="combined-tag">缺失：</span>
              {issue.missingTargets.map((m, i) => (
                <span key={`${m.raw}-${i}`} className="missing-target" title={m.reason}>
                  {m.raw}（{m.reason}）
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {issue.type === 'ambiguous' && refOcc && (
        <CandidatePicker occurrence={refOcc} />
      )}

      {issue.targetNodeId && issue.type !== 'ambiguous' && (
        <button className="link-btn" onClick={jumpTarget}>
          → 定位目标：{labelOfNode(analysis, issue.targetNodeId)}
        </button>
      )}
      {issue.cycleNodeIds && (
        <div className="cycle-chain">
          {issue.cycleNodeIds.map((id, i) => (
            <span key={id}>
              <button className="link-btn" onClick={() => highlighter.jumpTo(id)}>
                {labelOfNode(analysis, id)}
              </button>
              {i < issue.cycleNodeIds!.length - 1 ? ' → ' : ''}
            </span>
          ))}
        </div>
      )}

      {isExceptionableIssue(issue) && (
        <ExceptionBox issue={issue} entry={exceptionEntry} onJumpSource={jumpSource} />
      )}
    </div>
  );
}

function ExceptionStatusBadge({ status }: { status: IssueExceptionEntry['status'] }) {
  if (status === 'accepted') return <span className="ex-status-tag is-accepted">✓ 已接受</span>;
  return <span className="ex-status-tag is-review">⚠ 待复核</span>;
}

// ---------- 例外处置：接受 / 待复核重新确认 / 撤销 ----------

function ExceptionBox({
  issue,
  entry,
  onJumpSource,
}: {
  issue: Issue;
  entry: IssueExceptionEntry | null;
  onJumpSource: () => void;
}) {
  const { store } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 未处置：展开接受表单
  if (!entry) {
    if (!open) {
      return (
        <div className="exception-actions">
          <button className="link-btn ex-accept-toggle" onClick={() => setOpen(true)}>
            🛡 接受例外…
          </button>
        </div>
      );
    }
    const submit = () => {
      const res = store.acceptIssueException(issue.identity, reason);
      if (!res.ok) {
        setError(res.error ?? '接受失败');
        return;
      }
      setError(null);
      setReason('');
      setOpen(false);
    };
    return (
      <div className="exception-box">
        <textarea
          className="exception-reason-input"
          placeholder="填写接受该断链 / 自引用为例外的理由（必填）"
          value={reason}
          autoFocus
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setError(null);
            }
          }}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="exception-actions">
          <button
            className="primary small"
            disabled={!reason.trim()}
            onClick={submit}
          >
            标记接受例外
          </button>
          <button
            className="link-btn subtle"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  const record = entry.record;

  // 已接受：展示理由与处置时间，可撤销
  if (entry.status === 'accepted') {
    return (
      <div className="exception-box is-accepted">
        <div className="exception-reason">
          <span className="exception-reason-tag">例外理由：</span>
          {record.reason}
        </div>
        <div className="exception-meta">
          <span>处置于 {formatTime(record.acceptedAt)}</span>
          <button className="link-btn" onClick={onJumpSource}>
            → 跳到来源正文
          </button>
          <button
            className="link-btn subtle"
            onClick={() => {
              if (confirm('撤销该问题的例外处置？撤销后问题恢复为未处置。')) {
                store.revokeIssueException(record.identity);
              }
            }}
          >
            撤销处置
          </button>
        </div>
      </div>
    );
  }

  // 待复核：来源句已变化，须刷新来源句证据后重新确认
  const submitReview = (nextReason: string) => {
    const res = store.reconfirmIssueException(record.identity, nextReason);
    if (!res.ok) {
      setError(res.error ?? '重新确认失败');
      return;
    }
    setError(null);
    setReason('');
    setOpen(false);
  };

  return (
    <div className="exception-box is-review">
      <div className="exception-review-hint">
        来源句自处置后已变化，须核对当前正文并重新确认（刷新来源句证据）。
      </div>
      <div className="exception-evidence">
        <span className="exception-evidence-tag">处置时来源句：</span>
        “{record.sourceSentence}”
      </div>
      <div className="exception-evidence is-current">
        <span className="exception-evidence-tag">当前来源句：</span>
        <button className="issue-sentence ex-current-sentence" onClick={onJumpSource} title="跳到当前来源句">
          “{entry.currentSentence}”
        </button>
      </div>
      {!open ? (
        <div className="exception-actions">
          <button className="primary small" onClick={() => { setReason(record.reason); setOpen(true); }}>
            重新确认（刷新证据）
          </button>
          <button className="link-btn" onClick={onJumpSource}>
            → 跳到来源正文核对
          </button>
          <button
            className="link-btn subtle"
            onClick={() => {
              if (confirm('撤销该问题的例外处置？撤销后问题恢复为未处置。')) {
                store.revokeIssueException(record.identity);
              }
            }}
          >
            撤销处置
          </button>
        </div>
      ) : (
        <>
          <textarea
            className="exception-reason-input"
            placeholder="核对后可补充 / 修改例外理由（必填）"
            value={reason}
            autoFocus
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
          />
          {error && <div className="form-error">{error}</div>}
          <div className="exception-actions">
            <button
              className="primary small"
              disabled={!reason.trim()}
              onClick={() => submitReview(reason)}
            >
              确认并刷新证据
            </button>
            <button
              className="link-btn subtle"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CandidatePicker({ occurrence }: { occurrence: RefOccurrence }) {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, confirmed } = store.getSnapshot();
  const candidates =
    occurrence.resolution.candidates ?? occurrence.resolution.ambiguity?.candidates ?? [];
  const chosen =
    occurrence.resolution.ambiguity
      ? occurrence.resolution.targetId
      : confirmed[occurrence.signature];

  return (
    <div className="candidate-box">
      <div className="candidate-title">
        {chosen
          ? `已确认目标为 ${chosen ? labelOfNode(analysis, chosen) : ''}，可撤销后重新选择：`
          : `存在 ${candidates.length} 个候选，系统不会自动改写，请确认目标：`}
      </div>
      {candidates.map((id) => (
        <label key={id} className={`candidate-item ${chosen === id ? 'chosen' : ''}`}>
          <input
            type="radio"
            name={`cand-${occurrence.key}`}
            checked={chosen === id}
            onChange={() => store.confirmAmbiguous(occurrence.signature, id)}
          />
          <button
            type="button"
            className="link-btn"
            onClick={(e) => {
              e.preventDefault();
              highlighter.jumpTo(id);
            }}
          >
            {labelOfNode(analysis, id)}
          </button>
        </label>
      ))}
      {chosen && (
        <div className="candidate-actions">
          <button
            className="link-btn"
            onClick={() => highlighter.jumpTo(chosen)}
          >
            → 跳到已确认目标
          </button>
          <button
            className="link-btn subtle"
            onClick={() => store.clearConfirmation(occurrence.signature)}
          >
            撤销确认（恢复为歧义）
          </button>
        </div>
      )}
    </div>
  );
}
