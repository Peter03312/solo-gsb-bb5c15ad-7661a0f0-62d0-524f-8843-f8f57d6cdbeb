import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { ClauseNode, DocSnapshot, NodeKind } from '../../shared/model';
import { analyze } from '../lib/analyzer';
import {
  diffDocuments,
  diffText,
  type DocumentDiff,
  type NodeDiffEntry,
  type RefDiffEntry,
  type TextSegment,
} from '../lib/diff';

function formatTime(ms: number): string {
  if (!ms) return '时间未知';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_LABEL: Record<NodeKind, string> = {
  article: '条',
  paragraph: '款',
  item: '项',
};

export function CompareView({ onExit }: { onExit: () => void }) {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { snapshots, analysis: liveAnalysis } = store.getSnapshot();

  const [name, setName] = useState('');
  const [oldId, setOldId] = useState<string | null>(null);
  const [newId, setNewId] = useState<string | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [section, setSection] = useState<'nodes' | 'refs'>('nodes');

  // 默认选择最后两个快照；当前选择失效时自动回退
  useEffect(() => {
    if (snapshots.length === 0) {
      setOldId(null);
      setNewId(null);
      return;
    }
    const ids = new Set(snapshots.map((s) => s.id));
    if (oldId && !ids.has(oldId)) setOldId(snapshots[Math.max(0, snapshots.length - 2)].id);
    if (newId && !ids.has(newId)) setNewId(snapshots[snapshots.length - 1].id);
    if (!oldId) setOldId(snapshots[Math.max(0, snapshots.length - 2)].id);
    if (!newId) setNewId(snapshots[snapshots.length - 1].id);
  }, [snapshots, oldId, newId]);

  const oldSnap = snapshots.find((s) => s.id === oldId) ?? null;
  const newSnap = snapshots.find((s) => s.id === newId) ?? null;

  const oldAnalysis = useMemo(
    () => (oldSnap ? analyze(oldSnap.doc, { confirmed: oldSnap.confirmed }) : null),
    [oldSnap],
  );
  const newAnalysis = useMemo(
    () => (newSnap ? analyze(newSnap.doc, { confirmed: newSnap.confirmed }) : null),
    [newSnap],
  );

  const diff: DocumentDiff | null =
    oldSnap && newSnap && oldAnalysis && newAnalysis && oldSnap.id !== newSnap.id
      ? diffDocuments(oldAnalysis, newAnalysis, oldSnap.doc, newSnap.doc)
      : null;

  const save = () => {
    const id = store.saveSnapshot(name);
    setName('');
    // 以保存前的“新版本”为旧版本、新快照为新版本；首个快照时两者暂时相同，提示再保存一个
    setOldId((prev) => prev ?? newId);
    setNewId(id);
    setSection('nodes');
  };

  const removeSnapshot = (s: DocSnapshot) => {
    if (confirm(`确定删除快照「${s.name}」？正文与撤销历史均不受影响。`)) {
      store.deleteSnapshot(s.id);
    }
  };

  /** 从差异项跳到当前版本对应节点（节点已不存在则不跳转） */
  const jumpLive = (nodeId: string) => {
    if (liveAnalysis.nodes[nodeId]) {
      highlighter.jumpTo(nodeId);
      onExit();
    }
  };

  const c = diff?.counts;

  return (
    <div className="compare-view">
      <div className="compare-head">
        <div className="compare-head-row">
          <h2>版本对比</h2>
          <div className="compare-save">
            <input
              className="snapshot-name-input"
              placeholder="为当前文档命名，如「一审稿」"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
            <button className="primary" onClick={save}>
              📸 保存当前为快照
            </button>
          </div>
          <button onClick={onExit}>返回正文</button>
        </div>

        <div className="snapshot-list">
          {snapshots.length === 0 && (
            <span className="snapshot-empty">
              尚无快照。在上方输入名称并点击「保存当前为快照」，至少保存两个版本后即可比较。
            </span>
          )}
          {snapshots.map((s) => (
            <div key={s.id} className="snapshot-chip">
              <strong>{s.name}</strong>
              <span className="snapshot-time">{formatTime(s.createdAt)}</span>
              <button
                className="danger small"
                title="删除该快照（不影响正文与撤销历史）"
                onClick={() => removeSnapshot(s)}
              >
                删除
              </button>
            </div>
          ))}
        </div>

        {snapshots.length >= 1 && (
          <div className="compare-pickers">
            <label>
              旧版本
              <select value={oldId ?? ''} onChange={(e) => setOldId(e.target.value)}>
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{formatTime(s.createdAt)}）
                  </option>
                ))}
              </select>
            </label>
            <span className="compare-arrow">⇄</span>
            <label>
              新版本
              <select value={newId ?? ''} onChange={(e) => setNewId(e.target.value)}>
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{formatTime(s.createdAt)}）
                  </option>
                ))}
              </select>
            </label>
            <label className="only-changes">
              <input
                type="checkbox"
                checked={onlyChanges}
                onChange={(e) => setOnlyChanges(e.target.checked)}
              />
              仅显示有变化的节点
            </label>
          </div>
        )}
      </div>

      <div className="compare-body">
        {snapshots.length < 2 ? (
          <div className="empty-hint">
            {snapshots.length === 1
              ? '已保存 1 个快照。继续编辑正文后再保存一个版本，即可选择两个快照进行对比。'
              : '保存两个命名快照后，在此查看条、款、项的新增、删除、正文修改与位置移动，以及引用差异。'}
          </div>
        ) : oldSnap?.id === newSnap?.id ? (
          <div className="empty-hint">请选择两个不同的快照进行对比。</div>
        ) : diff && oldAnalysis && newAnalysis && oldSnap && newSnap ? (
          <>
            <div className="diff-summary">
              <span className="diff-count diff-added">新增 {c!.added}</span>
              <span className="diff-count diff-removed">删除 {c!.removed}</span>
              <span className="diff-count diff-modified">正文修改 {c!.modified}</span>
              <span className="diff-count diff-moved">位置移动 {c!.moved}</span>
              <span className="diff-ref-divider" />
              <span className="diff-count ref-add">引用新增 {c!.refAdded}</span>
              <span className="diff-count ref-del">引用移除 {c!.refRemoved}</span>
              <span className="diff-count ref-mov">目标变化 {c!.refRetargeted}</span>
            </div>

            <div className="diff-tabs">
              <button
                className={section === 'nodes' ? 'active' : ''}
                onClick={() => setSection('nodes')}
              >
                条 / 款 / 项（{c!.added + c!.removed + c!.modified + c!.moved} 处变化）
              </button>
              <button
                className={section === 'refs' ? 'active' : ''}
                onClick={() => setSection('refs')}
              >
                引用（{c!.refAdded + c!.refRemoved + c!.refRetargeted} 处变化）
              </button>
            </div>

            {section === 'nodes' ? (
              <div className="diff-tree-pane">
                {diff.docTitleChanged && (
                  <div className="diff-doc-title">
                    文档标题：<span className="old-inline">{oldSnap.doc.title}</span> →{' '}
                    <span className="new-inline">{newSnap.doc.title}</span>
                  </div>
                )}
                <MergedTree
                  diff={diff}
                  oldRoot={oldSnap.doc.root}
                  newRoot={newSnap.doc.root}
                  onlyChanges={onlyChanges}
                  onJump={jumpLive}
                  liveNodeIds={liveAnalysis.nodes}
                />
              </div>
            ) : (
              <RefDiffList diff={diff} onJump={jumpLive} liveNodeIds={liveAnalysis.nodes} />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------- 合并树渲染（以新版本顺序为主线，删除节点归入旧父级 / 已删除区） ----------

interface MergedTreeProps {
  diff: DocumentDiff;
  oldRoot: ClauseNode[];
  newRoot: ClauseNode[];
  onlyChanges: boolean;
  onJump: (nodeId: string) => void;
  liveNodeIds: Record<string, ClauseNode>;
}

function MergedTree(props: MergedTreeProps) {
  const { oldRoot, newRoot, onlyChanges } = props;
  const rows = mergeLevel(newRoot, oldRoot);
  return (
    <div className="diff-tree">
      {rows.map((row) => (
        <MergedRow key={row.key} row={row} depth={0} {...props} />
      ))}
      {!onlyChanges && oldRoot.length === 0 && newRoot.length === 0 && (
        <div className="empty-hint">两个版本均为空文档。</div>
      )}
    </div>
  );
}

interface MergeRow {
  key: string;
  nodeId: string;
  /** new：仅新版本存在（新增）；both：两版本共有；old：仅旧版本存在（删除） */
  side: 'new' | 'both' | 'old';
  newNode?: ClauseNode;
  oldNode?: ClauseNode;
}

/** 同级合并：以新顺序为主线，旧序列中已消失且无新版本对应的节点插入到其原后继前；末尾追加剩余旧节点 */
function mergeLevel(newKids: ClauseNode[], oldKids: ClauseNode[]): MergeRow[] {
  const rows: MergeRow[] = [];
  const newIds = new Set(newKids.map((n) => n.id));
  const oldById = new Map(oldKids.map((n) => [n.id, n]));
  const emittedOld = new Set<string>();

  const flushOldBefore = (beforeNewId: string | null) => {
    const newPos = beforeNewId ? newKids.findIndex((n) => n.id === beforeNewId) : newKids.length;
    for (const o of oldKids) {
      if (emittedOld.has(o.id) || newIds.has(o.id)) continue;
      const oldPos = oldKids.findIndex((n) => n.id === o.id);
      // 仅输出原位置早于当前新节点的旧节点，保持删除位置的参照
      if (beforeNewId === null || oldPos < newPos) {
        emittedOld.add(o.id);
        rows.push({ key: `old:${o.id}`, nodeId: o.id, side: 'old', oldNode: o });
      }
    }
  };

  for (const n of newKids) {
    const o = oldById.get(n.id);
    flushOldBefore(n.id);
    if (o) {
      rows.push({ key: `both:${n.id}`, nodeId: n.id, side: 'both', newNode: n, oldNode: o });
    } else {
      rows.push({ key: `new:${n.id}`, nodeId: n.id, side: 'new', newNode: n });
    }
  }
  flushOldBefore(null);
  return rows;
}

/** 判断某一行（含其子孙）是否存在任意变化 */
function rowHasChange(diff: DocumentDiff, row: MergeRow): boolean {
  const entry = diff.entries.get(row.nodeId);
  if (entry && (entry.added || entry.removed || entry.moved || entry.contentModified)) {
    return true;
  }
  return mergeLevel(row.newNode?.children ?? [], row.oldNode?.children ?? []).some((r) =>
    rowHasChange(diff, r),
  );
}

function MergedRow({
  row,
  depth,
  diff,
  onlyChanges,
  onJump,
  liveNodeIds,
}: {
  row: MergeRow;
  depth: number;
} & MergedTreeProps) {
  const entry = diff.entries.get(row.nodeId);
  const newNode = row.newNode;
  const oldNode = row.oldNode;
  const isAdded = row.side === 'new' || Boolean(entry?.added);
  const isRemoved = row.side === 'old' || Boolean(entry?.removed);
  const isMoved = Boolean(entry?.moved);
  const isModified = Boolean(entry?.contentModified);
  const changed = isAdded || isRemoved || isMoved || isModified;

  const childRows = mergeLevel(newNode?.children ?? [], oldNode?.children ?? []);

  if (onlyChanges) {
    const selfOrDescendantChanged =
      changed || childRows.some((r) => rowHasChange(diff, r));
    if (!selfOrDescendantChanged) return null;
  }

  const node = newNode ?? oldNode!;
  const liveExists = Boolean(liveNodeIds[row.nodeId]);

  return (
    <div className="diff-node-block" style={{ marginLeft: depth * 22 }}>
      <div
        className={`diff-node ${isAdded ? 'is-added' : ''} ${isRemoved ? 'is-removed' : ''} ${isMoved ? 'is-moved' : ''} ${!changed ? 'is-same' : ''}`}
      >
        <span className="diff-node-kind">{KIND_LABEL[node.kind]}</span>
        <div className="diff-badges">
          {isAdded && <span className="d-badge b-add">新增</span>}
          {isRemoved && <span className="d-badge b-del">删除</span>}
          {isMoved && <span className="d-badge b-move">位置移动</span>}
          {isModified && <span className="d-badge b-mod">正文修改</span>}
        </div>
        {liveExists && (
          <button className="link-btn diff-jump" onClick={() => onJump(row.nodeId)}>
            → 跳到当前版本
          </button>
        )}

        {isMoved && entry?.oldLabel && entry?.newLabel && (
          <div className="move-line">
            位置：{entry.oldLabel} <span className="move-arrow">→</span> {entry.newLabel}
          </div>
        )}
        {isRemoved && entry?.oldLabel && !isMoved && (
          <div className="move-line">原位置：{entry.oldLabel}</div>
        )}
        {isAdded && entry?.newLabel && !isMoved && (
          <div className="move-line">现位置：{entry.newLabel}</div>
        )}

        <NodeContent side={row.side} entry={entry ?? null} newNode={newNode ?? null} oldNode={oldNode ?? null} />
      </div>
      {childRows.map((child) => (
        <MergedRow
          key={child.key}
          row={child}
          depth={depth + 1}
          diff={diff}
          oldRoot={[]}
          newRoot={[]}
          onlyChanges={onlyChanges}
          onJump={onJump}
          liveNodeIds={liveNodeIds}
        />
      ))}
    </div>
  );
}


function NodeContent({
  side,
  entry,
  newNode,
  oldNode,
}: {
  side: 'new' | 'both' | 'old';
  entry: NodeDiffEntry | null;
  newNode: ClauseNode | null;
  oldNode: ClauseNode | null;
}) {
  const oldTitle = oldNode?.title;
  const newTitle = newNode?.title;
  const oldSuffix = oldNode?.suffix;
  const newSuffix = newNode?.suffix;
  const oldText = oldNode?.text ?? '';
  const newText = newNode?.text ?? '';

  return (
    <div className="diff-content">
      {(oldTitle !== newTitle || oldSuffix !== newSuffix) && (
        <div className="meta-diff">
          {oldSuffix !== newSuffix && (
            <span className="meta-seg">
              后缀：<InlineOldNew old={oldSuffix ? `之${oldSuffix}` : '（无）'} nw={newSuffix ? `之${newSuffix}` : '（无）'} />
            </span>
          )}
          {oldTitle !== newTitle && (
            <span className="meta-seg">
              标题：<InlineOldNew old={oldTitle ? `【${oldTitle}】` : '（无）'} nw={newTitle ? `【${newTitle}】` : '（无）'} />
            </span>
          )}
        </div>
      )}

      {side === 'new' ? (
        newText ? <div className="new-inline text-diff-line">{newText}</div> : <EmptyText />
      ) : side === 'old' ? (
        oldText ? <div className="old-inline text-diff-line">{oldText}</div> : <EmptyText />
      ) : entry?.contentModified ? (
        <CharDiff oldText={oldText} newText={newText} />
      ) : newText || oldText ? (
        <div className="same-inline text-diff-line">{newText || oldText}</div>
      ) : (
        <EmptyText />
      )}
    </div>
  );
}

function EmptyText() {
  return <span className="placeholder-text">（无正文）</span>;
}

function InlineOldNew({ old, nw }: { old: string; nw: string }) {
  return (
    <>
      <span className="old-inline">{old}</span> → <span className="new-inline">{nw}</span>
    </>
  );
}

function CharDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const segs = useMemo(() => diffText(oldText, newText), [oldText, newText]);
  if (!oldText || !newText) {
    return (
      <div className="text-diff-line">
        {oldText && <span className="old-inline">{oldText}</span>}
        {newText && <span className="new-inline">{newText}</span>}
      </div>
    );
  }
  return (
    <div className="text-diff-line char-diff">
      {segs.map((seg: TextSegment, i: number) =>
        seg.type === 'same' ? (
          <span key={i}>{seg.text}</span>
        ) : seg.type === 'add' ? (
          <ins key={i} className="char-add">
            {seg.text}
          </ins>
        ) : (
          <del key={i} className="char-del">
            {seg.text}
          </del>
        ),
      )}
    </div>
  );
}

// ---------- 引用差异 ----------

function RefDiffList({
  diff,
  onJump,
  liveNodeIds,
}: {
  diff: DocumentDiff;
  onJump: (nodeId: string) => void;
  liveNodeIds: Record<string, ClauseNode>;
}) {
  const groups: { title: string; cls: string; items: RefDiffEntry[] }[] = [
    { title: '目标变化（同一条引用的解析目标不同）', cls: 'ref-mov', items: diff.refRetargeted },
    { title: '新增引用', cls: 'ref-add', items: diff.refAdded },
    { title: '移除引用', cls: 'ref-del', items: diff.refRemoved },
  ];
  const total = diff.refAdded.length + diff.refRemoved.length + diff.refRetargeted.length;
  if (total === 0) {
    return <div className="empty-hint">两个版本之间没有引用差异。</div>;
  }
  return (
    <div className="ref-diff-pane">
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <div key={g.title} className="ref-diff-group">
            <h3 className={g.cls}>
              {g.title}（{g.items.length}）
            </h3>
            {g.items.map((ref) => (
              <RefDiffRow key={ref.key} ref={ref} onJump={onJump} liveNodeIds={liveNodeIds} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function RefDiffRow({
  ref,
  onJump,
  liveNodeIds,
}: {
  ref: RefDiffEntry;
  onJump: (nodeId: string) => void;
  liveNodeIds: Record<string, ClauseNode>;
}) {
  const sourceExists = Boolean(liveNodeIds[ref.nodeId]);
  return (
    <div className={`ref-diff-row rd-${ref.kind}`}>
      <div className="ref-diff-head">
        <span className="ref-raw">{ref.raw}</span>
        {sourceExists ? (
          <button className="link-btn" onClick={() => onJump(ref.nodeId)}>
            → 跳到当前版本源节点（{ref.sourceLabel}）
          </button>
        ) : (
          <span className="ref-source-gone">源节点已不在当前版本（{ref.sourceLabel}）</span>
        )}
      </div>
      {ref.kind === 'retarget' ? (
        <div className="ref-target-line">
          <span className="old-inline">{ref.oldTargetLabel ?? statusText(ref.oldStatus)}</span>
          <span className="move-arrow"> → </span>
          <span className="new-inline">{ref.newTargetLabel ?? statusText(ref.newStatus)}</span>
        </div>
      ) : ref.kind === 'added' ? (
        <div className="ref-target-line new-inline">
          目标：{ref.newTargetLabel ?? statusText(ref.newStatus)}
        </div>
      ) : (
        <div className="ref-target-line old-inline">
          原目标：{ref.oldTargetLabel ?? statusText(ref.oldStatus)}
        </div>
      )}
    </div>
  );
}

function statusText(status: string | undefined): string {
  if (status === 'ok') return '有效引用';
  if (status === 'broken') return '断链';
  if (status === 'ambiguous') return '歧义';
  return '—';
}
