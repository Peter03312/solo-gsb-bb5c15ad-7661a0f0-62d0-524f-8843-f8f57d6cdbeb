import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import { useSelectionGesture } from '../lib/selection';
import type { RefOccurrence } from '../../shared/model';

const STATUS_TITLE: Record<string, string> = {
  ok: '引用有效 → 点击跳转到目标',
  broken: '断链',
  ambiguous: '歧义引用',
};

export function RefInline({
  occurrence,
  highlight,
  annotationCovered = false,
  annotationActive = false,
}: {
  occurrence: RefOccurrence;
  highlight?: boolean;
  annotationCovered?: boolean;
  annotationActive?: boolean;
}) {
  const { store, highlighter } = useApp();
  const hl = useHighlighter(highlighter);
  const { resolution, span } = occurrence;
  const { analysis } = store.getSnapshot();
  /** 识别拖选 / 双击选词收尾落在 chip 上的 click，避免误跳转、误关浮层 */
  const gesture = useSelectionGesture();

  const isCombined = span.kind === 'articleList' || span.kind === 'articleRange';
  const targetIds =
    resolution.targetIds ?? (resolution.targetId ? [resolution.targetId] : []);
  const targetId = resolution.targetId ?? targetIds[0] ?? null;
  const targetArticle = targetId ? analysis.placement[targetId]?.article.id : null;
  const sourceArticle = analysis.placement[occurrence.nodeId]?.article.id;
  const nodeSelf = !isCombined && resolution.status === 'ok' && targetId === occurrence.nodeId;
  const articleSelf =
    resolution.status === 'ok' &&
    ((span.kind === 'absolute' &&
      targetArticle !== undefined &&
      targetArticle === sourceArticle) ||
      (isCombined &&
        targetIds.some((id) => analysis.placement[id]?.article.id === sourceArticle)));
  const selfRef = nodeSelf || articleSelf;

  const statusClass =
    resolution.status === 'broken'
      ? 'ref-broken'
      : resolution.status === 'ambiguous'
        ? 'ref-ambiguous'
        : selfRef
          ? 'ref-self'
          : resolution.ambiguity
            ? 'ref-confirmed'
            : 'ref-ok';

  const active = hl.hoverRefKey === occurrence.key || hl.activeRefKey === occurrence.key;

  const title =
    resolution.status === 'broken'
      ? isCombined
        ? `组合引用部分缺失：${resolution.reason ?? '部分目标不存在'}（整段不会自动改写）`
        : `断链：${resolution.reason ?? '目标不存在'}`
      : resolution.status === 'ambiguous'
        ? `歧义：${resolution.reason ?? '存在多个候选，需在右侧确认'}`
        : selfRef
          ? '自引用'
          : resolution.ambiguity
            ? `已确认的歧义引用 → ${resolution.canonical ?? ''}`
            : isCombined
              ? `组合引用 → ${resolution.canonical ?? ''}（点击定位第一个目标）`
              : STATUS_TITLE.ok;

  return (
    <button
      type="button"
      className={`ref-chip ${statusClass} ${active ? 'ref-active' : ''} ${highlight ? 'ref-in-sentence' : ''} ${annotationCovered ? 'ref-has-ann' : ''} ${annotationActive ? 'ref-ann-active' : ''}`}
      title={title}
      onMouseEnter={() => highlighter.hoverRef(occurrence.key, targetIds)}
      onMouseLeave={() => highlighter.hoverRef(null, null)}
      onFocus={() => highlighter.hoverRef(occurrence.key, targetIds)}
      onBlur={() => highlighter.hoverRef(null, null)}
      onMouseDown={gesture.onMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        // 拖选 / 双击选词收尾落在 chip 上时不跳转，保持批注浮层；
        // 普通单击（未产生选区）仍按原行为跳转到引用目标
        if (gesture.isTailClick(e)) return;
        if (targetId && resolution.status === 'ok') {
          highlighter.jumpTo(targetId);
        }
      }}
    >
      {span.raw}
    </button>
  );
}
