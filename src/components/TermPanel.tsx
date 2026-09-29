import { useEffect, useState } from 'react';
import { useApp } from '../lib/context';
import type { TermHit, TermRule } from '../../shared/model';
import { labelOfNode } from '../lib/labels';
import { hitContext } from '../lib/terminology';

export function TermPanel({
  focusSignal,
  onConsumeFocus,
}: {
  /** 正文规范命中标记点击时请求聚焦的命中 key */
  focusSignal?: { key: string; nonce: number } | null;
  onConsumeFocus?: () => void;
}) {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { termRules, termHits, analysis } = store.getSnapshot();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'warn' } | null>(null);

  // 扫描快照变化（正文/规则编辑、替换、撤销重做）后，剔除已不存在的勾选
  useEffect(() => {
    const keys = new Set(termHits.map((h) => h.key));
    setSelected((prev) => {
      const next = new Set<string>();
      for (const k of prev) if (keys.has(k)) next.add(k);
      return next;
    });
  }, [termHits]);

  // 提示自动消失
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  // 正文点击规范命中标记：选中对应行并滚动定位
  useEffect(() => {
    if (!focusSignal) return;
    setActiveKey(focusSignal.key);
    onConsumeFocus?.();
    const el = document.querySelector(
      `[data-term-row="${CSS.escape(focusSignal.key)}"]`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusSignal, onConsumeFocus]);

  const ruleCount = termRules.length;
  const hitCount = termHits.length;
  const selectedCount = selected.size;
  const allSelected = hitCount > 0 && selectedCount === hitCount;

  const toggleOne = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(termHits.map((h) => h.key)));
  };

  const jump = (hit: TermHit) => {
    setActiveKey(hit.key);
    highlighter.jumpToTerm(hit.key, hit.nodeId, { start: hit.start, end: hit.end });
  };

  const doReplace = () => {
    const result = store.replaceSelectedTerms([...selected]);
    if (result.stale > 0) {
      setMessage({
        text: `正文已变化，${result.stale} 项勾选区间失效，已整批拒绝替换，请重新勾选后再试。`,
        kind: 'warn',
      });
    } else if (result.replaced > 0) {
      setMessage({ text: `已批量替换 ${result.replaced} 处，可通过撤销整体恢复。`, kind: 'info' });
      setSelected(new Set());
    }
  };

  return (
    <div className="term-panel">
      <div className="term-toolbar">
        <div className="term-stat">
          {ruleCount} 条规则 · {hitCount} 处命中
        </div>
        <button className="small" onClick={() => store.addTermRule()}>
          + 新增规则
        </button>
      </div>

      <div className="term-scroll">
        <section className="term-rules">
          <div className="term-section-title">规范词与禁用变体（顺序即同长命中的优先级）</div>
          {termRules.length === 0 && (
            <div className="empty-hint">
              还没有规则。点击「+ 新增规则」，填入一个规范词和若干禁用变体。
            </div>
          )}
          {termRules.map((rule, i) => (
            <RuleEditor key={rule.id} rule={rule} index={i} total={termRules.length} />
          ))}
        </section>

        <section className="term-hits">
          <div className="term-hits-head">
            <span className="term-section-title">扫描命中（实时）</span>
            <label className="term-select-all">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={hitCount === 0} />
              全选
            </label>
          </div>
          <div className="issue-list term-hit-list">
            {hitCount === 0 && (
              <div className="empty-hint">
                {ruleCount === 0
                  ? '添加规则后，这里会实时列出全部命中。'
                  : '✓ 当前正文没有命中任何禁用变体。'}
              </div>
            )}
            {termHits.map((hit) => (
              <TermHitRow
                key={hit.key}
                hit={hit}
                checked={selected.has(hit.key)}
                active={activeKey === hit.key}
                onToggle={() => toggleOne(hit.key)}
                onJump={() => jump(hit)}
                nodeLabel={labelOfNode(analysis, hit.nodeId)}
                context={hitContext(analysis.nodes, hit)}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="term-footer">
        {message && (
          <div className={`term-msg ${message.kind === 'warn' ? 'term-msg-warn' : ''}`}>
            {message.text}
          </div>
        )}
        <div className="term-replace-row">
          <span className="term-selected-count">已选 {selectedCount} 处</span>
          <button
            className="primary"
            disabled={selectedCount === 0}
            onClick={doReplace}
            title="仅替换当前扫描快照中已勾选的命中；提交前逐项核对区间，任一项变化则整批拒绝"
          >
            批量替换为规范词
          </button>
        </div>
        <div className="panel-footer term-note">
          替换按节点从后向前单遍进行，不递归处理新生成文字；整体为一步，可撤销 / 重做。
        </div>
      </div>
    </div>
  );
}

function RuleEditor({ rule, index, total }: { rule: TermRule; index: number; total: number }) {
  const { store } = useApp();
  // 编辑中使用本地草稿（实时提交但避免 store 的 trim/去重回写打断输入与光标），
  // 失焦后回到由 store 数据驱动（撤销 / 重做、规则移动可正确刷新）。
  const [canonical, setCanonical] = useState(rule.canonical);
  const [variantsText, setVariantsText] = useState(rule.variants.join('、'));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) {
      setCanonical(rule.canonical);
      setVariantsText(rule.variants.join('、'));
    }
  }, [rule, editing]);

  const push = (nextCanonical: string, nextVariantsText: string, trim: boolean) => {
    const variants = nextVariantsText
      .split(/[、,，\n\r]+/)
      .map((v) => (trim ? v.trim() : v))
      .filter((v) => v.trim());
    store.updateTermRule(rule.id, { canonical: nextCanonical, variants }, trim);
  };

  return (
    <div className="term-rule">
      <div className="term-rule-head">
        <span className="term-rule-order">#{index + 1}</span>
        <div className="term-rule-order-btns">
          <button
            className="link-btn subtle"
            disabled={index === 0}
            title="前移（提高优先级）"
            onClick={() => store.moveTermRule(rule.id, -1)}
          >
            ↑
          </button>
          <button
            className="link-btn subtle"
            disabled={index === total - 1}
            title="后移（降低优先级）"
            onClick={() => store.moveTermRule(rule.id, 1)}
          >
            ↓
          </button>
          <button
            className="link-btn subtle term-del"
            title="删除规则（可撤销）"
            onClick={() => {
              if (confirm('确定删除该规范用语规则？此操作可通过撤销恢复。'))
                store.deleteTermRule(rule.id);
            }}
          >
            删除
          </button>
        </div>
      </div>
      <div className="term-field">
        <label>规范词</label>
        <input
          className="term-input"
          value={canonical}
          placeholder="如：依照"
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setCanonical(e.target.value);
            push(e.target.value, variantsText, false);
          }}
          onBlur={() => {
            push(canonical, variantsText, true);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="term-field">
        <label>禁用变体（顿号/逗号分隔多个）</label>
        <input
          className="term-input"
          value={variantsText}
          placeholder="如：按照、按着"
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setVariantsText(e.target.value);
            push(canonical, e.target.value, false);
          }}
          onBlur={() => {
            push(canonical, variantsText, true);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
    </div>
  );
}

