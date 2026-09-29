import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { SignoffStatus } from '../../shared/model';
import type { SignoffEntry } from '../lib/signoff';
import { shortArticleLabel } from '../lib/labels';

type Filter = 'all' | SignoffStatus;

const SIGNER_LS_KEY = 'clause-reference-validator:signer';

function formatTime(ms: number): string {
  if (!ms) return '时间未知';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function loadLastSigner(): string {
  try {
    return localStorage.getItem(SIGNER_LS_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastSigner(name: string): void {
  try {
    localStorage.setItem(SIGNER_LS_KEY, name);
  } catch {
    // 忽略存储异常
  }
}

export function SignoffPanel({
  focusSignal,
  onConsumeFocus,
}: {
  /** 外部（正文条卡片「审签」按钮）请求聚焦的条 id */
  focusSignal: { id: string; nonce: number } | null;
  onConsumeFocus: () => void;
}) {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { signoffView } = store.getSnapshot();
  const { entries, counts, deleted } = signoffView;

  const [filter, setFilter] = useState<Filter>('all');
  const [signer, setSigner] = useState(loadLastSigner);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrollSignal, setScrollSignal] = useState<{ id: string; nonce: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.status === filter)),
    [entries, filter],
  );

  // 正文点击条卡片「审签」：切换筛选并滚动到对应行
  useEffect(() => {
    if (!focusSignal) return;
    setActiveId(focusSignal.id);
    setFilter('all');
    setScrollSignal({ id: focusSignal.id, nonce: focusSignal.nonce });
    onConsumeFocus();
  }, [focusSignal, onConsumeFocus]);

  useEffect(() => {
    if (!scrollSignal) return;
    const el = document.querySelector(`[data-signoff-row="${CSS.escape(scrollSignal.id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [scrollSignal, visible.length]);

  const doSign = (articleId: string) => {
    const res = store.signArticle(articleId, signer);
    if (!res.ok) {
      setError(res.error ?? '签署失败');
      return;
    }
    setError(null);
    saveLastSigner(signer.trim());
    setActiveId(articleId);
  };

  const filterBtn = (key: Filter, label: string, disabled = false, className = '') => (
    <button
      className={`${filter === key ? 'active' : ''} ${className}`}
      disabled={disabled}
      onClick={() => setFilter(key)}
    >
      {label}
    </button>
  );

  return (
    <div className="signoff-panel">
      <div className="signoff-summary">
        当前 {counts.total} 条 ·<em className="sg-valid">✓ 有效 {counts.valid}</em>·
        <em className="sg-stale">⚠ 待重签 {counts.stale}</em>·
        <em className="sg-unsigned">未签 {counts.unsigned}</em>
        {deleted.length > 0 && <em className="sg-deleted">·已删除记录 {deleted.length}</em>}
      </div>

      <div className="signoff-signer-box">
        <label htmlFor="signoff-signer-input">审签人</label>
        <input
          id="signoff-signer-input"
          className="signoff-signer-input"
          value={signer}
          placeholder="输入姓名后对下方条款签署"
          onChange={(e) => {
            setSigner(e.target.value);
            setError(null);
          }}
        />
      </div>
      {error && <div className="form-error">{error}</div>}

      <div className="issue-filters ann-filters">
        {filterBtn('all', `全部 ${counts.total}`)}
        {filterBtn('unsigned', `未签 ${counts.unsigned}`, counts.unsigned === 0)}
        {filterBtn('valid', `✓ 有效 ${counts.valid}`, counts.valid === 0)}
        {filterBtn('stale', `⚠ 待重签 ${counts.stale}`, counts.stale === 0, 'sg-filter-stale')}
      </div>

      <div className="issue-list signoff-list">
        {visible.length === 0 && (
          <div className="empty-hint">
            {counts.total === 0
              ? '暂无条款。先粘贴 / 导入条款文本后再进行审签。'
              : '该状态下暂无条款。'}
          </div>
        )}
        {visible.map((entry) => (
          <SignoffRow
            key={entry.articleId}
            entry={entry}
            active={activeId === entry.articleId}
            canSign={signer.trim().length > 0}
            onSign={() => doSign(entry.articleId)}
            onJump={() => {
              setActiveId(entry.articleId);
              highlighter.jumpTo(entry.articleId);
            }}
          />
        ))}
      </div>

      {deleted.length > 0 && (
        <div className="signoff-deleted-box">
          <div className="signoff-deleted-title">已删除条款的审签记录（不计入当前统计）</div>
          {deleted.map((entry) => (
            <div key={entry.articleId} className="signoff-deleted-row">
              <span className="sg-status-tag is-deleted">已删除</span>
              <span className="signoff-deleted-id" title="稳定节点 ID">
                {entry.articleId}
              </span>
              <span className="signoff-signer-name">{entry.signoff?.signer}</span>
              <span className="signoff-time">{formatTime(entry.signoff?.signedAt ?? 0)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="panel-footer">
        签署时固化该条完整条文（条号、标题、正文、款、项）的内容指纹；正文编辑、结构调整或引用自动改写后指纹失配显示「待重签」，撤销恢复原文即恢复有效。
      </div>
    </div>
  );
}

function SignoffRow({
  entry,
  active,
  canSign,
  onSign,
  onJump,
}: {
  entry: SignoffEntry;
  active: boolean;
  canSign: boolean;
  onSign: () => void;
  onJump: () => void;
}) {
  const { article, signoff, status } = entry;
  const label = article ? shortArticleLabel(article.ordinal, article.suffix) : '（已删除）';
  const titleText = article?.title;

  return (
    <div
      data-signoff-row={entry.articleId}
      className={`issue-row signoff-row sg-${status} ${active ? 'signoff-row-active' : ''}`}
    >
      <div className="issue-row-head">
        <button className="issue-source-label signoff-jump-btn" onClick={onJump} title="跳转到该条">
          {label}
          {titleText ? `【${titleText}】` : ''}
        </button>
        <StatusTag status={status} />
      </div>

      {signoff ? (
        <div className="signoff-meta">
          <span className="signoff-signer-name">{signoff.signer}</span>
          <span className="signoff-time">签署于 {formatTime(signoff.signedAt)}</span>
          <span className="signoff-fp" title="签署时该条完整条文（条号、标题、正文、款、项）的内容指纹">
            指纹 {signoff.fingerprint.slice(-10)}
          </span>
        </div>
      ) : (
        <div className="signoff-meta signoff-meta-empty">尚未签署</div>
      )}

      {signoff?.history && signoff.history.length > 0 && (
        <div className="signoff-history">
          历史签署 {signoff.history.length} 次 · 最近：{signoff.history[signoff.history.length - 1].signer}
          （{formatTime(signoff.history[signoff.history.length - 1].signedAt)}）
        </div>
      )}

      <div className="ann-row-actions">
        <button className="link-btn subtle" onClick={onJump}>
          跳转
        </button>
        <button
          className="link-btn"
          disabled={!canSign}
          title={canSign ? '' : '请先在上方填写审签人'}
          onClick={onSign}
        >
          {status === 'unsigned' ? '签署' : '重新签署'}
        </button>
      </div>
    </div>
  );
}

function StatusTag({ status }: { status: SignoffStatus }) {
  if (status === 'valid') return <span className="sg-status-tag is-valid">✓ 有效</span>;
  if (status === 'stale') return <span className="sg-status-tag is-stale">⚠ 待重签</span>;
  if (status === 'deleted') return <span className="sg-status-tag is-deleted">已删除</span>;
  return <span className="sg-status-tag is-unsigned">未签</span>;
}
