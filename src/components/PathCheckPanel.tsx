import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { shortArticleLabel, labelOfNode } from '../lib/labels';
import {
  articleLabelOf,
  findReferencePath,
  type PathCheckResult,
  type PathHop,
} from '../lib/pathfind';

/**
 * 引用路径核对：选起点条与终点条，在当前已确认的条级引用边上找一条跳数最少的有向路径。
 * 结果随 store 每次提交（正文 / 结构 / 歧义确认变化）经 useMemo 即时重算，
 * 所有句子与偏移都取自当前分析——不缓存旧结果，因此不会展示旧证据。
 */
export function PathCheckPanel() {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis } = store.getSnapshot();

  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');

  const articles = analysis.articles;
  const sourceExists = Boolean(sourceId && analysis.nodes[sourceId]);
  const targetExists = Boolean(targetId && analysis.nodes[targetId]);
  const ready = Boolean(sourceExists && targetExists);

  // 随当前分析即时重算；依赖 analysis 对象——正文或歧义确认变化时 store 重建 analysis
  const result: PathCheckResult | null = useMemo(
    () => (ready ? findReferencePath(analysis, sourceId, targetId) : null),
    [analysis, sourceId, targetId, ready],
  );

  const swap = () => {
    setSourceId(targetId);
    setTargetId(sourceId);
  };

  const articleOptions = (selected: string) => (
    <>
      <option value="">选择条款…</option>
      {articles.map((a) => (
        <option key={a.id} value={a.id}>
          {shortArticleLabel(a.ordinal, a.suffix)}
          {a.title ? ` ${a.title}` : ''}
        </option>
      ))}
      {selected && !analysis.nodes[selected] && (
        <option value={selected}>（已删除的条款）</option>
      )}
    </>
  );

  return (
    <div className="pathcheck-panel">
      <div className="pathcheck-builder">
        <div className="pathcheck-builder-head">
          <span className="impact-title">引用路径核对</span>
          <span className="pathcheck-builder-note">在已确认的条级引用中找最短有向路径</span>
        </div>
        <div className="pathcheck-form">
          <label className="pathcheck-field">
            <span className="pathcheck-field-label">起点条</span>
            <select
              className="impact-select"
              value={sourceExists ? sourceId : ''}
              onChange={(e) => setSourceId(e.target.value)}
              aria-label="选择路径起点条款"
            >
              {articleOptions(sourceId)}
            </select>
          </label>
          <button
            className="small pathcheck-swap"
            onClick={swap}
            disabled={!sourceId && !targetId}
            title="交换起点与终点（路径方向不变，仅交换选择）"
          >
            ⇅
          </button>
          <label className="pathcheck-field">
            <span className="pathcheck-field-label">终点条</span>
            <select
              className="impact-select"
              value={targetExists ? targetId : ''}
              onChange={(e) => setTargetId(e.target.value)}
              aria-label="选择路径终点条款"
            >
              {articleOptions(targetId)}
            </select>
          </label>
        </div>

        {articles.length === 0 ? (
          <div className="impact-hint">导入条款后在此核对两条之间的引用路径。</div>
        ) : (
          <div className="impact-hint">
            选择起点条与终点条后，基于当前已确认的条级引用边寻找跳数最少的有向路径；
            组合引用的每个已解析目标各作为一条边参与，同一条对的多处引用按正文顺序取最先出现的一句作为证据。
          </div>
        )}
      </div>

      {(sourceId || targetId) && !ready && (
        <div className="pathcheck-gone">
          {!sourceExists && sourceId ? '起点条款已被删除，请重新选择。' : ''}
          {!targetExists && targetId ? '终点条款已被删除，请重新选择。' : ''}
        </div>
      )}

      {result && <PathResult result={result} />}

      <div className="panel-footer">
        逐跳列出来源条、引用原句与目标条；点击来源句定位并高亮正文；结果按当前正文与歧义确认实时重算，不保留旧证据。
      </div>
    </div>
  );
}

