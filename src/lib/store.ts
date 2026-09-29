import { useSyncExternalStore } from 'react';
import type {
  Annotation,
  ArticleSignoff,
  ClauseDocument,
  ClauseNode,
  DocSnapshot,
  ExportBundle,
  IssueBaseline,
  IssueException,
  IssueExceptionEntry,
  PersistedState,
} from '../../shared/model';
import { analyze } from './analyzer';
import type { Analysis } from '../../shared/model';
import { parseDocument } from './parser';
import {
  cloneTree,
  findArticleOf,
  findNode,
  newArticle,
  newItem,
  newParagraph,
  renumberAll,
  touch,
} from './tree';

import { applyStructuralChange } from './rewriter';
import {
  buildSandboxPreview,
  confirmedEqual,
  type SandboxOp,
  type SandboxPreview,
} from './sandbox';
import { buildReadingPack, isReadingPackStale, type ReadingPack } from './readingpack';
import { localStore, serverStore } from './storage';
import { createSnapshot, sanitizeSnapshots } from './snapshot';
import { createIssueBaseline, sanitizeIssueBaselines } from './issueBaseline';
import {
  articleFingerprint,
  buildSignoffView,
  sanitizeSignoffs,
  signArticle,
  type SignoffView,
} from './signoff';
import {
  acceptIssueException,
  buildIssueExceptionView,
  isExceptionableIssue,
  reconfirmIssueException,
  sanitizeIssueExceptions,
} from './exception';
import {
  createAnnotation as makeAnnotation,
  relocateAnnotations,
  sanitizeAnnotations,
  ANCHOR_CTX,
} from './annotations';
import {
  createTermRule,
  replaceTermHits,
  sanitizeTermRules,
  scanTerms,
} from './terminology';
import type { TermHit, TermRule } from '../../shared/model';
import { validateImportBundle } from '../../shared/validation';
import { sampleTermRules } from './sample';
import { uid } from './uid';

/** 撤销/重做历史承载正文、歧义确认记录、批注与规范用语规则（逐帧） */
interface DocState {
  doc: ClauseDocument;
  confirmed: Record<string, string>;
  annotations: Annotation[];
  termRules: TermRule[];
}

/**
 * 审阅留痕：版本快照、问题基线、条款审签与例外处置。
 * 这些记录本身不参与普通编辑的撤销；整份文档替换时按事务随文档整套切换。
 */
interface TraceState {
  snapshots: DocSnapshot[];
  issueBaselines: IssueBaseline[];
  signoffs: ArticleSignoff[];
  issueExceptions: IssueException[];
}

/**
 * 历史帧：普通编辑产生同世界帧，按现有粒度撤销 / 重做；
 * 整份文档替换（粘贴 / JSON 导入 / 载入示例）产生跨世界帧，
 * 撤销 / 重做跨越世界边界时整套恢复目标世界的留痕与会话临时产物失效处理。
 */
interface HistoryFrame {
  docState: DocState;
  world: number;
}

interface Snapshot {
  doc: ClauseDocument;
  confirmed: Record<string, string>;
  annotations: Annotation[];
  termRules: TermRule[];
  snapshots: DocSnapshot[];
  issueBaselines: IssueBaseline[];
  analysis: Analysis;
  /** 当前规范用语规则对当前正文的实时扫描结果（重叠消解后的命中） */
  termHits: TermHit[];
  /** 修订沙盒：当前预演（会话内，不持久化、不进入撤销历史） */
  sandbox: SandboxPreview | null;
  /** 预演生成后正文或歧义确认记录已变化：预演失效，禁止应用 */
  sandboxStale: boolean;
  /** 引用阅读包（会话内临时产物，不持久化、不进入撤销历史） */
  readingPack: ReadingPack | null;
  /** 阅读包生成后正文或歧义确认记录已变化：失效，须重新生成，禁止复制旧结果 */
  readingPackStale: boolean;
  /** 条款审签记录对当前正文的实时汇总（有效 / 待重签 / 未签 / 已删除） */
  signoffView: SignoffView;
  /** 断链 / 自引用问题的例外处置记录（随当前世界持久化；整份替换事务整体切换） */
  issueExceptions: IssueException[];
  /** 例外处置记录对当前实时分析的逐条判定（已接受 / 待复核 / 已消失） */
  exceptionView: IssueExceptionEntry[];
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 100;

export class AppStore {
  private past: HistoryFrame[] = [];
  private future: HistoryFrame[] = [];
  private docState: DocState;
  /** 当前世界（整份文档替换开启新世界）的 id；首启文档为 0 */
  private currentWorld = 0;
  private nextWorldId = 1;
  /**
   * 各世界审阅留痕的权威存储：世界 id -> 留痕。
   * 同一世界内签署 / 例外 / 快照等独立操作就地更新当前世界；
   * 跨世界撤销 / 重做时整套换入目标世界留痕。当前世界对应的字段为镜像。
   */
  private worlds = new Map<number, TraceState>();
  // —— 当前世界留痕镜像（与 worlds.get(currentWorld) 同步）——
  private snapshots: DocSnapshot[] = [];
  private issueBaselines: IssueBaseline[] = [];
  /** 条款审签记录（同世界内独立于正文撤销历史；有效 / 待重签按当前条文实时重算） */
  private signoffs: ArticleSignoff[] = [];
  /** 断链 / 自引用问题的例外处置记录（同世界内独立于撤销历史；三态按当前分析实时重算） */
  private issueExceptions: IssueException[] = [];
  private analysis: Analysis;
  /** 当前规范用语命中（随 docState 实时重算，不进入撤销历史） */
  private termHits: TermHit[] = [];
  /** 当前连续文本编辑突发的起始状态（用于合并撤销） */
  private coalesceBaseline: DocState | null = null;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  lastRewriteInfo: { rewritten: number; skipped: number } | null = null;
  /** 最近一次结构操作导致新转入待复核的批注数（供通知条提示） */
  lastAnnotationReviewCount = 0;
  /** 最近一次批量规范替换结果（供界面提示，无操作时为 null） */
  lastTermReplace: { replaced: number; stale: number } | null = null;
  /** 修订沙盒：当前预演（会话内临时数据，不持久化、不进入撤销历史） */
  private sandbox: SandboxPreview | null = null;
  /** 引用阅读包：当前阅读包（会话内临时产物，不持久化、不进入撤销历史） */
  private readingPack: ReadingPack | null = null;
  /** 正文版本号：仅当正文文档对象变化时递增（批注 / 规范规则 / 歧义确认不变更正文） */
  private docRevision = 0;

