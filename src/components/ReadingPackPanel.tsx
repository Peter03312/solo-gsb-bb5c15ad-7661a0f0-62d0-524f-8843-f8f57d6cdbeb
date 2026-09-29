import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { shortArticleLabel } from '../lib/labels';
import { formatOrdinal } from '../lib/numeral';
import type { ClauseNode, NodePlacement } from '../../shared/model';
import {
  readingPackWarningJump,
  renderReadingPackText,
  type ReadingPack,
  type ReadingPackWarning,
} from '../lib/readingpack';

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 复制纯文本：优先 Clipboard API，回退临时 textarea + execCommand */
async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ReadingPackPanel() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, doc, readingPack, readingPackStale } = store.getSnapshot();

  const [articleId, setArticleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const articles = analysis.articles;
  const selectedExists = Boolean(articleId && analysis.nodes[articleId]);

  const generate = (id: string) => {
    setError(null);
    setCopyMsg(null);
    if (!id || !analysis.nodes[id]) {
      setError('请先选择起点条款');
      return;
    }
    const res = store.generateReadingPack(id);
    if (!res.ok) setError(res.error ?? '生成失败');
  };

  const regenerate = () => {
    setError(null);
    setCopyMsg(null);
    const res = store.regenerateReadingPack();
    if (!res.ok) setError(res.error ?? '重新生成失败');
  };

  const copyText = async () => {
    if (!readingPack || readingPackStale) return; // 失效阅读包禁止复制旧结果
    const ok = await copyPlainText(renderReadingPackText(readingPack, doc));
    setCopyMsg(
      ok ? { ok: true, text: '✓ 已复制纯文本' } : { ok: false, text: '复制失败，请手动选择文本复制' },
    );
  };

  const jumpWarning = (w: ReadingPackWarning) => {
    if (readingPackStale) return;
    const target = readingPackWarningJump(w, analysis);
    if (target) {
      highlighter.jumpTo(target.nodeId, { start: target.start, end: target.end }, target.refKey);
    }
  };

  return (
    <div className="rp-panel">
      <div className="rp-builder">
        <div className="rp-builder-head">
          <span className="impact-title">引用阅读包</span>
          <span className="rp-builder-note">沿引用方向收集依赖条款全文</span>
        </div>
        <div className="rp-form">
          <select
            className="impact-select"
            value={selectedExists ? articleId : ''}
            onChange={(e) => setArticleId(e.target.value)}
            aria-label="选择阅读包起点条款"
          >
            <option value="">选择条款…</option>
            {articles.map((a) => (
              <option key={a.id} value={a.id}>
                {shortArticleLabel(a.ordinal, a.suffix)}
                {a.title ? ` ${a.title}` : ''}
              </option>
            ))}
          </select>
          <button className="small" onClick={() => generate(articleId)} disabled={articles.length === 0}>
            生成阅读包
          </button>
          {readingPack && (
            <button className="small" onClick={() => store.clearReadingPack()}>
              清空
            </button>
          )}
        </div>
        {error && <div className="sandbox-error">{error}</div>}
        {!readingPack && (
          <div className="impact-hint">
            选定一条后，沿当前已确认的引用关系向目标方向逐层收集直接及间接依赖的条款，
            组合引用的每个已解析目标都参与收集；循环和多路径汇合只收录一次，
            按原文档顺序展示完整条款及其款、项（保留原编号与正文，不改写原文），
            并另列收录条款中的断链 / 歧义引用。
          </div>
        )}
      </div>

      {readingPack && (
        <ReadingPackBody
          pack={readingPack}
          stale={readingPackStale}
          onRegenerate={regenerate}
          onCopy={copyText}
          copyMsg={copyMsg}
          onJumpWarning={jumpWarning}
          onJumpArticle={(nodeId) => {
            if (!readingPackStale) highlighter.jumpTo(nodeId);
          }}
        />
      )}

      <div className="panel-footer">
        阅读包为会话内临时摘录，不修改正文、不写入撤销历史；点击条目或警告可跳回正文。
      </div>
    </div>
  );
}

