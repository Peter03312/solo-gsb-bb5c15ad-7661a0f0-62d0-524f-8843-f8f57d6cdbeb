import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { labelOfNode, shortArticleLabel } from '../lib/labels';
import {
  sandboxIssueJump,
  sandboxRewriteJump,
  sandboxSkippedJump,
  type SandboxJump,
  type SandboxOp,
} from '../lib/sandbox';
import type { Issue } from '../../shared/model';

type OpKind = SandboxOp['kind'];

const OP_LABEL: Record<OpKind, string> = {
  delete: '删除该条',
  move: '移位（移动到指定位置）',
  renumber: '换号（改为第 N 条）',
};

const ISSUE_ICON: Record<string, string> = { broken: '⛓', cycle: '🔄' };

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function SandboxPanel() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, sandbox, sandboxStale } = store.getSnapshot();

  const [articleId, setArticleId] = useState('');
  const [kind, setKind] = useState<OpKind>('delete');
  const [param, setParam] = useState('');
  const [error, setError] = useState<string | null>(null);

  const articles = analysis.articles;
  const selectedExists = Boolean(articleId && analysis.nodes[articleId]);

  const jump = (target: SandboxJump | null) => {
    if (!target) return;
    highlighter.jumpTo(target.nodeId, { start: target.start, end: target.end }, target.refKey);
  };

  const runPreview = () => {
    setError(null);
    if (!articleId || !analysis.nodes[articleId]) {
      setError('请先选择要预演的条款');
      return;
    }
    let op: SandboxOp;
    if (kind === 'delete') {
      op = { kind: 'delete', articleId };
    } else {
      const n = Number(param);
      if (!Number.isInteger(n) || n < 1 || n > articles.length) {
        setError(`请输入 1 ～ ${articles.length} 的${kind === 'move' ? '目标位置' : '新条号'}`);
        return;
      }
      op =
        kind === 'move'
          ? { kind: 'move', articleId, toIndex: n - 1 }
          : { kind: 'renumber', articleId, newOrdinal: n };
    }
    const res = store.runSandboxPreview(op);
    if (!res.ok) setError(res.error ?? '预演失败');
  };

  // 将被改写的引用按来源节点分组（保持文档顺序）
  const changeGroups = useMemo(() => {
    if (!sandbox) return [];
    const groups: { nodeId: string; items: typeof sandbox.changes }[] = [];
    for (const change of sandbox.changes) {
      const last = groups[groups.length - 1];
      if (last && last.nodeId === change.nodeId) last.items.push(change);
      else groups.push({ nodeId: change.nodeId, items: [change] });
    }
    return groups;
  }, [sandbox]);

  return (
    <div className="sandbox-panel">
      <div className="sandbox-builder">
        <div className="sandbox-builder-head">
          <span className="impact-title">修订沙盒</span>
          <span className="sandbox-builder-note">条级删除 / 移位 / 换号预演</span>
        </div>
        <div className="sandbox-form">
          <select
            className="impact-select"
            value={selectedExists ? articleId : ''}
            onChange={(e) => setArticleId(e.target.value)}
            aria-label="选择预演条款"
          >
            <option value="">选择条款…</option>
            {articles.map((a) => (
              <option key={a.id} value={a.id}>
                {shortArticleLabel(a.ordinal, a.suffix)}
                {a.title ? ` ${a.title}` : ''}
              </option>
            ))}
          </select>
          <select
            className="impact-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as OpKind)}
            aria-label="选择预演操作"
          >
            {(Object.keys(OP_LABEL) as OpKind[]).map((k) => (
              <option key={k} value={k}>
                {OP_LABEL[k]}
              </option>
            ))}
          </select>
          {kind !== 'delete' && (
            <input
              className="sandbox-num"
              type="number"
              min={1}
              max={articles.length}
              value={param}
              placeholder={kind === 'move' ? '第 N 位' : '第 N 条'}
              onChange={(e) => setParam(e.target.value)}
              aria-label={kind === 'move' ? '目标位置' : '新条号'}
            />
          )}
          <button className="small" onClick={runPreview} disabled={articles.length === 0}>
            开始预演
          </button>
        </div>
        {error && <div className="sandbox-error">{error}</div>}
        {!sandbox && (
          <div className="impact-hint">
            在文档克隆上预演一次条级删除 / 移位 / 换号：列出将被改写的引用与将新增 / 消失的断链、循环问题，
            确认无误后可一步应用。预演本身不改动正文与撤销历史。
          </div>
        )}
      </div>

      {sandbox && (
        <div className="sandbox-result">
          <div className="sandbox-meta">
            <strong>{sandbox.label}</strong>
            <span>
              生成于 {formatTime(sandbox.createdAt)} · 正文版本 #{sandbox.docRevision}
            </span>
          </div>

          {sandboxStale && (
            <div className="impact-stale">
              正文或歧义确认记录已变化，本预演已失效，禁止应用。请放弃后按最新状态重新预演。
            </div>
          )}

          <div className="sandbox-section">
            <div className="sandbox-section-head">
              将被改写的引用（{sandbox.changes.length} 处）
            </div>
            {sandbox.changes.length === 0 && (
              <div className="impact-hint">没有引用需要改写。</div>
            )}
            {changeGroups.map((group) => (
              <div className="sandbox-group" key={group.nodeId}>
                <button
                  className="sandbox-group-head"
                  onClick={() => jump({ nodeId: group.nodeId, start: 0, end: 1 })}
                  title="点击定位当前正文中的来源节点"
                >
                  {labelOfNode(analysis, group.nodeId)}
                </button>
                {group.items.map((change) => (
                  <button
                    key={change.refKey}
                    className="sandbox-row"
                    onClick={() => jump(sandboxRewriteJump(change, analysis))}
                    title="点击定位当前正文"
                  >
                    <span className="sandbox-raw">{change.raw}</span>
                    <span className="sandbox-arrow">→</span>
                    <span className="sandbox-new">{change.text}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {sandbox.skipped.length > 0 && (
            <div className="sandbox-section">
              <div className="sandbox-section-head">
                不自动改写的引用（{sandbox.skipped.length} 处）
              </div>
              {sandbox.skipped.map((s, i) => (
                <button
                  key={`${s.nodeId}:${i}`}
                  className="sandbox-row sandbox-row-skip"
                  onClick={() => jump(sandboxSkippedJump(s, analysis))}
                  title="点击定位当前正文"
                >
                  <span className="sandbox-raw">{s.raw}</span>
                  <span className="sandbox-reason">{s.reason}</span>
                </button>
              ))}
            </div>
          )}

          <div className="sandbox-section">
            <div className="sandbox-section-head">
              断链 / 循环问题变化（新增 {sandbox.issuesAdded.length} · 消失{' '}
              {sandbox.issuesRemoved.length}）
            </div>
            {sandbox.issuesAdded.length === 0 && sandbox.issuesRemoved.length === 0 && (
              <div className="impact-hint">断链与循环问题无增减。</div>
            )}
            {sandbox.issuesAdded.length > 0 && (
              <div className="sandbox-issues">
                <div className="sandbox-issues-tag tag-added">将新增</div>
                {sandbox.issuesAdded.map((issue) => (
                  <IssueRow key={issue.key} issue={issue} onJump={jump} />
                ))}
              </div>
            )}
            {sandbox.issuesRemoved.length > 0 && (
              <div className="sandbox-issues">
                <div className="sandbox-issues-tag tag-removed">将消失</div>
                {sandbox.issuesRemoved.map((issue) => (
                  <IssueRow key={issue.key} issue={issue} onJump={jump} />
                ))}
              </div>
            )}
          </div>

          <div className="sandbox-actions">
            <button
              className="sandbox-apply"
              disabled={sandboxStale}
              title={sandboxStale ? '预演已失效，禁止应用' : '把该操作及全部引用改写作为一步提交'}
              onClick={() => store.applySandboxPreview()}
            >
              ✓ 应用此预演（一步提交，可整体撤销）
            </button>
            <button className="small" onClick={() => store.discardSandboxPreview()}>
              放弃预演
            </button>
          </div>

          <div className="impact-note">
            预演在文档克隆上复用结构改写与问题分析逻辑，未改动正文与撤销历史；
            应用后该操作及全部引用改写为一步，可用「↶ 撤销 / ↷ 重做」整体恢复。
          </div>
        </div>
      )}

      <div className="panel-footer">
        选择条款与操作后点「开始预演」；结果行可点击定位当前正文。
      </div>
    </div>
  );
}

function IssueRow({ issue, onJump }: { issue: Issue; onJump: (j: SandboxJump | null) => void }) {
  const { store } = useApp();
  const { analysis } = store.getSnapshot();
  const target = sandboxIssueJump(issue, analysis);
  return (
    <button
      className={`sandbox-row sandbox-issue ${issue.type === 'cycle' ? 'is-cycle' : 'is-broken'}`}
      disabled={!target}
      onClick={() => onJump(target)}
      title={target ? '点击定位当前正文' : '源节点已删除，不可跳转'}
    >
      <span className="sandbox-issue-icon">{ISSUE_ICON[issue.type] ?? '⚠'}</span>
      <span className="sandbox-issue-msg">{issue.message}</span>
    </button>
  );
}