  constructor(initial: PersistedState) {
    this.snapshots = sanitizeSnapshots(initial.snapshots);
    this.issueBaselines = sanitizeIssueBaselines(initial.issueBaselines);
    // 审签记录随本地存储 / JSON 加载；旧数据缺少 signoffs 时按空列表加载
    this.signoffs = sanitizeSignoffs(initial.signoffs);
    // 例外处置记录随本地存储 / JSON 加载；旧数据缺少 issueExceptions 时按空列表加载
    this.issueExceptions = sanitizeIssueExceptions(initial.issueExceptions);
    const annotations = sanitizeAnnotations(initial.annotations);
    const termRules = sanitizeTermRules(initial.termRules);
    const doc = initial.doc;
    // 加载时按当前正文校正一次位置（导入的 JSON / 旧数据可能已与正文不同步）
    const relocated = relocateAnnotations(annotations, doc).annotations;
    this.docState = { doc, confirmed: initial.confirmed, annotations: relocated, termRules };
    this.analysis = analyze(doc, { confirmed: initial.confirmed });
    this.termHits = scanTerms(doc, termRules);
    // 首启文档为初始世界，留痕整体归于该世界
    this.worlds.set(0, {
      snapshots: this.snapshots,
      issueBaselines: this.issueBaselines,
      signoffs: this.signoffs,
      issueExceptions: this.issueExceptions,
    });
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  getSnapshot = (): Snapshot => ({
    doc: this.docState.doc,
    confirmed: this.docState.confirmed,
    annotations: this.docState.annotations,
    termRules: this.docState.termRules,
    snapshots: this.snapshots,
    issueBaselines: this.issueBaselines,
    analysis: this.analysis,
    termHits: this.termHits,
    sandbox: this.sandbox,
    sandboxStale: this.sandbox ? this.isSandboxStale(this.sandbox) : false,
    readingPack: this.readingPack,
    readingPackStale: this.readingPack
      ? isReadingPackStale(this.readingPack, this.docRevision, this.docState.confirmed)
      : false,
    signoffView: buildSignoffView(this.docState.doc, this.signoffs),
    issueExceptions: this.issueExceptions,
    exceptionView: buildIssueExceptionView(this.analysis, this.issueExceptions),
    canUndo: this.past.length > 0,
    canRedo: this.future.length > 0,
  });

  /** 当前完整持久化状态（正文 + 确认 + 批注 + 快照 + 问题基线 + 审签 + 例外处置） */
  private currentPersisted(): PersistedState {
    return {
      ...this.docState,
      snapshots: this.snapshots,
      issueBaselines: this.issueBaselines,
      signoffs: this.signoffs,
      issueExceptions: this.issueExceptions,
    };
  }

  /** 当前正文状态与所属世界构成的帧 */
  private get currentFrame(): HistoryFrame {
    return { docState: this.docState, world: this.currentWorld };
  }

  /** 当前世界留痕镜像 */
  private currentTraces(): TraceState {
    return {
      snapshots: this.snapshots,
      issueBaselines: this.issueBaselines,
      signoffs: this.signoffs,
      issueExceptions: this.issueExceptions,
    };
  }

  /** 把当前留痕镜像同步回当前世界（独立留痕操作已就地更新镜像，替换 / 换世界前保存） */
  private syncCurrentWorld(): void {
    this.worlds.set(this.currentWorld, this.currentTraces());
  }

  /** 换入目标世界留痕：四套镜像整体替换 */
  private applyTraces(traces: TraceState): void {
    this.snapshots = traces.snapshots;
    this.issueBaselines = traces.issueBaselines;
    this.signoffs = traces.signoffs;
    this.issueExceptions = traces.issueExceptions;
  }

  /** 回收历史栈中已不可达世界的留痕（当前世界保留） */
  private gcWorlds(): void {
    const reachable = new Set<number>([this.currentWorld]);
    for (const f of this.past) reachable.add(f.world);
    for (const f of this.future) reachable.add(f.world);
    for (const id of [...this.worlds.keys()]) {
      if (!reachable.has(id)) this.worlds.delete(id);
    }
  }

  /**
   * 提交前归一化：重新分析、批注自动重定位、裁剪过期确认、规范用语重扫。
   * 返回归一化后的正文状态、实时分析、规范命中与本次转入待复核的批注数。
   */
  private normalizeDocState(
    next: DocState,
  ): { docState: DocState; analysis: Analysis; termHits: TermHit[]; reviewCount: number } {
    const analysis = analyze(next.doc, { confirmed: next.confirmed });
    // 批注按调整后的正文/结构自动重定位
    const relocated = relocateAnnotations(next.annotations, next.doc);
    // 裁剪：确认记录必须仍对应一个“歧义已消失/仍歧义”的 occurrence，且目标存在
    const valid = new Set(
      analysis.occurrences
        .filter((o) => o.signature && next.confirmed[o.signature])
        .map((o) => o.signature),
    );
    const confirmed: Record<string, string> = {};
    for (const [sig, target] of Object.entries(next.confirmed)) {
      if (valid.has(sig) && analysis.nodes[target]) confirmed[sig] = target;
    }
    const docState: DocState = {
      confirmed,
      doc: touch(next.doc),
      annotations: relocated.annotations,
      termRules: next.termRules,
    };
    return {
      docState,
      analysis,
      termHits: scanTerms(docState.doc, docState.termRules),
      reviewCount: relocated.reviewIds.length,
    };
  }

  /** 提交新状态：压入历史（同世界帧）、持久化 */
  private commit(
    next: DocState,
    options: { coalesce?: boolean; structural?: boolean } = {},
  ): void {
    // 正文版本号：仅正文文档对象变化时递增（批注 / 规范规则 / 歧义确认提交不变更正文）
    const docChanged = next.doc !== this.docState.doc;
    const norm = this.normalizeDocState(next);

    if (options.coalesce) {
      if (this.coalesceBaseline) {
        // 同一编辑突发内：不压栈，栈顶保持为突发前基线
      } else {
        this.coalesceBaseline = this.docState;
        this.past.push(this.currentFrame);
      }
    } else {
      this.coalesceBaseline = null;
      this.editCoalesceUntil = 0;
      this.ruleCoalesceUntil = 0;
      this.past.push(this.currentFrame);
      if (this.past.length > MAX_HISTORY) this.past.shift();
      this.gcWorlds();
    }
    this.future = [];
    this.docState = norm.docState;
    if (docChanged) this.docRevision += 1;
    this.analysis = norm.analysis;
    this.termHits = norm.termHits;
    this.lastAnnotationReviewCount = options.structural ? norm.reviewCount : 0;
    this.scheduleSave();
    this.emit();
  }

  /**
   * 整份文档替换事务：粘贴替换 / JSON 导入 / 载入示例统一入口。
   * 替换前状态（含当前世界留痕）作为一帧留在 past 栈底侧，替换后状态作为
   * 新世界的当前帧；撤销整体恢复替换前正文、歧义确认、批注、规范用语规则与
   * 对应留痕，重做恢复替换后的整套状态。替换后若再做普通编辑，仍按现有粒度撤销。
   * 基于旧正文 / 旧确认的会话临时产物（修订预演、引用阅读包）一律失效清空。
   */
  private commitReplacement(next: DocState, nextTraces: TraceState): void {
    const norm = this.normalizeDocState(next);
    const newWorld = this.nextWorldId++;

    // 压栈前先把当前世界最新留痕定格到帧侧：此后（含本次切换本身）
    // 对当前留痕字段的写入不会经由 worlds 反向覆盖栈帧里的旧世界留痕
    this.syncCurrentWorld();

    this.coalesceBaseline = null;
    this.editCoalesceUntil = 0;
    this.ruleCoalesceUntil = 0;
    this.past.push(this.currentFrame);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future = [];

    this.currentWorld = newWorld;
    this.applyTraces(nextTraces);
    this.worlds.set(newWorld, this.currentTraces());

    // 正文版本号：整份替换一定视作正文变化（即便新旧文档对象恰为同一引用）
    this.docRevision += 1;
    this.docState = norm.docState;
    this.analysis = norm.analysis;
    this.termHits = norm.termHits;
    this.lastAnnotationReviewCount = 0;
    // 旧文档的会话临时产物对新文档无意义，禁止再应用 / 复制
    this.sandbox = null;
    this.readingPack = null;
    this.gcWorlds();
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave(): void {
    localStore.save(this.currentPersisted());
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void serverStore.save(this.currentPersisted());
    }, 600);
  }

