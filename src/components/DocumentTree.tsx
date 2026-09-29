import { useEffect, useState } from 'react';
import { useApp, SIGNOFF_FOCUS_EVENT } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import type { ClauseNode, RefOccurrence } from '../../shared/model';
import { NodeEditor } from './NodeEditor';
import { formatOrdinal } from '../lib/numeral';
import { countNodes } from '../lib/parser';

export function DocumentTree() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const hl = useHighlighter(highlighter);
  const { doc, analysis } = store.getSnapshot();
  const counts = countNodes(doc);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  // 问题 / 批注跳转到折叠条内的款、项时，自动展开所属条
  useEffect(() => {
    if (hl.focusNonce === 0 || !hl.activeNodeId) return;
    const articleId = analysis.placement[hl.activeNodeId]?.article.id;
    if (articleId && collapsed[articleId]) {
      setCollapsed((c) => ({ ...c, [articleId]: false }));
    }
  }, [hl.focusNonce, hl.activeNodeId, analysis, collapsed]);

  return (
    <div className="doc-tree">
      <div className="doc-header">
        <input
          className="doc-title-input"
          value={doc.title}
          onChange={(e) => store.renameTitle(e.target.value)}
          aria-label="文档标题"
        />
        <div className="doc-meta">
          {counts.articles} 条 · {counts.paragraphs} 款 · {counts.items} 项
          <button className="link-btn" onClick={() => store.addArticle()}>
            + 新增条
          </button>
        </div>
      </div>

      <div
        className="article-list"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/article-id')) e.preventDefault();
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('text/article-id');
          if (id) {
            e.preventDefault();
            store.reorderSibling(id, doc.root.length);
          }
        }}
      >
        {doc.root.map((article, ai) => (
          <ArticleView
            key={article.id}
            article={article}
            index={ai}
            collapsed={Boolean(collapsed[article.id])}
            onToggle={() => toggle(article.id)}
            occurrences={analysis.byNode[article.id] ?? []}
          />
        ))}
        {doc.root.length === 0 && (
          <div className="empty-hint">
            暂无条款。点击右上角「粘贴 / 导入」，把含“第X条/款/项”的文本粘贴进来。
          </div>
        )}
      </div>
    </div>
  );
}

