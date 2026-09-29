import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Annotation,
  ClauseNode,
  RefOccurrence,
  TermHit,
} from '../../shared/model';
import { useApp, ANN_FOCUS_EVENT, TERM_FOCUS_EVENT } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import {
  boundaryOffset,
  domSeqAdapter,
  linearText,
  useSelectionGesture,
} from '../lib/selection';
import { RefInline } from './RefInline';

interface PendingSelection {
  start: number;
  end: number;
  /** 捕获选区时的引文（按原正文字符序列）；提交前据此确认选区仍有效 */
  quote: string;
  /** 浮层屏幕坐标（相对视口） */
  x: number;
  y: number;
}

export function NodeEditor({
  node,
  occurrences,
  isHead = false,
}: {
  node: ClauseNode;
  occurrences: RefOccurrence[];
  isHead?: boolean;
}) {
  const { store, highlighter } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.text);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const hl = useHighlighter(highlighter);
  const bodyRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef<HTMLDivElement>(null);
  const gesture = useSelectionGesture();

  useEffect(() => {
    if (!editing) setDraft(node.text);
  }, [node.text, editing]);

  const annotations = store.getSnapshot().annotations.filter((a) => a.nodeId === node.id);
  const termHits = store.getSnapshot().termHits.filter((h) => h.nodeId === node.id);

  // 问题跳转 / 批注跳转：滚动到节点
  useEffect(() => {
    if (hl.activeNodeId !== node.id || hl.focusNonce === 0) return;
    const el = bodyRef.current?.closest('[data-node-id]') as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [hl.activeNodeId, hl.focusNonce, node.id]);

  const save = () => {
    store.updateNodeText(node.id, draft);
    setEditing(false);
  };

  const captureSelection = () => {
    const sel = window.getSelection();
    const container = renderedRef.current;
    if (!sel || sel.rangeCount === 0 || !container || sel.isCollapsed || !sel.toString()) {
      setPending(null);
      return;
    }
    const range = sel.getRangeAt(0);
    // 仅接受两端都落在同一节点渲染容器内的选区：跨节点选区不写批注
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      setPending(null);
      return;
    }
    // 容器内文本按文档序拼接必须等于当前正文，否则渲染结构异常时不使用偏移
    if (linearText(domSeqAdapter, container) !== node.text) {
      setPending(null);
      return;
    }
    const s = boundaryOffset(
      domSeqAdapter,
      container,
      range.startContainer,
      range.startOffset,
    );
    const e = boundaryOffset(
      domSeqAdapter,
      container,
      range.endContainer,
      range.endOffset,
    );
    const start = s === null || e === null ? null : Math.min(s, e);
    const end = s === null || e === null ? null : Math.max(s, e);
    // 空选区、越界选区或引文与实际选中文字不符（正文已变化等）一律不弹浮层
    if (
      start === null ||
      end === null ||
      end <= start ||
      start < 0 ||
      end > node.text.length ||
      node.text.slice(start, end) !== sel.toString()
    ) {
      setPending(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setPending({
      start,
      end,
      quote: node.text.slice(start, end),
      x: Math.max(8, Math.min(rect.left + rect.width / 2 - 90, window.innerWidth - 200)),
      y: rect.top - 46,
    });
  };

  const isFocused = hl.activeNodeId === node.id;
  const sentence =
    hl.focusSentence && hl.focusSentence.nodeId === node.id ? hl.focusSentence : null;
  const focusAnn =
    hl.focusAnnotation && hl.focusAnnotation.nodeId === node.id
      ? hl.focusAnnotation
      : null;
  const focusTerm =
    hl.focusTerm && hl.focusTerm.nodeId === node.id ? hl.focusTerm : null;

  return (
    <div
      ref={bodyRef}
      className={`node-text ${isHead ? 'head-text' : ''} ${isFocused ? 'focused' : ''}`}
    >
      {editing ? (
        <div className="text-edit-wrap">
          <textarea
            className="text-edit"
            value={draft}
            autoFocus
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') {
                setDraft(node.text);
                setEditing(false);
              }
            }}
          />
          <div className="edit-hint">Ctrl+Enter 保存 · Esc 取消</div>
        </div>
      ) : (
        <div
          ref={renderedRef}
          className="rendered-text"
          onMouseDown={gesture.onMouseDown}
          onMouseUp={(e) => {
            // 在批注浮层内松开鼠标时不重新捕获（避免提交/取消时浮层闪动）
            if ((e.target as HTMLElement).closest('.ann-pop')) return;
            captureSelection();
          }}
          onClick={(e) => {
            // 拖选 / 双击选词收尾触发的 click 不进入编辑态、不触发标记跳转，
            // 保持批注浮层；单击未选中文本（选区手势前后无变化）仍按原行为编辑正文
            if (gesture.isTailClick(e)) {
              e.stopPropagation();
              return;
            }
            const annEl = (e.target as HTMLElement).closest('.ann-mark') as HTMLElement | null;
            if (annEl) {
              const id = annEl.dataset.annId;
              const ann = annotations.find((a) => a.id === id);
              if (ann) {
                highlighter.jumpToAnnotation(ann.id, ann.nodeId, {
                  start: ann.start,
                  end: ann.end,
                });
                window.dispatchEvent(
                  new CustomEvent(ANN_FOCUS_EVENT, { detail: ann.id }),
                );
              }
              return;
            }
            const termEl = (e.target as HTMLElement).closest('.term-mark') as HTMLElement | null;
            if (termEl) {
              const key = termEl.dataset.termKey;
              const hit = termHits.find((h) => h.key === key);
              if (hit) {
                highlighter.jumpToTerm(hit.key, hit.nodeId, {
                  start: hit.start,
                  end: hit.end,
                });
                window.dispatchEvent(new CustomEvent(TERM_FOCUS_EVENT, { detail: hit.key }));
              }
              return;
            }
            if ((e.target as HTMLElement).closest('.ref-chip')) return;
            setEditing(true);
          }}
          title="点击编辑正文；选取片段可添加批注"
        >
          <HighlightedText
            text={node.text}
            occurrences={occurrences}
            annotations={annotations}
            termHits={termHits}
            sentence={sentence}
            focusAnnotationId={focusAnn?.annotationId ?? null}
            focusTermKey={focusTerm?.termKey ?? null}
          />
        </div>
      )}
      {pending && !editing && (
        <SelectionPopover
          key={`${pending.start}-${pending.end}`}
          pending={pending}
          quote={pending.quote}
          onClose={() => setPending(null)}
          onSubmit={(content) => {
            // 提交前再次核对：正文变化导致区间或引文失效（跨节点/空/越界）时不写入批注
            if (
              pending.end <= pending.start ||
              pending.start < 0 ||
              pending.end > node.text.length ||
              node.text.slice(pending.start, pending.end) !== pending.quote
            ) {
              setPending(null);
              window.getSelection()?.removeAllRanges();
              return;
            }
            const id = store.addAnnotation(node.id, pending.start, pending.end, content);
            setPending(null);
            window.getSelection()?.removeAllRanges();
            if (id) {
              highlighter.jumpToAnnotation(id, node.id, {
                start: pending.start,
                end: pending.end,
              });
              window.dispatchEvent(new CustomEvent(ANN_FOCUS_EVENT, { detail: id }));
            }
          }}
        />
      )}
    </div>
  );
}