  // ---------- 历史 ----------

  /**
   * 换入历史帧：重算分析与规范命中；跨越整份文档替换的世界边界时，
   * 保存离开世界的最新留痕、整体换入目标世界留痕，并失效旧文档的
   * 修订预演与引用阅读包（不可再应用 / 复制）。
   */
  private activateFrame(frame: HistoryFrame, leaving: 'past' | 'future'): void {
    const switching = frame.world !== this.currentWorld;
    if (switching) this.syncCurrentWorld();
    if (leaving === 'past') {
      this.future.push(this.currentFrame);
      this.past.pop();
    } else {
      this.past.push(this.currentFrame);
      this.future.pop();
    }

    const prevDoc = this.docState.doc;
    this.currentWorld = frame.world;
    if (switching) {
      const traces = this.worlds.get(frame.world) ?? {
        snapshots: [],
        issueBaselines: [],
        signoffs: [],
        issueExceptions: [],
      };
      this.applyTraces(traces);
      // 跨文档撤销 / 重做：旧文档的预演与阅读包失效，不能应用或复制
      this.sandbox = null;
      this.readingPack = null;
    }
    this.docState = frame.docState;
    if (frame.docState.doc !== prevDoc) this.docRevision += 1;
    this.analysis = analyze(frame.docState.doc, { confirmed: frame.docState.confirmed });
    this.termHits = scanTerms(frame.docState.doc, frame.docState.termRules);
    this.coalesceBaseline = null;
    this.editCoalesceUntil = 0;
    this.ruleCoalesceUntil = 0;
    this.lastAnnotationReviewCount = 0;
    this.lastTermReplace = null;
    if (switching) this.gcWorlds();
    this.scheduleSave();
    this.emit();
  }

