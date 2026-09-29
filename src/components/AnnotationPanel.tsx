import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { Annotation, AnnotationCandidate } from '../../shared/model';
import { labelOfNode } from '../lib/labels';
import { REVIEW_REASON_TEXT } from '../lib/annotations';

type Filter = 'all' | 'anchored' | 'review';

export function AnnotationPanel({
  focusSignal,
  onConsumeFocus,
}: {
  /** 外部（正文批注标记）请求聚焦的批注 id */
  focusSignal: { id: string; nonce: number } | null;
  onConsumeFocus: () => void;
}) {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { annotations, analysis } = store.getSnapshot();
  const [filter, setFilter] = useState<Filter>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrollSignal, setScrollSignal] = useState<{ id: string; nonce: number } | null>(null);

  const sorted = useMemo(() => {
    const list = [...annotations];
    // 待复核优先，其次按更新时间倒序
    list.sort((a, b) => {
      if ((a.status === 'review') !== (b.status === 'review')) {
        return a.status === 'review' ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt;
    });
    return list;
  }, [annotations]);

  const reviewCount = annotations.filter((a) => a.status === 'review').length;
  const visible = filter === 'all' ? sorted : sorted.filter((a) => a.status === filter);

  // 正文点击批注标记时切换筛选并选中该行
  useEffect(() => {
    if (!focusSignal) return;
    setActiveId(focusSignal.id);
    setFilter('all');
    setScrollSignal({ id: focusSignal.id, nonce: focusSignal.nonce });
    onConsumeFocus();
  }, [focusSignal, onConsumeFocus]);

  // 等待筛选切换导致的重渲染后再滚动到对应行
  useEffect(() => {
    if (!scrollSignal) return;
    const el = document.querySelector(`[data-ann-row="${CSS.escape(scrollSignal.id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [scrollSignal, visible.length]);

  return (
    <div className="ann-panel">
      <div className="issue-filters ann-filters">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          全部 {annotations.length}
        </button>
        <button
          className={filter === 'anchored' ? 'active' : ''}
          disabled={annotations.length - reviewCount === 0}
          onClick={() => setFilter('anchored')}
        >
          ✓ 已定位 {annotations.length - reviewCount}
        </button>
        <button
          className={`ann-review-btn ${filter === 'review' ? 'active' : ''}`}
          disabled={reviewCount === 0}
          onClick={() => setFilter('review')}
        >
          ⚠ 待复核 {reviewCount}
        </button>
      </div>

      <div className="issue-list ann-list">
        {visible.length === 0 && (
          <div className="empty-hint">
            {annotations.length === 0
              ? '在正文中选取条/款/项片段，松开鼠标后点击「添加批注」即可创建。'
              : '该状态下暂无批注。'}
          </div>
        )}
        {visible.map((a) => (
          <AnnotationRow
            key={a.id}
            annotation={a}
            active={activeId === a.id}
            nodeLabel={labelOfNode(analysis, a.nodeId)}
            onActivate={() => setActiveId(a.id)}
          />
        ))}
      </div>

      <div className="panel-footer">
        批注锚定于稳定节点 ID 与前后文；正文调整后自动重定位，失败时保留候选供复核。
      </div>
    </div>
  );
}

function AnnotationRow({
  annotation,
  active,
  nodeLabel,
  onActivate,
}: {
  annotation: Annotation;
  active: boolean;
  nodeLabel: string;
  onActivate: () => void;
}) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.content);
  const [showCandidates, setShowCandidates] = useState(false);

  useEffect(() => {
    setDraft(annotation.content);
  }, [annotation.content]);

  const nodeExists = Boolean(analysis.nodes[annotation.nodeId]);
  const isReview = annotation.status === 'review';

  const jump = () => {
    onActivate();
    highlighter.jumpToAnnotation(annotation.id, annotation.nodeId, {
      start: annotation.start,
      end: annotation.end,
    });
  };

  const saveEdit = () => {
    if (draft.trim()) {
      store.updateAnnotation(annotation.id, { content: draft.trim() });
      setEditing(false);
    }
  };

  const remove = () => {
    if (confirm('确定删除该批注？此操作可通过撤销恢复。')) {
      store.deleteAnnotation(annotation.id);
    }
  };

  const quoteText = nodeExists
    ? analysis.nodes[annotation.nodeId].text.slice(annotation.start, annotation.end)
    : annotation.quote;

  return (
    <div
      data-ann-row={annotation.id}
      className={`issue-row ann-row ann-${annotation.status} ${active ? 'ann-row-active' : ''}`}
    >
      <div className="issue-row-head">
        <span className={`ann-status-tag ${isReview ? 'is-review' : ''}`}>
          {isReview ? '⚠ 待复核' : '✓ 已定位'}
        </span>
        <span className="issue-source-label">
          {nodeExists ? nodeLabel : '（原节点已删除）'}
        </span>
      </div>

      <button
        className="issue-sentence ann-quote-btn"
        onClick={jump}
        title="跳转到正文片段"
      >
        “{quoteText.length > 60 ? quoteText.slice(0, 60) + '…' : quoteText || annotation.quote}”
      </button>

      {isReview && (
        <div className="ann-review-line">
          {REVIEW_REASON_TEXT[annotation.reason ?? 'missing']}
          {(annotation.candidates?.length ?? 0) > 0 && (
            <button
              className="link-btn subtle"
              onClick={() => setShowCandidates((v) => !v)}
            >
              {showCandidates ? '收起候选' : `查看 ${annotation.candidates!.length} 个候选位置`}
            </button>
          )}
        </div>
      )}

      {editing ? (
        <div className="ann-edit-box">
          <textarea
            className="ann-edit-input"
            value={draft}
            autoFocus
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveEdit();
              }
              if (e.key === 'Escape') {
                setDraft(annotation.content);
                setEditing(false);
              }
            }}
          />
          <div className="ann-edit-actions">
            <button
              className="small"
              onClick={() => {
                setDraft(annotation.content);
                setEditing(false);
              }}
            >
              取消
            </button>
            <button className="small primary" disabled={!draft.trim()} onClick={saveEdit}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="ann-content" onClick={jump}>
          {annotation.content}
        </div>
      )}

      {isReview && showCandidates && (
        <CandidateList annotation={annotation} />
      )}

      {!editing && (
        <div className="ann-row-actions">
          <button className="link-btn" onClick={() => setEditing(true)}>
            编辑
          </button>
          <button className="link-btn subtle" onClick={jump}>
            定位
          </button>
          <button className="link-btn subtle" onClick={remove}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function CandidateList({ annotation }: { annotation: Annotation }) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const candidates = annotation.candidates ?? [];

  const contextOf = (c: AnnotationCandidate): string => {
    const node = analysis.nodes[c.nodeId];
    if (!node) return '（节点已不存在）';
    const before = node.text.slice(Math.max(0, c.start - 10), c.start);
    const hit = node.text.slice(c.start, c.end);
    const after = node.text.slice(c.end, c.end + 10);
    return `${before ? '…' + before : ''}【${hit}】${after ? after + '…' : ''}`;
  };

  if (candidates.length === 0) {
    return <div className="ann-cand-box">无可用候选；可直接删除该批注，或在正文中重新选取。</div>;
  }

  return (
    <div className="ann-cand-box">
      <div className="candidate-title">候选位置（按前后文相似度排序）：</div>
      {candidates.map((c, i) => {
        const exists = Boolean(analysis.nodes[c.nodeId]);
        return (
          <div className="ann-cand-item" key={`${c.nodeId}:${c.start}:${i}`}>
            <button
              className="link-btn"
              disabled={!exists}
              onClick={() =>
                highlighter.jumpToAnnotation(annotation.id, c.nodeId, {
                  start: c.start,
                  end: c.end,
                })
              }
            >
              {exists ? labelOfNode(analysis, c.nodeId) : '（已删除节点）'}
            </button>
            <span className="ann-cand-ctx" title={contextOf(c)}>
              {contextOf(c)}
            </span>
            <button
              className="small primary"
              disabled={!exists}
              onClick={() => store.resolveAnnotation(annotation.id, c.nodeId, c.start, c.end)}
            >
              确认
            </button>
          </div>
        );
      })}
    </div>
  );
}