function SelectionPopover({
  pending,
  quote,
  onSubmit,
  onClose,
}: {
  pending: PendingSelection;
  quote: string;
  onSubmit: (content: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ann-pop')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const submit = () => {
    if (!content.trim()) return;
    onSubmit(content.trim());
  };

  return (
    <div
      className="ann-pop"
      style={{ position: 'fixed', left: pending.x, top: Math.max(8, pending.y), zIndex: 40 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ann-pop-quote" title={quote}>
        “{quote.length > 28 ? quote.slice(0, 28) + '…' : quote}”
      </div>
      <textarea
        ref={inputRef}
        className="ann-pop-input"
        placeholder="输入批注内容，Ctrl+Enter 保存"
        value={content}
        rows={2}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="ann-pop-actions">
        <button className="small" onClick={onClose}>
          取消
        </button>
        <button className="small primary" disabled={!content.trim()} onClick={submit}>
          添加批注
        </button>
      </div>
    </div>
  );
}

/** 覆盖 [start,end) 的批注（active 判定批注是否覆盖中点，含跨 chip 的拆分高亮） */
function covering(annotations: Annotation[], start: number, end: number) {
  const mid = (start + end) / 2;
  return annotations.filter((a) => a.start <= mid && a.end >= mid);
}

function HighlightedText({
  text,
  occurrences,
  annotations,
  termHits,
  sentence,
  focusAnnotationId,
  focusTermKey,
}: {
  text: string;
  occurrences: RefOccurrence[];
  annotations: Annotation[];
  termHits: TermHit[];
  sentence: { start: number; end: number } | null;
  focusAnnotationId: string | null;
  focusTermKey: string | null;
}) {
  const sorted = useMemo(
    () => [...occurrences].sort((a, b) => a.span.start - b.span.start),
    [occurrences],
  );

  // 仅渲染区间仍落在当前正文内的批注（待复核且无候选时不画标记）
  const renderable = useMemo(
    () => annotations.filter((a) => a.start >= 0 && a.end <= text.length && a.end > a.start),
    [annotations, text.length],
  );

  // 规范用语命中经扫描侧重叠消解，两两互不交叠；仅渲染仍落在正文区间内者
  const renderableTerms = useMemo(
    () =>
      [...termHits]
        .filter((h) => h.start >= 0 && h.end <= text.length && h.end > h.start)
        .sort((a, b) => a.start - b.start),
    [termHits, text.length],
  );

  // 引用边界 + 批注边界 + 规范命中边界 + 源句边界切分全文，每个文本段带上其覆盖标记
  const points = useMemo(() => {
    const set = new Set<number>([0, text.length]);
    for (const o of sorted) {
      set.add(o.span.start);
      set.add(o.span.end);
    }
    for (const a of renderable) {
      set.add(a.start);
      set.add(a.end);
    }
    for (const h of renderableTerms) {
      set.add(h.start);
      set.add(h.end);
    }
    if (sentence) {
      set.add(sentence.start);
      set.add(sentence.end);
    }
    return [...set].filter((p) => p >= 0 && p <= text.length).sort((x, y) => x - y);
  }, [sorted, renderable, renderableTerms, sentence, text.length]);

  if (!text) return <span className="placeholder-text">（空，点击添加正文）</span>;

  const refAt = (p: number) =>
    sorted.find((o) => o.span.start <= p && o.span.end > p) ?? null;
  const termAt = (p: number) =>
    renderableTerms.find((h) => h.start <= p && h.end > p) ?? null;

  const elements: React.ReactNode[] = [];
  const renderedRefs = new Set<string>();
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const covered = covering(renderable, start, end);
    const term = termAt(start);
    const inSentence = sentence ? start >= sentence.start && end <= sentence.end : false;
    const active = covered.some((a) => a.id === focusAnnotationId);
    const key = `r${i}`;
    const occ = refAt(start);
    if (occ) {
      if (!renderedRefs.has(occ.key)) {
        renderedRefs.add(occ.key);
        elements.push(
          <RefInline
            key={key}
            occurrence={occ}
            highlight={inSentence}
            annotationCovered={covered.length > 0}
            annotationActive={active}
          />,
        );
      }
      continue;
    }
    // 纯文本段：自内向外包裹 规范命中标记 → 批注标记 → 源句高亮
    let node: React.ReactNode = text.slice(start, end);
    if (term) {
      node = (
        <mark
          key={key}
          className={`term-mark ${term.key === focusTermKey ? 'term-active' : ''}`}
          data-term-key={term.key}
          title={`禁用变体「${term.variant}」→ 规范词「${term.canonical}」（见右侧规范用语审校）`}
        >
          {node}
        </mark>
      );
    }
    if (covered.length > 0) {
      node = (
        <mark
          key={`${key}-ann`}
          className={`ann-mark ann-${covered[0].status} ${active ? 'ann-active' : ''}`}
          data-ann-id={covered[0].id}
          title={`批注：${covered[0].content}`}
        >
          {node}
        </mark>
      );
    } else if (!term && inSentence) {
      node = (
        <mark key={`${key}-sen`} className="sentence-mark">
          {node}
        </mark>
      );
    }
    elements.push(node);
  }
  return <>{elements}</>;
}
