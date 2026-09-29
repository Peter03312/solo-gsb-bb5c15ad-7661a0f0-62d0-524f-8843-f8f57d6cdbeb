import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import { shortArticleLabel } from '../lib/labels';
import { formatOrdinal } from '../lib/numeral';
import { computeImpact, type ImpactReport } from '../lib/impact';

const W = 520;
const H = 560;

export function RelationView() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const hl = useHighlighter(highlighter);
  const { analysis, doc } = store.getSnapshot();

  // 引用影响分析：会话内临时状态（不持久化、不修改正文、不进入撤销历史）
  const [targetId, setTargetId] = useState<string | null>(null);
  const [report, setReport] = useState<{ data: ImpactReport; updatedAt: number } | null>(null);

  const selectTarget = (id: string | null) => {
    setTargetId(id);
    if (!id) {
      setReport(null);
      return;
    }
    setReport({ data: computeImpact(analysis, id), updatedAt: doc.updatedAt });
  };

  const refreshReport = () => {
    if (!targetId) return;
    if (!analysis.nodes[targetId]) {
      // 目标条款已删除：结果失效，等待用户重新选择或清空
      setReport(null);
      return;
    }
    setReport({ data: computeImpact(analysis, targetId), updatedAt: doc.updatedAt });
  };

  const clearSelection = () => {
    setTargetId(null);
    setReport(null);
  };

  const targetGone = Boolean(targetId && !analysis.nodes[targetId!]);
  const stale = Boolean(report && report.updatedAt !== doc.updatedAt);

  const positions = useMemo(() => {
    const n = analysis.articles.length;
    const map = new Map<string, { x: number; y: number }>();
    const cx = W / 2;
    const cy = H / 2;
    const rx = Math.min(W / 2 - 70, 30 + n * 8);
    const ry = Math.min(H / 2 - 80, 40 + n * 6);
    analysis.articles.forEach((a, i) => {
      const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
      map.set(a.id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    });
    return map;
  }, [analysis.articles]);

  // 聚合条级边（同条对只画一条，记录成员 refKey）
  const selfRefKeys = useMemo(
    () => new Set(analysis.issues.filter((i) => i.type === 'self' && i.refKey).map((i) => i.refKey!)),
    [analysis.issues],
  );
  const edgeGroups = useMemo(() => {
    const map = new Map<
      string,
      { from: string; to: string; keys: string[]; selfProblem: boolean }
    >();
    for (const e of analysis.edges) {
      const k = `${e.sourceArticleId}>${e.targetArticleId}`;
      const g =
        map.get(k) ?? {
          from: e.sourceArticleId,
          to: e.targetArticleId,
          keys: [],
          selfProblem: false,
        };
      g.keys.push(e.refKey);
      if (selfRefKeys.has(e.refKey)) g.selfProblem = true;
      map.set(k, g);
    }
    // 条内相对引用（本条/前款等）不是问题，不作为自环展示；只保留绝对自指
    return [...map.values()].filter((g) => g.from !== g.to || g.selfProblem);
  }, [analysis.edges, selfRefKeys]);

  const brokenRefs = analysis.occurrences.filter((o) => o.resolution.status === 'broken');

  const hoveredKey = hl.hoverRefKey ?? hl.activeRefKey;
  const activeArticle = hl.activeNodeId
    ? analysis.placement[hl.activeNodeId]?.article.id
    : null;

  return (
    <div className="relation-view">
      <div className="graph-legend">
        <span><i className="dot edge-ok" /> 有效引用</span>
        <span><i className="dot edge-self" /> 自引用</span>
        <span><i className="dot edge-cycle" /> 循环</span>
        <span><i className="dot node-broken-dot" /> 条内含断链</span>
      </div>

      {analysis.articles.length === 0 ? (
        <div className="empty-hint">导入条款后在此查看引用关系图。</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="graph-svg" role="img" aria-label="条级引用关系图">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
            </marker>
            <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
            </marker>
          </defs>

          {edgeGroups.map((g) => {
            const p1 = positions.get(g.from)!;
            const p2 = positions.get(g.to)!;
            const isSelf = g.from === g.to;
            const isHot = hoveredKey && g.keys.includes(hoveredKey);
            const inCycle = analysis.issues.some(
              (i) =>
                i.type === 'cycle' &&
                i.cycleNodeIds?.includes(g.from) &&
                i.cycleNodeIds?.includes(g.to),
            );
            const cls = isSelf ? 'edge-self' : inCycle ? 'edge-cycle' : 'edge-ok';
            if (isSelf) {
              return (
                <path
                  key={`${g.from}-${g.to}`}
                  className={`graph-edge ${cls} ${isHot ? 'hot' : ''}`}
                  d={`M ${p1.x} ${p1.y - 16} c -34 -8 -34 -44 0 -52`}
                  markerEnd="url(#arrow)"
                  onMouseEnter={() => highlighter.hoverRef(g.keys[0], [g.from])}
                  onMouseLeave={() => highlighter.hoverRef(null, null)}
                  onClick={() =>
                    highlighter.jumpTo(
                      analysis.edges.find((e) => e.refKey === g.keys[0])!.sourceNodeId,
                    )
                  }
                />
              );
            }
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy) || 1;
            const gap = 22;
            const sx = p1.x + (dx / len) * gap;
            const sy = p1.y + (dy / len) * gap;
            const ex = p2.x - (dx / len) * gap;
            const ey = p2.y - (dy / len) * gap;
            // 双向边弯曲
            const reverse = edgeGroups.some((o) => o.from === g.to && o.to === g.from);
            const mx = (sx + ex) / 2 - (dy / len) * (reverse ? 26 : 0);
            const my = (sy + ey) / 2 + (dx / len) * (reverse ? 26 : 0);
            return (
              <path
                key={`${g.from}>${g.to}`}
                className={`graph-edge ${cls} ${isHot ? 'hot' : ''}`}
                d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`}
                markerEnd={isHot ? 'url(#arrow-hot)' : 'url(#arrow)'}
                onMouseEnter={() => highlighter.hoverRef(g.keys[0], [g.to])}
                onMouseLeave={() => highlighter.hoverRef(null, null)}
                onClick={() =>
                  highlighter.jumpTo(
                    analysis.edges.find((e) => e.refKey === g.keys[0])!.sourceNodeId,
                  )
                }
              />
            );
          })}

          {analysis.articles.map((a) => {
            const p = positions.get(a.id)!;
            const hasBroken = brokenRefs.some(
              (o) => analysis.placement[o.nodeId]?.article.id === a.id,
            );
            const inCycle = analysis.issues.some(
              (i) => i.type === 'cycle' && i.cycleNodeIds?.includes(a.id),
            );
            const cls = hasBroken
              ? 'node-broken'
              : inCycle
                ? 'node-cycle'
                : 'node-normal';
            return (
              <g
                key={a.id}
                className={`graph-node ${cls} ${activeArticle === a.id ? 'active' : ''} ${targetId === a.id ? 'impact-target' : ''}`}
                transform={`translate(${p.x}, ${p.y})`}
                onMouseEnter={() => highlighter.activateNode(a.id)}
                onMouseLeave={() => highlighter.activateNode('')}
                onClick={() => {
                  // 点击节点：选为引用影响分析目标，并定位到正文该条
                  selectTarget(a.id);
                  highlighter.jumpTo(a.id);
                }}
              >
                <circle r={20} />
                <text textAnchor="middle" dy="4" className="graph-node-text">
                  {formatOrdinal(a.ordinal)}
                </text>
                <text textAnchor="middle" y={36} className="graph-node-label">
                  {shortArticleLabel(a.ordinal, a.suffix)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {analysis.articles.length > 0 && (
        <div className="impact-panel">
          <div className="impact-head">
            <span className="impact-title">引用影响分析</span>
            <select
              className="impact-select"
              value={targetId ?? ''}
              onChange={(e) => selectTarget(e.target.value || null)}
              aria-label="选择影响分析目标条款"
            >
              <option value="">选择条款…</option>
              {analysis.articles.map((a) => (
                <option key={a.id} value={a.id}>
                  {shortArticleLabel(a.ordinal, a.suffix)}
                  {a.title ? ` ${a.title}` : ''}
                </option>
              ))}
              {targetGone && targetId && (
                <option value={targetId}>（已删除的条款）</option>
              )}
            </select>
            <button className="small" onClick={refreshReport} disabled={!targetId || targetGone}>
              刷新
            </button>
            <button className="small" onClick={clearSelection} disabled={!targetId && !report}>
              清空选择
            </button>
          </div>

          {!targetId && (
            <div className="impact-hint">
              点击图中节点或从下拉框选择条款，分析哪些条款直接 / 间接引用了它。
            </div>
          )}

          {targetGone && (
            <div className="impact-stale">目标条款已被删除，分析结果失效，请重新选择或清空。</div>
          )}

          {stale && !targetGone && (
            <div className="impact-stale">
              正文已变更，以下结果基于旧解析图。
              <button className="link-btn" onClick={refreshReport}>
                立即刷新
              </button>
            </div>
          )}

          {report && !targetGone && (
            <div className="impact-result">
              <div className="impact-summary">
                共 <strong>{report.data.total}</strong> 个条款引用
                「{shortArticleLabel(
                  analysis.nodes[report.data.targetId]?.ordinal ?? 0,
                  analysis.nodes[report.data.targetId]?.suffix,
                )}」（{report.data.layers.length} 层）
                {report.data.cycleCount > 0 && (
                  <span className="impact-cycle-note"> · {report.data.cycleCount} 个处于循环</span>
                )}
              </div>

              {report.data.targetInCycle && (
                <div className="impact-cycle-line">
                  ↻ 目标条款处于引用循环中，循环路径上的条款已标注。
                </div>
              )}

              {report.data.total === 0 && (
                <div className="impact-hint">没有条款引用该条款。</div>
              )}

              {report.data.layers.map((layer) => (
                <div className="impact-layer" key={layer.distance}>
                  <div className="impact-layer-head">
                    第{formatOrdinal(layer.distance)}层 ·{' '}
                    {layer.distance === 1 ? '直接引用' : '间接引用'}（{layer.entries.length} 条）
                  </div>
                  {layer.entries.map((entry) => {
                    const node = analysis.nodes[entry.articleId];
                    return (
                      <button
                        key={entry.articleId}
                        className="impact-row"
                        disabled={!node}
                        onClick={() => highlighter.jumpTo(entry.articleId)}
                        onMouseEnter={() => highlighter.activateNode(entry.articleId)}
                        onMouseLeave={() => highlighter.activateNode('')}
                        title={node ? '点击跳回正文该条' : '该条款已删除'}
                      >
                        <span className="impact-row-label">
                          {node
                            ? shortArticleLabel(node.ordinal, node.suffix)
                            : '（已删除）'}
                        </span>
                        {node?.title && <span className="impact-row-title">{node.title}</span>}
                        {entry.inCycle && <span className="impact-cycle-badge">↻ 循环</span>}
                      </button>
                    );
                  })}
                </div>
              ))}

              <div className="impact-note">
                基于当前确认后的解析图，结果仅用于当前会话，不修改正文、不写入撤销历史；
                同一条款只按最短距离列出一次
                {report.data.dedupedPaths > 0
                  ? `（已去重 ${report.data.dedupedPaths} 条重复 / 循环路径）`
                  : ''}
                。
              </div>
            </div>
          )}
        </div>
      )}

      <div className="panel-footer">
        悬停节点可定位正文条目；点击节点选为影响分析目标并定位正文；悬停或点击边可跳转到产生引用的源句。
      </div>
    </div>
  );
}
