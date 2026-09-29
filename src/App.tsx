import { useEffect, useState } from 'react';
import type { AppStore } from './lib/store';
import type { Highlighter } from './lib/highlighter';
import { StoreContext, ANN_FOCUS_EVENT, TERM_FOCUS_EVENT, SIGNOFF_FOCUS_EVENT } from './lib/context';
import { Toolbar } from './components/Toolbar';
import { DocumentTree } from './components/DocumentTree';
import { IssuePanel } from './components/IssuePanel';
import { AnnotationPanel } from './components/AnnotationPanel';
import { TermPanel } from './components/TermPanel';
import { RelationView } from './components/RelationView';
import { PathCheckPanel } from './components/PathCheckPanel';
import { CompareView } from './components/CompareView';
import { SandboxPanel } from './components/SandboxPanel';
import { ReadingPackPanel } from './components/ReadingPackPanel';
import { SignoffPanel } from './components/SignoffPanel';
import { ImportDialog } from './components/ImportDialog';
import { ToastHost } from './components/Toast';

type ViewMode = 'edit' | 'compare';
type SideTab = 'issues' | 'annotations' | 'terms' | 'graph' | 'pathcheck' | 'sandbox' | 'readingpack' | 'signoffs';

export default function App({
  store,
  highlighter,
}: {
  store: AppStore;
  highlighter: Highlighter;
}) {
  const [view, setView] = useState<ViewMode>('edit');
  const [rightTab, setRightTab] = useState<SideTab>('issues');
  const [importOpen, setImportOpen] = useState(false);
  const [annFocus, setAnnFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [termFocus, setTermFocus] = useState<{ key: string; nonce: number } | null>(null);
  const [signoffFocus, setSignoffFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  // 全局撤销/重做快捷键（输入框内同样生效，文本组件用 Esc / Ctrl+Enter 处理自身逻辑）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (!(e.ctrlKey || e.metaKey) || !typing) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        store.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  // 点击正文批注标记：切换到批注标签并请求侧栏滚动定位
  useEffect(() => {
    const onAnnFocus = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) {
        setRightTab('annotations');
        setAnnFocus((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    };
    window.addEventListener(ANN_FOCUS_EVENT, onAnnFocus);
    return () => window.removeEventListener(ANN_FOCUS_EVENT, onAnnFocus);
  }, []);

  // 点击正文规范命中标记：切换到规范用语标签并请求侧栏滚动定位
  useEffect(() => {
    const onTermFocus = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      if (key) {
        setRightTab('terms');
        setTermFocus((prev) => ({ key, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    };
    window.addEventListener(TERM_FOCUS_EVENT, onTermFocus);
    return () => window.removeEventListener(TERM_FOCUS_EVENT, onTermFocus);
  }, []);

  // 点击正文条卡片「审签」：切换到条款审签标签并请求侧栏滚动定位
  useEffect(() => {
    const onSignoffFocus = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) {
        setRightTab('signoffs');
        setSignoffFocus((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    };
    window.addEventListener(SIGNOFF_FOCUS_EVENT, onSignoffFocus);
    return () => window.removeEventListener(SIGNOFF_FOCUS_EVENT, onSignoffFocus);
  }, []);

  const reviewCount = store.getSnapshot().annotations.filter((a) => a.status === 'review').length;
  const termHitCount = store.getSnapshot().termHits.length;
  const signoffStaleCount = store.getSnapshot().signoffView.counts.stale;
  const exceptionReviewCount = store.getSnapshot().exceptionView.filter(
    (e) => e.status === 'review',
  ).length;

  return (
    <StoreContext.Provider value={{ store, highlighter }}>
      <div className="app-shell">
        <Toolbar
          view={view}
          onSwitchView={setView}
          onOpenImport={() => setImportOpen(true)}
        />
        {view === 'compare' ? (
          <main className="app-main app-main-compare">
            <section className="pane pane-compare" aria-label="版本对比">
              <CompareView onExit={() => setView('edit')} />
            </section>
          </main>
        ) : (
          <main className="app-main">
            <section className="pane pane-doc" aria-label="条款文档">
              <DocumentTree />
            </section>
            <aside className="pane pane-side" aria-label="校验面板">
              <div className="side-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={rightTab === 'issues'}
                  className={rightTab === 'issues' ? 'active' : ''}
                  onClick={() => setRightTab('issues')}
                >
                  问题与引用{exceptionReviewCount > 0 ? `（${exceptionReviewCount} 待复核）` : ''}
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'annotations'}
                  className={rightTab === 'annotations' ? 'active' : ''}
                  onClick={() => setRightTab('annotations')}
                >
                  审阅批注{reviewCount > 0 ? `（${reviewCount} 待复核）` : ''}
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'terms'}
                  className={rightTab === 'terms' ? 'active' : ''}
                  onClick={() => setRightTab('terms')}
                >
                  规范用语{termHitCount > 0 ? `（${termHitCount}）` : ''}
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'graph'}
                  className={rightTab === 'graph' ? 'active' : ''}
                  onClick={() => setRightTab('graph')}
                >
                  关系视图
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'pathcheck'}
                  className={rightTab === 'pathcheck' ? 'active' : ''}
                  onClick={() => setRightTab('pathcheck')}
                >
                  路径核对
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'sandbox'}
                  className={rightTab === 'sandbox' ? 'active' : ''}
                  onClick={() => setRightTab('sandbox')}
                >
                  修订沙盒
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'readingpack'}
                  className={rightTab === 'readingpack' ? 'active' : ''}
                  onClick={() => setRightTab('readingpack')}
                >
                  引用阅读包
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'signoffs'}
                  className={rightTab === 'signoffs' ? 'active' : ''}
                  onClick={() => setRightTab('signoffs')}
                >
                  条款审签{signoffStaleCount > 0 ? `（${signoffStaleCount} 待重签）` : ''}
                </button>
              </div>
              {rightTab === 'issues' ? (
                <IssuePanel />
              ) : rightTab === 'annotations' ? (
                <AnnotationPanel
                  focusSignal={annFocus}
                  onConsumeFocus={() => setAnnFocus(null)}
                />
              ) : rightTab === 'terms' ? (
                <TermPanel
                  focusSignal={termFocus}
                  onConsumeFocus={() => setTermFocus(null)}
                />
              ) : rightTab === 'graph' ? (
                <RelationView />
              ) : rightTab === 'pathcheck' ? (
                <PathCheckPanel />
              ) : rightTab === 'sandbox' ? (
                <SandboxPanel />
              ) : rightTab === 'signoffs' ? (
                <SignoffPanel
                  focusSignal={signoffFocus}
                  onConsumeFocus={() => setSignoffFocus(null)}
                />
              ) : (
                <ReadingPackPanel />
              )}
            </aside>
          </main>
        )}
        {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
        <ToastHost />
      </div>
    </StoreContext.Provider>
  );
}