  undo(): void {
    const prev = this.past[this.past.length - 1];
    if (!prev) return;
    this.activateFrame(prev, 'past');
  }

  redo(): void {
    const next = this.future[this.future.length - 1];
    if (!next) return;
    this.activateFrame(next, 'future');
  }

  // ---------- 文档内容编辑（带 600ms 合并窗口） ----------

  private editCoalesceUntil = 0;
  /** 规范用语规则连续编辑的合并窗口截止时间 */
  private ruleCoalesceUntil = 0;

  updateNodeText(nodeId: string, text: string): void {
    const root = cloneTree(this.docState.doc.root);
    const found = findNode(root, nodeId);
    if (!found) return;
    found.node.text = text;
    const now = Date.now();
    const coalesce = now < this.editCoalesceUntil;
    this.editCoalesceUntil = now + 800;
    this.commit(
      { ...this.docState, doc: { ...this.docState.doc, root } },
      { coalesce },
    );
  }

  updateArticleMeta(articleId: string, patch: { title?: string; suffix?: string }): void {
    const root = cloneTree(this.docState.doc.root);
    const found = findNode(root, articleId);
    if (!found || found.node.kind !== 'article') return;
    if ('title' in patch) found.node.title = patch.title?.trim() || undefined;
    if ('suffix' in patch) found.node.suffix = patch.suffix?.trim() || undefined;
    this.commit({ ...this.docState, doc: { ...this.docState.doc, root } });
  }

  renameTitle(title: string): void {
    this.commit({ ...this.docState, doc: { ...this.docState.doc, title } }, { coalesce: false });
  }

  // ---------- 结构操作（触发原子引用改写） ----------

  private structural(label: string, mutator: (root: ClauseNode[]) => void): void {
    void label;
    const result = applyStructuralChange(this.docState.doc, this.analysis, mutator);
    this.lastRewriteInfo = {
      rewritten: result.rewritten,
      skipped: result.skipped.length,
    };
    this.commit({ ...this.docState, doc: result.doc }, { structural: true });
  }

  /** 同级内移动（拖拽排序）。toIndex 为删除源节点后的目标下标 */
  reorderSibling(nodeId: string, toIndex: number): void {
    this.structural('reorder', (root) => {
      const found = findNode(root, nodeId);
      if (!found) return;
      const [node] = found.parent.splice(found.index, 1);
      const clamped = Math.max(0, Math.min(toIndex, found.parent.length));
      found.parent.splice(clamped, 0, node);
    });
  }

  /** 跨父级移动（拖拽到另一条/款） */
  moveNode(nodeId: string, targetParentId: string, toIndex: number): void {
    this.structural('move', (root) => {
      const src = findNode(root, nodeId);
      let targetParent: ClauseNode[];
      if (targetParentId === '__root__') {
        targetParent = root;
      } else {
        const tp = findNode(root, targetParentId);
        if (!tp) return;
        targetParent = tp.node.kind === 'article' ? tp.node.children : tp.node.children;
      }
      if (!src) return;
      // 不允许把节点移动进自身后代
      if (findNode(src.node.children, targetParentId)) return;
      const node = src.node;
      // 层级兼容：只允许同 kind 平级移动
      const sample = targetParent[0];
      if (sample && sample.kind !== node.kind) return;
      src.parent.splice(src.index, 1);
      const clamped = Math.max(0, Math.min(toIndex, targetParent.length));
      targetParent.splice(clamped, 0, node);
    });
  }

  /** 手动改编号（仅条）：与同序号条交换位置 */
  renumberArticle(articleId: string, newOrdinal: number): void {
    if (!Number.isInteger(newOrdinal) || newOrdinal < 1) return;
    this.structural('renumber', (root) => {
      const found = findNode(root, articleId);
      if (!found) return;
      const target = root[newOrdinal - 1];
      if (!target || target.id === articleId) return;
      const [node] = root.splice(found.index, 1);
      root.splice(newOrdinal - 1, 0, node);
    });
  }

  deleteNode(nodeId: string): void {
    this.structural('delete', (root) => {
      const found = findNode(root, nodeId);
      if (!found) return;
      found.parent.splice(found.index, 1);
    });
  }

  addArticle(afterId?: string): string {
    const id = uid('art');
    this.structural('add-article', (root) => {
      const node = newArticle('');
      node.id = id;
      const idx = afterId ? root.findIndex((a) => a.id === afterId) + 1 : root.length;
      root.splice(idx, 0, node);
    });
    return id;
  }

  addParagraph(articleId: string): void {
    this.structural('add-paragraph', (root) => {
      const a = findNode(root, articleId);
      if (!a) return;
      a.node.children.push(newParagraph(''));
    });
  }

  addItem(paragraphNodeId: string): void {
    this.structural('add-item', (root) => {
      const p = findNode(root, paragraphNodeId);
      if (!p) return;
      p.node.children.push(newItem(''));
    });
  }

  // ---------- 粘贴导入 / JSON 导入导出 ----------

  importPastedText(raw: string): void {
    const { doc } = parseDocument(raw, this.docState.doc.title);
    // 粘贴替换正文是全新文档（新世界）：旧快照、问题基线、审签、批注与例外处置
    // 不跨文档携带，但作为事务留在历史中，撤销时整套恢复；规范用语规则是用户词表，予以保留
    const nextTraces: TraceState = {
      snapshots: [],
      issueBaselines: [],
      signoffs: [],
      issueExceptions: [],
    };
    this.commitReplacement(
      { doc, confirmed: {}, annotations: [], termRules: this.docState.termRules },
      nextTraces,
    );
  }

