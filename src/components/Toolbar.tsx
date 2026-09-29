import { useEffect, useState } from 'react';
import { useApp } from '../lib/context';

export function Toolbar({
  view,
  onSwitchView,
  onOpenImport,
}: {
  view: 'edit' | 'compare';
  onSwitchView: (view: 'edit' | 'compare') => void;
  onOpenImport: () => void;
}) {
  const { store } = useApp();
  const snap = store.getSnapshot?.() ?? null;
  const [, force] = useState(0);
  const [saved, setSaved] = useState(true);

  // 订阅 store 变化（组件级轻量订阅）
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  const canUndo = snap?.canUndo ?? false;
  const canRedo = snap?.canRedo ?? false;
  const issueCount = snap?.analysis.issues.length ?? 0;
  const snapshotCount = snap?.snapshots.length ?? 0;

  const doExport = () => {
    const blob = new Blob([JSON.stringify(store.exportJson(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clauses-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">§</span>
        <strong>条款引用校验台</strong>
      </div>

      <div className="tool-group view-switch" role="tablist" aria-label="视图切换">
        <button
          role="tab"
          aria-selected={view === 'edit'}
          className={view === 'edit' ? 'active' : ''}
          onClick={() => onSwitchView('edit')}
        >
          正文编辑
        </button>
        <button
          role="tab"
          aria-selected={view === 'compare'}
          className={view === 'compare' ? 'active' : ''}
          onClick={() => onSwitchView('compare')}
        >
          版本对比{snapshotCount > 0 ? `（${snapshotCount}）` : ''}
        </button>
      </div>

      <div className="tool-group">
        <button
          title="撤销 (Ctrl+Z)"
          disabled={!canUndo || view !== 'edit'}
          onClick={() => store.undo()}
        >
          ↶ 撤销
        </button>
        <button
          title="重做 (Ctrl+Y)"
          disabled={!canRedo || view !== 'edit'}
          onClick={() => store.redo()}
        >
          ↷ 重做
        </button>
      </div>

      <div className="tool-group">
        <button onClick={onOpenImport}>粘贴 / 导入</button>
        <button onClick={doExport}>导出 JSON</button>
      </div>

      <div className="tool-spacer" />

      <div className={`issue-badge ${issueCount ? 'has-issues' : ''}`}>
        {issueCount === 0 ? '✓ 未发现问题' : `⚠ ${issueCount} 个问题`}
      </div>
      <span className="save-state" title="数据仅保存在本机（浏览器 + 本地文件）">
        {saved ? '本地保存' : '保存中…'}
      </span>
    </header>
  );
}