function PathResult({ result }: { result: PathCheckResult }) {
  const { store, highlighter } = useApp();
  const { doc } = store.getSnapshot();

  const sourceArticle = doc.root.find((a) => a.id === result.sourceId);
  const targetArticle = doc.root.find((a) => a.id === result.targetId);
  const sourceLabel = sourceArticle
    ? articleLabelOf(sourceArticle)
    : result.kind === 'missing-endpoint'
      ? '（已删除的条款）'
      : '';
  const targetLabel = targetArticle
    ? articleLabelOf(targetArticle)
    : result.kind === 'missing-endpoint'
      ? '（已删除的条款）'
      : '';

  if (result.kind === 'missing-endpoint') {
    return (
      <div className="pathcheck-body">
        <div className="pathcheck-meta">
          <span className="pathcheck-endpoint">{sourceLabel}</span>
          <span className="pathcheck-arrow">→</span>
          <span className="pathcheck-endpoint">{targetLabel}</span>
        </div>
        <div className="pathcheck-nopath">
          {result.missing === 'source' ? '起点条款' : '终点条款'}已从当前文档删除，无法核对路径，请重新选择。
        </div>
      </div>
    );
  }

  if (result.kind === 'same') {
    return (
      <div className="pathcheck-body">
        <div className="pathcheck-meta">
          <span className="pathcheck-endpoint">{sourceLabel}</span>
          <span className="pathcheck-arrow">→</span>
          <span className="pathcheck-endpoint">{targetLabel}</span>
        </div>
        <div className="pathcheck-same">起点与终点是同一条，跳数为 0，无需跨条引用。</div>
      </div>
    );
  }

  if (result.kind === 'no-path') {
    return (
      <div className="pathcheck-body">
        <div className="pathcheck-meta">
          <button
            className="link-btn pathcheck-endpoint-link"
            onClick={() => highlighter.jumpTo(result.sourceId)}
            title="点击定位正文该条"
          >
            {sourceLabel}
          </button>
          <span className="pathcheck-arrow">→</span>
          <button
            className="link-btn pathcheck-endpoint-link"
            onClick={() => highlighter.jumpTo(result.targetId)}
            title="点击定位正文该条"
          >
            {targetLabel}
          </button>
        </div>
        <div className="pathcheck-nopath">
          不存在从
          <strong> {sourceLabel} </strong>
          到
          <strong> {targetLabel} </strong>
          的有向引用路径。
        </div>
        <div className="pathcheck-nopath-sub">
          从起点沿当前已确认引用最多可达 {result.reachedCount} 条（不含起点本身）
          {result.dedupedEdges > 0 ? `；循环回指已去重 ${result.dedupedEdges} 次，未重复搜索` : ''}
          ；未确认的歧义引用不作为边。
        </div>
      </div>
    );
  }

  // result.kind === 'path'
  return (
    <div className="pathcheck-body">
      <div className="pathcheck-summary">
        <button
          className="link-btn pathcheck-endpoint-link"
          onClick={() => highlighter.jumpTo(result.sourceId)}
          title="点击定位正文该条"
        >
          {sourceLabel}
        </button>
        <span className="pathcheck-arrow">→</span>
        <button
          className="link-btn pathcheck-endpoint-link"
          onClick={() => highlighter.jumpTo(result.targetId)}
          title="点击定位正文该条"
        >
          {targetLabel}
        </button>
        <span className="pathcheck-summary-meta">
          最短路径 · <strong>{result.hopsCount}</strong> 跳
          {result.dedupedEdges > 0 ? ` · 循环回指去重 ${result.dedupedEdges}` : ''}
        </span>
      </div>

      <ol className="pathcheck-hops">
        {result.hops.map((hop, i) => (
          <PathHopRow
            key={`${hop.refKey}:${i}`}
            hop={hop}
            index={i}
            isLast={i === result.hops.length - 1}
          />
        ))}
      </ol>

      <div className="pathcheck-note">
        边均为当前已确认的条级引用（含组合引用解析出的各目标）；证据按正文顺序选取，
        正文或歧义确认变化后本路径立即按最新解析重算。
      </div>
    </div>
  );
}

function PathHopRow({
  hop,
  index,
  isLast,
}: {
  hop: PathHop;
  index: number;
  isLast: boolean;
}) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const srcArticle = analysis.placement[hop.sourceArticleId]?.article;
  const dstArticle = analysis.placement[hop.targetArticleId]?.article;
  const sourceLocation = labelOfNode(analysis, hop.sourceNodeId);

  // 来源句拆成「引用前 / 引用原句 / 引用后」三段，引用原文加粗
  const before = hop.sentenceText.slice(0, hop.refInSentenceStart);
  const refText = hop.sentenceText.slice(hop.refInSentenceStart, hop.refInSentenceEnd);
  const after = hop.sentenceText.slice(hop.refInSentenceEnd);

  const jumpToSentence = () => {
    highlighter.jumpTo(
      hop.sourceNodeId,
      { start: hop.sentenceStart, end: hop.sentenceEnd },
      hop.refKey,
    );
  };

  return (
    <li className="pathcheck-hop">
      <div className="pathcheck-hop-head">
        <span className="pathcheck-hop-index">第 {index + 1} 跳</span>
        <button
          className="pathcheck-hop-article"
          onClick={() => highlighter.jumpTo(hop.sourceArticleId)}
          title="定位来源条"
        >
          {srcArticle ? articleLabelOf(srcArticle) : '（来源条已删除）'}
        </button>
        <span className="pathcheck-hop-loc">{sourceLocation}</span>
      </div>
      <button
        className="pathcheck-sentence"
        onClick={jumpToSentence}
        title="点击定位并高亮正文来源句"
      >
        <span className="pathcheck-sentence-quote">“</span>
        {before}
        <strong className="pathcheck-sentence-ref">{refText}</strong>
        {after}
        <span className="pathcheck-sentence-quote">”</span>
        {hop.combined && <span className="pathcheck-combined-tag">组合引用</span>}
      </button>
      <div className="pathcheck-hop-target">
        <span className="pathcheck-hop-arrow">↳</span>
        <button
          className="pathcheck-hop-target-link"
          onClick={() => highlighter.jumpTo(hop.targetNodeId)}
          title="定位目标节点"
        >
          {dstArticle ? articleLabelOf(dstArticle) : '（目标条已删除）'}
          {hop.targetNodeId !== hop.targetArticleId ? `（${labelOfNode(analysis, hop.targetNodeId)}）` : ''}
        </button>
        {isLast && <span className="pathcheck-end-badge">终点</span>}
      </div>
    </li>
  );
}