  /**
   * JSON 导入：先做全树结构校验（条 → 款 → 项层级、必需字段、全树 ID 唯一），
   * 任一节点不合格即整次拒绝——不提交事务，当前正文、审阅留痕（快照 / 基线 /
   * 审签 / 例外 / 批注）与撤销历史全部保持原状，由调用方展示原因。
   * 校验通过时原样保留全部节点 ID 与附属记录：引用、审签等按节点 ID 的关联
   * 在导入后仍指向原节点。root 为空数组的合法文档同样允许导入。
   */
  importJson(bundle: ExportBundle | PersistedState): { ok: boolean; errors: string[] } {
    const { validation, doc: validDoc } = validateImportBundle(bundle);
    if (!validDoc) return { ok: false, errors: validation.errors };
    // 克隆条款树后再重编号：导入包可能是冻结对象（导出包内快照即只读冻结），
    // 且不应就地改写入参；克隆逐节点保留原 id，引用定位与审签关联不漂移
    const root = cloneTree(validDoc.root);
    renumberAll(root);
    const doc: ClauseDocument = {
      id: validDoc.id || uid('doc'),
      title: typeof validDoc.title === 'string' ? validDoc.title : '未命名条款集',
      root,
      updatedAt: Date.now(),
    };
    const confirmed = bundle.confirmed ?? {};
    // 快照随 JSON 导入；旧文件缺少 snapshots 时按空列表加载
    const snapshots = sanitizeSnapshots(bundle.snapshots);
    // 问题基线随 JSON 导入（重新分析重建问题身份）；旧文件缺少 issueBaselines 时按空列表加载
    const issueBaselines = sanitizeIssueBaselines(bundle.issueBaselines);
    // 批注随 JSON 导入并按导入后的正文重定位；旧文件缺少 annotations 时为空
    const annotations = sanitizeAnnotations(bundle.annotations);
    // 规范用语规则随 JSON 导入；旧文件缺少 termRules 时按空规则加载
    const termRules = sanitizeTermRules(bundle.termRules);
    // 审签记录随 JSON 导入；旧文件缺少 signoffs 时按空列表加载，有效 / 待重签按导入正文实时重算
    const signoffs = sanitizeSignoffs(bundle.signoffs);
    // 例外处置记录随 JSON 导入；旧文件缺少 issueExceptions 时按空列表加载，三态按导入正文实时重算
    const issueExceptions = sanitizeIssueExceptions(bundle.issueExceptions);
    // 导入包的整套状态作为新世界事务：撤销恢复导入前文档及其留痕，重做恢复导入后整套状态
    this.commitReplacement(
      { doc: touch(doc), confirmed, annotations, termRules },
      { snapshots, issueBaselines, signoffs, issueExceptions },
    );
    return { ok: true, errors: [] };
  }

  exportJson(): ExportBundle {
    return {
      app: 'clause-reference-validator',
      version: 1,
      document: this.docState.doc,
      confirmed: this.docState.confirmed,
      snapshots: this.snapshots,
      issueBaselines: this.issueBaselines,
      annotations: this.docState.annotations,
      termRules: this.docState.termRules,
      signoffs: this.signoffs,
      issueExceptions: this.issueExceptions,
      exportedAt: new Date().toISOString(),
    };
  }

  replaceWithSample(doc: ClauseDocument): void {
    // 内置示例为全新文档（新世界）：旧快照、问题基线、审签与例外处置不跨文档携带，
    // 但作为事务留在历史中，撤销时整套恢复；示例自带示例规则，同时保留用户已维护的词表
    this.commitReplacement(
      {
        doc,
        confirmed: {},
        annotations: [],
        termRules: [...sampleTermRules(), ...this.docState.termRules],
      },
      {
        snapshots: [],
        issueBaselines: [],
        signoffs: [],
        issueExceptions: [],
      },
    );
  }

  // ---------- 版本快照（只读；创建/删除不进入正文撤销历史） ----------

  /** 保存当前文档为命名快照，返回新快照 id；批注与规范用语规则随快照一并冻结 */
  saveSnapshot(name: string): string {
    const trimmed = name.trim();
    const snapshot = createSnapshot(
      this.docState.doc,
      this.docState.confirmed,
      trimmed || defaultSnapshotName(this.snapshots.length),
      this.docState.annotations,
      this.docState.termRules,
    );
    this.snapshots = [...this.snapshots, snapshot];
    this.scheduleSave();
    this.emit();
    return snapshot.id;
  }

  /** 删除快照：不影响正文、确认记录与撤销历史 */
  deleteSnapshot(snapshotId: string): void {
    if (!this.snapshots.some((s) => s.id === snapshotId)) return;
    this.snapshots = this.snapshots.filter((s) => s.id !== snapshotId);
    this.scheduleSave();
    this.emit();
  }

  // ---------- 问题基线（只读；创建/删除不进入正文撤销历史，删除不影响正文） ----------

  /** 把当前检测结果保存为命名问题基线，返回新基线 id */
  saveIssueBaseline(name: string): string {
    const trimmed = name.trim();
    const baseline = createIssueBaseline(
      this.docState.doc,
      this.docState.confirmed,
      trimmed || defaultBaselineName(this.issueBaselines.length),
    );
    this.issueBaselines = [...this.issueBaselines, baseline];
    this.scheduleSave();
    this.emit();
    return baseline.id;
  }

  /** 删除问题基线：仅移除基线本身，不影响正文、确认记录、批注、规则与撤销历史 */
  deleteIssueBaseline(baselineId: string): void {
    if (!this.issueBaselines.some((b) => b.id === baselineId)) return;
    this.issueBaselines = this.issueBaselines.filter((b) => b.id !== baselineId);
    this.scheduleSave();
    this.emit();
  }

