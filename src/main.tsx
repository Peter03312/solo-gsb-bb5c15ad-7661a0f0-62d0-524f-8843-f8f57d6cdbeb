import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { bootstrapStore, AppStore } from './lib/store';
import { Highlighter } from './lib/highlighter';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('缺少 #root 节点');

const root = ReactDOM.createRoot(rootEl);
root.render(<div className="boot-splash">正在加载条款引用校验台…</div>);

void bootstrapStore().then((store: AppStore) => {
  const highlighter = new Highlighter();
  root.render(
    <React.StrictMode>
      <App store={store} highlighter={highlighter} />
    </React.StrictMode>,
  );
});