function ArticleView({
  article,
  index,
  collapsed,
  onToggle,
  occurrences,
}: {
  article: ClauseNode;
  index: number;
  collapsed: boolean;
  onToggle: () => void;
  occurrences: RefOccurrence[];
}) {
  const { store, highlighter } = useApp();
  const hl = useHighlighter(highlighter);
  const [editingNumber, setEditingNumber] = useState(false);
  const [draftNum, setDraftNum] = useState(String(article.ordinal));
  const [dragOver, setDragOver] = useState(false);

  const issues = store.getSnapshot().analysis.issues.filter(
    (i) => i.sourceNodeId === article.id || i.cycleNodeIds?.includes(article.id),
  );
  const signoffStatus = store.getSnapshot().signoffView.entries.find(
    (e) => e.articleId === article.id,
  )?.status;
  const glows = hl.hoverTargetNodeIds.includes(article.id);

  // 问题跳转 / 关系图定位到“条”本身时滚动到该卡片
  useEffect(() => {
    if (hl.activeNodeId !== article.id) return;
    if (hl.focusNonce === 0) return;
    const el = document.querySelector(`[data-node-id="${CSS.escape(article.id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [hl.activeNodeId, hl.focusNonce, article.id]);

  const commitNumber = () => {
    const n = Number(draftNum);
    if (Number.isInteger(n) && n >= 1) store.renumberArticle(article.id, n);
    setEditingNumber(false);
  };

  return (
    <div
      className={`node-card article-card ${issues.some((i) => i.type !== 'self') ? 'has-issue' : ''} ${dragOver ? 'drag-over' : ''} ${glows ? 'target-glow' : ''}`}
      data-node-id={article.id}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/article-id')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('text/article-id');
        setDragOver(false);
        if (id && id !== article.id) {
          e.preventDefault();
          e.stopPropagation();
          store.reorderSibling(id, index);
        }
      }}
    >
      <div
        className="node-head article-head"
        draggable
        title="拖拽可调整条的顺序（所有绝对引用将原子更新）"
        onDragStart={(e) => {
          e.dataTransfer.setData('text/article-id', article.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <span className="drag-grip" aria-hidden>⠿</span>
        <button className="twisty" onClick={onToggle} title={collapsed ? '展开' : '折叠'}>
          {collapsed ? '▶' : '▼'}
        </button>
        {editingNumber ? (
          <input
            className="num-edit"
            value={draftNum}
            autoFocus
            onChange={(e) => setDraftNum(e.target.value)}
            onBlur={commitNumber}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNumber();
              if (e.key === 'Escape') setEditingNumber(false);
            }}
          />
        ) : (
          <span
            className="node-number article-number"
            title="点击修改编号（与目标条交换位置）"
            onClick={() => {
              setDraftNum(String(article.ordinal));
              setEditingNumber(true);
            }}
          >
            第{formatOrdinal(article.ordinal)}条
            {article.suffix ? <em className="suffix">之{article.suffix}</em> : null}
          </span>
        )}
        {article.title !== undefined && (
          <span className="article-title">【{article.title}】</span>
        )}
        <div className="head-actions">
          <button
            className={`signoff-entry-btn ${signoffStatus && signoffStatus !== 'unsigned' ? `is-${signoffStatus}` : ''}`}
            title={
              signoffStatus === 'valid'
                ? '该条已审签且当前条文有效（点击查看）'
                : signoffStatus === 'stale'
                  ? '条文已变化，该条待重签（点击查看）'
                  : '对该条录入审签人并签署'
            }
            onClick={() =>
              window.dispatchEvent(new CustomEvent(SIGNOFF_FOCUS_EVENT, { detail: article.id }))
            }
          >
            {signoffStatus === 'valid' ? '✓ 已签' : signoffStatus === 'stale' ? '⚠ 待重签' : '审签'}
          </button>
          <button
            title="新增款"
            onClick={() => store.addParagraph(article.id)}
          >
            +款
          </button>
          <button title="在此条后新增条" onClick={() => store.addArticle(article.id)}>
            +条
          </button>
          <button
            className="danger"
            title="删除整条（指向它的引用将变为断链）"
            onClick={() => {
              if (confirm(`确定删除第${formatOrdinal(article.ordinal)}条？指向它的引用将变为断链。`))
                store.deleteNode(article.id);
            }}
          >
            删除
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="node-body">
          {article.text && (
            <NodeEditor node={article} occurrences={occurrences} isHead />
          )}
          <ParagraphList article={article} />
        </div>
      )}
    </div>
  );
}

function ParagraphList({ article }: { article: ClauseNode }) {
  const { store, highlighter } = useApp();
  const analysis = store.getSnapshot().analysis;
  const hl = useHighlighter(highlighter);
  const glowFor = hl.hoverTargetNodeIds;

  return (
    <div className="paragraph-list">
      {article.children.map((paragraph, pi) => (
        <div
          className={`node-card paragraph-card ${glowFor.includes(paragraph.id) ? 'target-glow' : ''}`}
          key={paragraph.id}
          data-node-id={paragraph.id}
        >
          <div className="node-head paragraph-head">
            <span className="node-number">第{formatOrdinal(pi + 1)}款</span>
            <div className="head-actions">
              <button title="新增项" onClick={() => store.addItem(paragraph.id)}>
                +项
              </button>
              <button
                className="danger"
                title="删除本款"
                onClick={() => {
                  if (confirm(`确定删除第${formatOrdinal(article.ordinal)}条第${formatOrdinal(pi + 1)}款？`))
                    store.deleteNode(paragraph.id);
                }}
              >
                删除
              </button>
            </div>
          </div>
          <NodeEditor node={paragraph} occurrences={analysis.byNode[paragraph.id] ?? []} />
          {paragraph.children.length > 0 && (
            <div className="item-list">
              {paragraph.children.map((item, ii) => (
                <div
                  className={`node-card item-card ${glowFor.includes(item.id) ? 'target-glow' : ''}`}
                  key={item.id}
                  data-node-id={item.id}
                >
                  <div className="node-head item-head">
                    <span className="node-number">（{formatOrdinal(ii + 1)}）</span>
                    <button
                      className="danger small"
                      title="删除本项"
                      onClick={() => store.deleteNode(item.id)}
                    >
                      删除
                    </button>
                  </div>
                  <NodeEditor
                    node={item}
                    occurrences={analysis.byNode[item.id] ?? []}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