  // ---------- 条款审签（独立于撤销历史；有效 / 待重签按当前条文指纹实时重算） ----------

  /**
   * 对选定条录入审签人并签署：记录条稳定 ID、签署时间与当时完整条文
   * （条号、标题、正文、款、项）的内容指纹。同一条再次签署时归档上一版签署信息。
   * 签署不改正文、不进入撤销历史；正文被撤销恢复原文时记录指纹重新匹配，自动恢复有效。
   */
  signArticle(articleId: string, signer: string): { ok: boolean; error?: string } {
    const name = signer.trim();
    if (!name) return { ok: false, error: '请填写审签人' };
    const article = findNode(this.docState.doc.root, articleId)?.node;
    if (!article || article.kind !== 'article') {
      return { ok: false, error: '条款不存在或已删除' };
    }
    const existing = this.signoffs.find((s) => s.articleId === articleId);
    const record = signArticle(existing, articleId, name, articleFingerprint(article));
    this.signoffs = [
      ...this.signoffs.filter((s) => s.articleId !== articleId),
      record,
    ];
    this.scheduleSave();
    this.emit();
    return { ok: true };
  }

  /** 当前审签汇总（供面板与徽标使用；已删除条记录单列、不计入统计） */
  getSignoffView(): SignoffView {
    return buildSignoffView(this.docState.doc, this.signoffs);
  }

  // ---------- 断链 / 自引用问题的例外处置（独立持久化，不进入撤销历史；状态按当前分析实时重算） ----------

  /**
   * 对当前断链 / 自引用问题填写理由并标记「接受例外」。
   * 记录绑定稳定问题身份并保存处置时的来源句原文；同一身份已有记录时覆盖（刷新证据与时间）。
   * 处置不改正文、不进入撤销历史。
   */
  acceptIssueException(identity: string, reason: string): { ok: boolean; error?: string } {
    const trimmed = reason.trim();
    if (!trimmed) return { ok: false, error: '请填写接受例外的理由' };
    const issue = this.analysis.issues.find(
      (i) => i.identity === identity && isExceptionableIssue(i),
    );
    if (!issue) return { ok: false, error: '该问题已不存在，无法接受例外' };
    const record = acceptIssueException(issue, this.analysis, trimmed);
    this.issueExceptions = [
      ...this.issueExceptions.filter((r) => r.identity !== identity),
      record,
    ];
    this.scheduleSave();
    this.emit();
    return { ok: true };
  }

  /**
   * 待复核项重新确认：以当前实时问题刷新来源句证据，理由沿用复核框内容并刷新处置时间。
   * 仅当身份仍在当前问题集合（已接受 / 待复核）时允许；已消失的记录须先在「已消失」区处理。
   */
  reconfirmIssueException(identity: string, reason: string): { ok: boolean; error?: string } {
    const current = this.issueExceptions.find((r) => r.identity === identity);
    if (!current) return { ok: false, error: '例外处置记录不存在' };
    const trimmed = reason.trim();
    if (!trimmed) return { ok: false, error: '请填写接受例外的理由' };
    const issue = this.analysis.issues.find(
      (i) => i.identity === identity && isExceptionableIssue(i),
    );
    if (!issue) return { ok: false, error: '问题已消失，无法重新确认' };
    const record = reconfirmIssueException(current, issue, this.analysis, trimmed);
    this.issueExceptions = this.issueExceptions.map((r) => (r.identity === identity ? record : r));
    this.scheduleSave();
    this.emit();
    return { ok: true };
  }

  /** 撤销处置：删除该例外记录，问题恢复为未处置（不改正文、不进入撤销历史） */
  revokeIssueException(identity: string): void {
    if (!this.issueExceptions.some((r) => r.identity === identity)) return;
    this.issueExceptions = this.issueExceptions.filter((r) => r.identity !== identity);
    this.scheduleSave();
    this.emit();
  }

  /** 删除已消失问题的例外留痕（仅清理记录，不影响正文） */
  deleteIssueException(recordId: string): void {
    if (!this.issueExceptions.some((r) => r.id === recordId)) return;
    this.issueExceptions = this.issueExceptions.filter((r) => r.id !== recordId);
    this.scheduleSave();
    this.emit();
  }

  /** 当前例外处置逐条判定（供面板筛选与标记；已接受 / 待复核 / 已消失按当前分析实时重算） */
  getExceptionView(): IssueExceptionEntry[] {
    return buildIssueExceptionView(this.analysis, this.issueExceptions);
  }

  // ---------- 修订沙盒（会话内预演：在文档克隆上复用结构改写与分析，不改动正文与撤销历史） ----------

  /**
   * 生成条级删除 / 移位 / 换号的修订预演。
   * 预演在当前文档的克隆上执行，正文、确认记录与撤销历史均不受影响；
   * 预演记录生成时的正文版本号，正文变化后失效并禁止应用。
   */
  runSandboxPreview(op: SandboxOp): { ok: boolean; error?: string } {
    const built = buildSandboxPreview(
      this.docState.doc,
      this.analysis,
      this.docState.confirmed,
      op,
      this.docRevision,
    );
    if ('error' in built) return { ok: false, error: built.error };
    this.sandbox = built;
    this.emit();
    return { ok: true };
  }

  /** 放弃当前预演（不影响正文与撤销历史） */
  discardSandboxPreview(): void {
    if (!this.sandbox) return;
    this.sandbox = null;
    this.emit();
  }