function ReadingPackBody({
  pack,
  stale,
  onRegenerate,
  onCopy,
  copyMsg,
  onJumpWarning,
  onJumpArticle,
}: {
  pack: ReadingPack;
  stale: boolean;
  onRegenerate: () => void;
  onCopy: () => void;
  copyMsg: { ok: boolean; text: string } | null;
  onJumpWarning: (w: ReadingPackWarning) => void;
  onJumpArticle: (nodeId: string) => void;
}) {
  const { store } = useApp();
  const { doc, analysis } = store.getSnapshot();
  const byId = useMemo(() => new Map(doc.root.map((a) => [a.id, a])), [doc]);
  const source = byId.get(pack.sourceId);
  const brokenCount = pack.warnings.filter((w) => w.kind === 'broken').length;
  const ambCount = pack.warnings.length - brokenCount;

  return (
    <div className={`rp-result ${stale ? 'is-stale' : ''}`}>
      <div className="rp-meta">
        <div className="rp-meta-line">
          起点：
          <strong>
            {source ? shortArticleLabel(source.ordinal, source.suffix) : '（起点条款已删除）'}
          </strong>
          {source?.title ? <span className="rp-meta-title">【{source.title}】</span> : null}
        </div>
        <div className="rp-meta-sub">
          生成于 {formatTime(pack.createdAt)} · 正文版本 #{pack.docRevision} · 收录 {pack.total} 条
          {pack.maxDistance > 0 ? `（最远第 ${pack.maxDistance} 层依赖）` : ''}
          {pack.dedupedPaths > 0 ? ` · 去重 ${pack.dedupedPaths} 条循环 / 汇合路径` : ''}
        </div>
      </div>

      {stale && (
        <div className="impact-stale">
          正文或歧义确认已变化，本阅读包已过期。下方为旧摘录，跳转与复制已停用，请
          <button className="link-btn" onClick={onRegenerate}>
            重新生成
          </button>
          后再使用，不能复制旧结果。
        </div>
      )}

      <div className="rp-actions">
        <button className="rp-copy" onClick={onCopy} disabled={stale} title={stale ? '阅读包已失效，请重新生成' : '复制阅读包纯文本'}>
          📋 一键复制纯文本
        </button>
        <button className="small" onClick={onRegenerate}>
          重新生成
        </button>
        {copyMsg && <span className={copyMsg.ok ? 'rp-copy-ok' : 'rp-copy-fail'}>{copyMsg.text}</span>}
      </div>

      <div className="rp-disclaimer">
        以下为原文摘录，按原文档顺序排列、不改写原文；因末尾所列断链 / 歧义引用，
        摘录可能不完整，请勿将其视为自足文件。
      </div>

      <div className="rp-entries">
        {pack.entries.map((entry, idx) => {
          const article = byId.get(entry.articleId);
          if (!article) {
            return (
              <div key={`gone-${entry.articleId}-${idx}`} className="rp-entry rp-entry-gone">
                （收录条款已从当前文档删除）
              </div>
            );
          }
          const tag =
            entry.distance === 0
              ? '起点'
              : entry.distance === 1
                ? '直接依赖'
                : `第 ${entry.distance} 层间接`;
          return (
            <div key={entry.articleId} className="rp-entry">
              <button
                className="rp-entry-head"
                disabled={stale}
                onClick={() => onJumpArticle(article.id)}
                title={stale ? '阅读包已失效，请重新生成' : '点击跳回正文该条'}
              >
                <span className="rp-entry-index">{idx + 1}.</span>
                <span className="rp-entry-number">{shortArticleLabel(article.ordinal, article.suffix)}</span>
                {article.title && <span className="rp-entry-title">【{article.title}】</span>}
                <span className={`rp-entry-tag tag-depth-${Math.min(entry.distance, 3)}`}>{tag}</span>
                {entry.inCycle && <span className="rp-cycle-badge">↻ 循环</span>}
              </button>
              <ArticleText article={article} placementOf={(id) => analysis.placement[id]} />
            </div>
          );
        })}
      </div>

      <div className="rp-warnings">
        <div className="rp-warnings-head">
          断链 / 歧义引用（{pack.warnings.length}
          {pack.warnings.length > 0 ? `：断链 ${brokenCount} · 歧义 ${ambCount}` : ''}）
        </div>
        {pack.warnings.length === 0 ? (
          <div className="impact-hint">收录条款中没有断链或未确认的歧义引用。</div>
        ) : (
          pack.warnings.map((w) => (
            <button
              key={w.id}
              className={`rp-warning ${w.kind === 'broken' ? 'is-broken' : 'is-ambiguous'}`}
              disabled={stale}
              onClick={() => onJumpWarning(w)}
              title={stale ? '阅读包已失效，请重新生成' : '点击跳回正文源句'}
            >
              <span className="rp-warning-kind">{w.kind === 'broken' ? '⛓ 断链' : '❓ 歧义'}</span>
              <span className="rp-warning-source">{w.sourceLabel}</span>
              <span className="rp-warning-raw">{w.raw}</span>
              <span className="rp-warning-reason">{w.reason}</span>
              {w.resolvedLabels?.length ? (
                <span className="rp-warning-extra">已解析：{w.resolvedLabels.join('、')}</span>
              ) : null}
              {w.missingTargets?.map((m, i) => (
                <span key={i} className="rp-warning-extra">
                  缺失：{m.raw}（{m.reason}）
                </span>
              ))}
              {w.candidateLabels?.length ? (
                <span className="rp-warning-extra">候选：{w.candidateLabels.join('、')}</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** 阅读包内完整条款正文：条头正文 + 全部款、项，保留结构编号与原文（不改写） */
function ArticleText({
  article,
  placementOf,
}: {
  article: ClauseNode;
  placementOf: (id: string) => NodePlacement | undefined;
}) {
  return (
    <div className="rp-text">
      {article.text && <div className="rp-text-head">{article.text}</div>}
      {article.children.map((paragraph) => {
        const pIndex = placementOf(paragraph.id)?.paragraphIndex ?? article.children.indexOf(paragraph) + 1;
        return (
          <div key={paragraph.id} className="rp-paragraph">
            <div className="rp-paragraph-line">
              <span className="rp-struct-label">第{formatOrdinal(pIndex)}款</span>
              <span>{paragraph.text}</span>
            </div>
            {paragraph.children.length > 0 && (
              <div className="rp-items">
                {paragraph.children.map((item, ii) => (
                  <div key={item.id} className="rp-item">
                    <span className="rp-struct-label">（{formatOrdinal(ii + 1)}）</span>
                    <span>{item.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