function TermHitRow({
  hit,
  checked,
  active,
  onToggle,
  onJump,
  nodeLabel,
  context,
}: {
  hit: TermHit;
  checked: boolean;
  active: boolean;
  onToggle: () => void;
  onJump: () => void;
  nodeLabel: string;
  context: { before: string; match: string; after: string } | null;
}) {
  return (
    <div
      data-term-row={hit.key}
      className={`issue-row term-hit-row ${checked ? 'term-checked' : ''} ${active ? 'term-row-active' : ''}`}
    >
      <div className="term-hit-main">
        <input
          type="checkbox"
          className="term-check"
          checked={checked}
          onChange={onToggle}
          title="勾选后可批量替换"
        />
        <div className="term-hit-body">
          <div className="issue-row-head">
            <span className="term-replace-pair">
              <span className="term-variant">{hit.variant}</span>
              <span className="term-arrow">→</span>
              <span className="term-canonical">{hit.canonical || '（规范词为空）'}</span>
            </span>
            <span className="issue-source-label">{nodeLabel}</span>
          </div>
          <button className="issue-sentence term-ctx-btn" onClick={onJump} title="点击定位到正文">
            {context && (
              <>
                {context.before ? `…${context.before}` : ''}
                <mark className="term-ctx-hit">{context.match}</mark>
                {context.after ? `${context.after}…` : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