  /** 预演失效判定：正文版本号或歧义确认记录（影响改写计划）较生成时发生变化 */
  private isSandboxStale(preview: SandboxPreview): boolean {
    return (
      preview.docRevision !== this.docRevision ||
      !confirmedEqual(preview.confirmed, this.docState.confirmed)
    );
  }

  /**
   * 应用当前预演：仅未失效（正文版本号与歧义确认记录均未变）时允许；
   * 该操作及全部引用改写作为一步提交，支持整体撤销 / 重做。
   */
  applySandboxPreview(): boolean {
    const preview = this.sandbox;
    if (!preview || this.isSandboxStale(preview)) return false;
    this.lastRewriteInfo = {
      rewritten: preview.rewrittenCount,
      skipped: preview.skipped.length,
    };
    this.sandbox = null;
    this.commit({ ...this.docState, doc: preview.resultDoc }, { structural: true });
    return true;
  }

  // ---------- 引用阅读包（会话内临时产物：不持久化、不进入撤销历史） ----------

  /**
   * 以指定条款为起点生成引用阅读包：沿当前确认后的解析关系向目标方向
   * 逐层收集直接 / 间接依赖条款。阅读包记录生成时的正文版本号与确认记录，
   * 正文或歧义确认变化后失效，须重新生成。
   */
  generateReadingPack(articleId: string): { ok: boolean; error?: string } {
    const built = buildReadingPack(
      this.docState.doc,
      this.analysis,
      articleId,
      this.docRevision,
      this.docState.confirmed,
    );
    if ('error' in built) return { ok: false, error: built.error };
    this.readingPack = built;
    this.emit();
    return { ok: true };
  }

  /** 正文或确认变化后按最新状态重新生成；起点已删除时返回失败 */
  regenerateReadingPack(): { ok: boolean; error?: string } {
    if (!this.readingPack) return { ok: false, error: '尚未生成阅读包' };
    return this.generateReadingPack(this.readingPack.sourceId);
  }

  /** 清空当前阅读包（不影响正文与撤销历史） */
  clearReadingPack(): void {
    if (!this.readingPack) return;
    this.readingPack = null;
    this.emit();
  }

  // ---------- 歧义确认 ----------

  confirmAmbiguous(signature: string, targetId: string): void {
    this.commit({
      ...this.docState,
      confirmed: { ...this.docState.confirmed, [signature]: targetId },
    });
  }

  clearConfirmation(signature: string): void {
    const confirmed = { ...this.docState.confirmed };
    delete confirmed[signature];
    this.commit({ ...this.docState, confirmed });
  }

  // ---------- 审阅批注 ----------

  /** 在指定节点的正文片段上创建批注，返回新批注 id */
  addAnnotation(nodeId: string, start: number, end: number, content: string): string | null {
    const node = findNode(this.docState.doc.root, nodeId)?.node;
    if (!node) return null;
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    if (!node.text || s < 0 || e <= s || e > node.text.length) return null;
    const annotation = makeAnnotation(nodeId, s, e, node.text, content.trim());
    this.commit({ ...this.docState, annotations: [...this.docState.annotations, annotation] });
    return annotation.id;
  }

  /** 编辑批注正文；若同时重选片段则更新锚点并重新锚定 */
  updateAnnotation(
    annotationId: string,
    patch: { content?: string; nodeId?: string; start?: number; end?: number },
  ): void {
    const current = this.docState.annotations.find((a) => a.id === annotationId);
    if (!current) return;
    let next: Annotation = { ...current, content: current.content, updatedAt: Date.now() };
    if (typeof patch.content === 'string') next.content = patch.content;
    if (
      patch.nodeId !== undefined &&
      patch.start !== undefined &&
      patch.end !== undefined
    ) {
      const node = findNode(this.docState.doc.root, patch.nodeId)?.node;
      if (node && patch.nodeId !== current.nodeId) {
        // 跨节点重选：以新片段重建锚点
        const rebuilt = makeAnnotation(
          patch.nodeId,
          patch.start,
          patch.end,
          node.text,
          next.content,
          next.updatedAt,
        );
        next = { ...rebuilt, id: current.id, createdAt: current.createdAt };
      } else if (node) {
        const s = Math.min(patch.start, patch.end);
        const e = Math.max(patch.start, patch.end);
        if (s >= 0 && e > s && e <= node.text.length) {
          next.nodeId = patch.nodeId;
          next.start = s;
          next.end = e;
          next.quote = node.text.slice(s, e);
          next.prefix = node.text.slice(Math.max(0, s - ANCHOR_CTX), s);
          next.suffix = node.text.slice(e, e + ANCHOR_CTX);
          next.status = 'anchored';
          next.reason = undefined;
          next.candidates = undefined;
        }
      }
    }
    this.commit({
      ...this.docState,
      annotations: this.docState.annotations.map((a) => (a.id === annotationId ? next : a)),
    });
  }

  deleteAnnotation(annotationId: string): void {
    if (!this.docState.annotations.some((a) => a.id === annotationId)) return;
    this.commit({
      ...this.docState,
      annotations: this.docState.annotations.filter((a) => a.id !== annotationId),
    });
  }

  /** 在候选中确认一个位置，批注重新锚定（正文或结构再次调整后仍继续尝试重定位） */
  resolveAnnotation(annotationId: string, nodeId: string, start: number, end: number): void {
    const current = this.docState.annotations.find((a) => a.id === annotationId);
    if (!current) return;
    const node = findNode(this.docState.doc.root, nodeId)?.node;
    if (!node) return;
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    if (s < 0 || e <= s || e > node.text.length) return;
    // quote 保持创建时原文；若确认位置的当前文字不同则以当前文字更新片段锚点
    const currentText = node.text.slice(s, e);
    const next: Annotation = {
      ...current,
      nodeId,
      start: s,
      end: e,
      quote: currentText || current.quote,
      prefix: node.text.slice(Math.max(0, s - ANCHOR_CTX), s),
      suffix: node.text.slice(e, e + ANCHOR_CTX),
      status: 'anchored',
      reason: undefined,
      candidates: undefined,
      updatedAt: Date.now(),
    };
    this.commit({
      ...this.docState,
      annotations: this.docState.annotations.map((a) => (a.id === annotationId ? next : a)),
    });
  }

  // ---------- 派生查询 ----------

  /** 当前正文版本号（仅正文内容变化时递增；供会话内临时产物做失效判定） */
  getDocRevision(): number {
    return this.docRevision;
  }

  targetOfRef(refKey: string): string | null {
    const occ = this.analysis.occurrences.find((o) => o.key === refKey);
    return occ?.resolution.targetId ?? null;
  }

  articleOf(nodeId: string): ClauseNode | null {
    return findArticleOf(this.docState.doc.root, nodeId);
  }

  // ---------- 规范用语规则 ----------

  /** 新增一条空规则，返回其 id */
  addTermRule(): string {
    const rule = createTermRule();
    this.commit({ ...this.docState, termRules: [...this.docState.termRules, rule] });
    return rule.id;
  }

  /**
   * 更新规则规范词/变体；连续输入按一个撤销步合并。
   * trim=true（失焦 / 回车）时规整空白与重复变体；输入过程中保留原文以免打断光标。
   */
  updateTermRule(
    ruleId: string,
    patch: { canonical?: string; variants?: string[] },
    trim = false,
  ): void {
    const now = Date.now();
    const coalesce = now < this.ruleCoalesceUntil;
    this.ruleCoalesceUntil = now + 800;
    const termRules = this.docState.termRules.map((r) =>
      r.id === ruleId
        ? {
            ...r,
            ...(patch.canonical !== undefined
              ? { canonical: trim ? patch.canonical.trim() : patch.canonical }
              : {}),
            ...(patch.variants !== undefined
              ? {
                  variants: trim
                    ? patch.variants
                        .map((v) => v.trim())
                        .filter((v, i, arr) => v && arr.indexOf(v) === i)
                    : patch.variants,
                }
              : {}),
          }
        : r,
    );
    this.commit({ ...this.docState, termRules }, { coalesce });
  }

  deleteTermRule(ruleId: string): void {
    if (!this.docState.termRules.some((r) => r.id === ruleId)) return;
    this.commit({
      ...this.docState,
      termRules: this.docState.termRules.filter((r) => r.id !== ruleId),
    });
  }

  /** 上移 / 下移规则（规则顺序是同长同起点命中的消解优先级） */
  moveTermRule(ruleId: string, dir: -1 | 1): void {
    const idx = this.docState.termRules.findIndex((r) => r.id === ruleId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= this.docState.termRules.length) return;
    const termRules = [...this.docState.termRules];
    [termRules[idx], termRules[target]] = [termRules[target], termRules[idx]];
    this.commit({ ...this.docState, termRules });
  }

  /**
   * 批量替换：仅处理扫描快照中的已勾选命中。
   * 提交前逐项核对节点 ID 与原文区间；任一项已变化（含已不在当前扫描快照中）
   * 则整批拒绝（不改正文），全部有效时按节点从后向前单遍替换，
   * 作为一步支持整体撤销/重做。
   * 返回实际替换数；被拒绝时返回 0 并记录失效命中数供界面提示。
   */
  replaceSelectedTerms(selectedKeys: string[]): { replaced: number; stale: number } {
    const byKey = new Map(this.termHits.map((h) => [h.key, h]));
    // 调用方传入的是扫描快照中的 key：当前快照中找不到同样视为“已变化”，计入失效而非静默丢弃
    const chosen: TermHit[] = [];
    let stale = 0;
    const seen = new Set<string>();
    for (const key of selectedKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = byKey.get(key);
      if (hit) chosen.push(hit);
      else stale++;
    }
    if (chosen.length === 0 && stale === 0) return { replaced: 0, stale: 0 };
    if (stale > 0) {
      this.lastTermReplace = { replaced: 0, stale };
      this.emit();
      return { replaced: 0, stale };
    }
    const root = cloneTree(this.docState.doc.root);
    const result = replaceTermHits({ ...this.docState.doc, root }, chosen);
    this.lastTermReplace = { replaced: result.replaced, stale: result.stale };
    if (result.stale > 0) {
      // 整批拒绝：不提交历史，仅触发提示
      this.emit();
      return { replaced: 0, stale: result.stale };
    }
    this.commit({ ...this.docState, doc: result.doc });
    return { replaced: result.replaced, stale: 0 };
  }
}

function defaultSnapshotName(existing: number): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `快照 ${existing + 1}（${stamp}）`;
}

function defaultBaselineName(existing: number): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `问题基线 ${existing + 1}（${stamp}）`;
}

import.meta.hot?.accept();

export function useStore(store: AppStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export async function bootstrapStore(): Promise<AppStore> {
  // 优先本地浏览器存储；首次使用时尝试加载服务器端文件（跨浏览器共享）
  const local = localStore.load();
  if (local) return new AppStore(local);
  const remote = await serverStore.load();
  if (remote) return new AppStore(remote);
  const { sampleDocument, sampleTermRules } = await import('./sample');
  return new AppStore({
    doc: sampleDocument(),
    confirmed: {},
    annotations: [],
    termRules: sampleTermRules(),
  });
}
