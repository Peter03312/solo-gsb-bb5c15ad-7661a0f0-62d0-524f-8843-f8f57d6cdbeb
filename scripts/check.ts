import { parseDocument } from '../src/lib/parser';
import { analyze } from '../src/lib/analyzer';
import { applyStructuralChange } from '../src/lib/rewriter';
import { scanReferences } from '../src/lib/scanner';
import { parseOrdinal, formatChinese } from '../src/lib/numeral';
import { diffDocuments, diffText, MAX_LCS_CHARS } from '../src/lib/diff';
import { createSnapshot, sanitizeSnapshots } from '../src/lib/snapshot';
import { cloneTree, renumberAll } from '../src/lib/tree';
import {
  createAnnotation,
  relocateAnnotations,
  sanitizeAnnotations,
  findAll,
} from '../src/lib/annotations';
import {
  scanTerms,
  replaceTermHits,
  sanitizeTermRules,
  effectiveVariants,
  isHitCurrent,
} from '../src/lib/terminology';
import { AppStore } from '../src/lib/store';
import {
  createIssueBaseline,
  sanitizeIssueBaselines,
  analyzeIssueBaseline,
  diffIssueBaseline,
} from '../src/lib/issueBaseline';
import { computeImpact } from '../src/lib/impact';
import {
  buildSandboxPreview,
  sandboxIssueJump,
  sandboxRewriteJump,
} from '../src/lib/sandbox';
import {
  buildReadingPack,
  isReadingPackStale,
  readingPackWarningJump,
  renderReadingPackText,
} from '../src/lib/readingpack';
import {
  articleFingerprint,
  buildSignoffView,
  canonicalArticle,
  fnv1a64,
  sanitizeSignoffs,
} from '../src/lib/signoff';
import {
  acceptIssueException,
  buildIssueExceptionView,
  isExceptionableIssue,
  reconfirmIssueException,
  sanitizeIssueExceptions,
} from '../src/lib/exception';
import { findReferencePath } from '../src/lib/pathfind';
import { boundaryOffset, linearText, type SeqNodeAdapter } from '../src/lib/selection';
import {
  validateClauseDocument,
  validateImportBundle,
  isValidPersistedState,
} from '../shared/validation';
import { sampleDocument } from '../src/lib/sample';
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name} ${extra}`);
  }
}

// ---- 数字解析 ----
check('中文 一', parseOrdinal('一')?.value === 1);
check('中文 十', parseOrdinal('十')?.value === 10);
check('中文 二十三', parseOrdinal('二十三')?.value === 23);
check('中文 一百零五', parseOrdinal('一百零五')?.value === 105);
check('阿拉伯 12', parseOrdinal('12')?.value === 12);
check('全角 １２', parseOrdinal('１２')?.value === 12);
check('零非法', parseOrdinal('零') === null);
check('格式 23→二十三', formatChinese(23) === '二十三', formatChinese(23));
check('格式 105→一百零五', formatChinese(105) === '一百零五', formatChinese(105));
check('格式 10→十', formatChinese(10) === '十', formatChinese(10));

// ---- 扫描器 ----
const spans = scanReferences(
  '依第五条第二款第（一）项及本条第三款、前款第（二）项、前项、后条、第十二条规定。',
);
const raws = spans.map((s) => s.raw);
check('绝对条款项', raws.includes('第五条第二款第（一）项'), JSON.stringify(raws));
check('本条', raws.includes('本条第三款'), JSON.stringify(raws));
check('前款', raws.some((r) => r.startsWith('前款')), JSON.stringify(raws));
check('前项', raws.includes('前项'), JSON.stringify(raws));
check('后条', raws.includes('后条'), JSON.stringify(raws));
check('第十二条', raws.includes('第十二条'), JSON.stringify(raws));

// ---- 解析 ----
const text = `测试办法

第一条【目的】
为了测试，适用第三条和第四条第一款的规定。

第二条【范围】
本法适用范围如下：
（一）情形一，参见第三条第二款；
（二）情形二，参见前款和第五条。

第三条【程序一】
第一款内容。
本条第二款引用第四条，本条第三款引用第六条造成循环。

第四条【程序二】
本条援引第三条形成循环。
另引用不存在的第二十条。

第五条【附则】
最后一条引用前条。`;

const { doc } = parseDocument(text);
check('解析出 5 条', doc.root.length === 5, String(doc.root.length));
check('标题', doc.title === '测试办法', doc.title);
// 第三条：第一段“第一款内容。”结束后换行，第二段为“本条第二款…循环。”
check('第三条有 2 款', doc.root[2].children.length === 2, String(doc.root[2].children.length));
check('第二条有 1 款 2 项', doc.root[1].children.length === 1 && doc.root[1].children[0].children.length === 2);

let a = analyze(doc, { confirmed: {} });
check('存在断链(第二十条)', a.issues.some((i) => i.type === 'broken' && i.message.includes('二十')), JSON.stringify(a.issues.map(i=>i.message)));
check('存在循环(三<->四)', a.issues.some((i) => i.type === 'cycle'), JSON.stringify(a.issues.map(i=>i.type)));
const okRef = a.occurrences.find((o) => o.span.raw === '第三条');
check('"第三条" 唯一定位', okRef?.resolution.status === 'ok' && okRef.resolution.targetId === doc.root[2].id);
const paraRef = a.occurrences.find((o) => o.span.raw === '第四条第一款');
check('"第四条第一款" 定位到款', paraRef?.resolution.status === 'ok' && paraRef.resolution.targetId === doc.root[3].children[0].id);
check('边数量>0', a.edges.length > 5, String(a.edges.length));

// ---- 原子改写：把第三条移动到末尾（3->5, 4->3, 5->4） ----
const root = doc.root.map((n) => n);
const result = applyStructuralChange(doc, a, (r) => {
  const third = r.splice(2, 1)[0];
  r.push(third);
});
check('改写数量 > 0', result.rewritten > 0, String(result.rewritten));
const a2 = analyze(result.doc, { confirmed: {} });
const texts = JSON.stringify(result.doc);
check('原"第三条"被改写', !texts.includes('适用第三条和'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
check('指向移动条的引用变为第五条', texts.includes('适用第五条'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
// 循环引用应依然存在（三/四换了编号但文本都改写后仍互指）
check('改写后仍检出循环', a2.issues.some((i) => i.type === 'cycle'), JSON.stringify(a2.issues.map(i=>i.type)));
// 断链依然存在
check('断链保留', a2.issues.some((i) => i.type === 'broken'));
// 移动后新位置条
check('移动后原第三条位于第 5 位', result.doc.root[4].id === doc.root[2].id);

// ---- 自引用检测 ----
const selfText = `第一条
本款就是本款。`;
const selfDoc = parseDocument(selfText).doc;
const selfAnalysis = analyze(selfDoc, { confirmed: {} });
check(
  '自引用检出（本项/本款自指）',
  selfAnalysis.issues.some((i) => i.type === 'self'),
  JSON.stringify(selfAnalysis.issues.map((i) => i.message)),
);

// 条内绝对回指本条 → 自引用；相对“本条”不算
const absSelf = parseDocument(`第五条
本条规定按第五条执行。`).doc;
absSelf.root[0].ordinal = 5;
const absSelfA = analyze(absSelf, { confirmed: {} });
const selfCount = absSelfA.issues.filter((i) => i.type === 'self').length;
check('绝对回指本条计 1 次自引用，本条相对引用不计', selfCount === 1, String(selfCount));

// ---- 歧义：同序号条 ----
const amb = parseDocument(`第八条
参见第八条。

第八条之一
补充规定。`).doc;
// parser 不生成后缀，手工标记
amb.root[1].suffix = '一';
const ambA = analyze(amb, { confirmed: {} });
check('同序号歧义', ambA.issues.some((i) => i.type === 'ambiguous'), JSON.stringify(ambA.issues.map(i=>i.message)));

// ---- 版本对比：节点差异（新增 / 删除 / 修改 / 移动，移动且修改同时保留） ----
{
  const base = parseDocument(`比较法

第一条【一】
初始正文，引用第三条。

第二条【二】
第二条内容。

第三条【三】
第三条内容。`).doc;
  renumberAll(base.root);
  const baseA = analyze(base, { confirmed: {} });

  // 修改版：第一条改正文（条头）并移动到末尾（同一节点同时移动+修改）；删除第二条；末尾新增一条
  const root2 = cloneTree(base.root);
  root2[0].text = '修改后的条头正文。';
  const first = root2.shift()!; // 移除第一条
  root2.shift(); // 移除第二条 → 余下 [第三条]
  root2.push(first); // [第三条, 第一条]
  root2.push({ id: 'art-new', kind: 'article', ordinal: 0, text: '', children: [
    { id: 'par-new', kind: 'paragraph', ordinal: 1, text: '新增条内容。', children: [] },
  ] });
  renumberAll(root2);
  const modified: typeof base = { ...base, root: root2, updatedAt: base.updatedAt + 1 };
  const modA = analyze(modified, { confirmed: {} });

  const d = diffDocuments(baseA, modA, base, modified);

  const firstArticle = d.entries.get(base.root[0].id)!;
  check('移动的条标记 moved', firstArticle.moved === true, JSON.stringify(firstArticle));
  check('移动且改正文同时标记 contentModified', firstArticle.contentModified === true);
  check('同一节点保留两类变化', firstArticle.moved && firstArticle.contentModified);
  check('移动的款（留位同序）无差异条目', d.entries.get(base.root[0].children[0].id) === undefined);
  const secondEntry = d.entries.get(base.root[1].id)!;
  check('删除的条标记 removed', secondEntry.removed === true);
  check('新增的条标记 added', d.entries.get('art-new')?.added === true);
  check('新增条下的款也标记 added', d.entries.get('par-new')?.added === true);
  check('计数：删除 1', d.counts.removed === 1, String(d.counts.removed));
  check('计数：新增 2（条+款）', d.counts.added === 2, String(d.counts.added));
  check('计数：正文修改 1', d.counts.modified === 1, String(d.counts.modified));
  // 顺序变为 [三, 一, 新增]：条级移动 2（三、一），其余条的款随同级 ordinal 变化亦计移动
  check('计数：位置移动 ≥ 3（含随父重排的款）', d.counts.moved >= 3, String(d.counts.moved));

  // 仅移动不改正文：不应标记 contentModified
  const root3 = cloneTree(base.root);
  const movedFirst = root3.shift()!;
  root3.push(movedFirst);
  renumberAll(root3);
  const movedDoc = { ...base, root: root3 };
  const d3 = diffDocuments(baseA, analyze(movedDoc, { confirmed: {} }), base, movedDoc);
  const e3 = d3.entries.get(base.root[0].id)!;
  check('只移动未改正文：moved=true、contentModified=false', e3.moved && !e3.contentModified, JSON.stringify(e3));

  // 新增条的子孙也应标记为 added
  const withChild = cloneTree(base.root);
  withChild.push({
    id: 'art-c',
    kind: 'article',
    ordinal: 0,
    text: '',
    children: [
      { id: 'par-c', kind: 'paragraph', ordinal: 1, text: '新款', children: [
        { id: 'itm-c', kind: 'item', ordinal: 1, text: '新项', children: [] },
      ] },
    ],
  });
  renumberAll(withChild);
  const docChild = { ...base, root: withChild };
  const dChild = diffDocuments(baseA, analyze(docChild, { confirmed: {} }), base, docChild);
  check('新增条下的款也标记 added', dChild.entries.get('par-c')?.added === true);
  check('新增条下的项也标记 added', dChild.entries.get('itm-c')?.added === true);
}

// ---- 版本对比：引用差异按 源节点ID+原文+同文序次 对齐 ----
{
  const refDoc = parseDocument(`引用法

第一条
见第三条。

第二条
保留。

第三条
被引用的条。`).doc;
  renumberAll(refDoc.root);
  const refA = analyze(refDoc, { confirmed: {} });
  const firstParaId = refDoc.root[0].children[0].id;

  // 把第三条移到最前且不原子改写文本：原“第三条”（原文不变）解析到不同稳定节点 → 目标变化
  const rootB = cloneTree(refDoc.root);
  const third = rootB.splice(2, 1)[0];
  rootB.unshift(third); // [三, 一, 二]
  renumberAll(rootB);
  const docB = { ...refDoc, root: rootB };
  const aB = analyze(docB, { confirmed: {} });
  const d = diffDocuments(refA, aB, refDoc, docB);
  check(
    '原文不变但解析目标改变 → 目标变化 1 条',
    d.refRetargeted.length === 1 && d.refRetargeted[0].raw === '第三条',
    JSON.stringify(d.refRetargeted.map((r) => [r.raw, r.oldTargetId, r.newTargetId])),
  );
  check('目标变化项记录源节点稳定 ID', d.refRetargeted[0].nodeId === firstParaId);

  // 直接改正文：把引用改成“第二条”
  const rootC = cloneTree(refDoc.root);
  rootC[0].children[0].text = '见第二条。';
  const docC = { ...refDoc, root: rootC };
  const dC = diffDocuments(refA, analyze(docC, { confirmed: {} }), refDoc, docC);
  check('引用移除 1（第三条）', dC.refRemoved.length === 1 && dC.refRemoved[0].raw === '第三条', JSON.stringify(dC.refRemoved.map((r) => r.raw)));
  check('引用新增 1（第二条）', dC.refAdded.length === 1 && dC.refAdded[0].raw === '第二条', JSON.stringify(dC.refAdded.map((r) => r.raw)));

  // 同文序次：同节点两条相同原文，删去第二次出现应只标记第二次移除
  const dupDoc = parseDocument(`重复法

第一条
两次引用：见第三条；再次见第三条。

第二条
中间条。

第三条
目标条。`).doc;
  renumberAll(dupDoc.root);
  const dupA = analyze(dupDoc, { confirmed: {} });
  const rootD = cloneTree(dupDoc.root);
  rootD[0].children[0].text = '两次引用：见第三条。';
  const dupDoc2 = { ...dupDoc, root: rootD };
  const dD = diffDocuments(dupA, analyze(dupDoc2, { confirmed: {} }), dupDoc, dupDoc2);
  check('同文序次对齐：移除第二次出现', dD.refRemoved.length === 1 && dD.refRemoved[0].occurrenceIndex === 2, String(dD.refRemoved[0]?.occurrenceIndex));
  check('同文序次对齐：第一次出现保留（非新增）', dD.refAdded.length === 0, String(dD.refAdded.length));
}

// ---- 快照：只读、旧数据缺省为空列表 ----
{
  const s = parseDocument(`快照法

第一条
内容。`).doc;
  renumberAll(s.root);
  const snap = createSnapshot(s, {}, '一审稿');
  check('快照名称保留', snap.name === '一审稿');
  check('快照与正文脱离引用（深拷贝）', snap.doc.root[0] !== s.root[0]);
  let froze = false;
  try {
    'use strict';
    (snap as unknown as { name: string }).name = 'x';
    froze = snap.name === '一审稿';
  } catch {
    froze = true;
  }
  check('快照只读（冻结）', froze);
  check('旧数据缺少 snapshots → 空列表', sanitizeSnapshots(undefined).length === 0);
  check('非法快照项被过滤', sanitizeSnapshots([{ name: 'x' }, null, 42]).length === 0);
  check(
    '合法快照项保留',
    sanitizeSnapshots([{ id: 'q', name: 'q', createdAt: 1, doc: s, confirmed: {} }]).length === 1,
  );
}

// ---- 正文逐字差异 ----
{
  const segs = diffText('适用第三条规定', '适用第五条规定');
  const rebuilt = segs
    .filter((s) => s.type !== 'del')
    .map((s) => s.text)
    .join('');
  const added = segs.filter((s) => s.type === 'add').map((s) => s.text).join('');
  const removed = segs.filter((s) => s.type === 'del').map((s) => s.text).join('');
  check('逐字差异拼回新文本（same+add）', rebuilt === '适用第五条规定', rebuilt);
  check('逐字差异：删除“三”', removed === '三', removed);
  check('逐字差异：新增“五”', added === '五', added);
  check('相同文本只有 same', diffText('abc', 'abc').length === 1 && diffText('abc', 'abc')[0].type === 'same');
  // 长文本退化策略不抛错
  const long = '字'.repeat(MAX_LCS_CHARS + 10);
  const segsLong = diffText(long, long + '尾');
  check('超长文本退化为整段差异', segsLong.some((s) => s.type === 'add'));
}

// ---- 审阅批注：创建锚点 ----
{
  const d = parseDocument(`批注法

第一条【目的】
为了规范批注活动，制定本办法。

第二条【程序】
起草、审查与公布，均适用本办法。`).doc;
  renumberAll(d.root);
  const firstTextNode = d.root[0].children[0];
  const q = '制定本办法';
  const pos = firstTextNode.text.indexOf(q);
  const ann = createAnnotation(firstTextNode.id, pos, pos + q.length, firstTextNode.text, '措辞待斟酌');
  check('批注创建：状态锚定', ann.status === 'anchored');
  check('批注创建：记录引用片段', ann.quote === q);
  check('批注创建：前文锚点非空', ann.prefix.length > 0);
  check('批注创建：后文锚点为句末标点', ann.suffix === '。');
  check('片段查找：唯一', findAll(firstTextNode.text, q).length === 1);
  check('片段查找：多处', findAll('aaa', 'a').length === 3);
}

// ---- 审阅批注：正文未变时位置不动 ----
{
  const d = parseDocument(`批注法

第一条
为了规范批注活动，制定本办法。`).doc;
  renumberAll(d.root);
  const n = d.root[0].children[0];
  const q = '规范批注';
  const pos = n.text.indexOf(q);
  const ann = createAnnotation(n.id, pos, pos + q.length, n.text, 'x');
  const r = relocateAnnotations([ann], d);
  check('正文未变：批注保持锚定', r.annotations[0].status === 'anchored' && r.annotations[0].start === pos);
  check('正文未变：无新增待复核', r.reviewIds.length === 0);
}

// ---- 审阅批注：片段在节点内偏移移动（前文插入）自动跟随 ----
{
  const d0 = parseDocument(`批注法

第一条
为了规范批注活动，制定本办法。`).doc;
  renumberAll(d0.root);
  const n = d0.root[0].children[0];
  const q = '制定本办法';
  const ann = createAnnotation(n.id, n.text.indexOf(q), n.text.indexOf(q) + q.length, n.text, 'x');
  const d = parseDocument(`批注法

第一条
【新增前缀】为了规范批注活动，制定本办法。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = n.id;
  const r = relocateAnnotations([ann], d);
  const nn = d.root[0].children[0];
  check('前文插入：批注自动跟随新偏移', r.annotations[0].status === 'anchored' && r.annotations[0].start === nn.text.indexOf(q), String(r.annotations[0].start));
}

// ---- 审阅批注：多处匹配标为待复核并保留候选 ----
{
  const d = parseDocument(`批注法

第一条
同意、同意、同意。`).doc;
  renumberAll(d.root);
  const n = d.root[0].children[0];
  const ann = createAnnotation(n.id, 0, 2, n.text, 'x');
  const r = relocateAnnotations([ann], d);
  check('多处匹配：待复核', r.annotations[0].status === 'review');
  check('多处匹配：原因 multi-in-node', r.annotations[0].reason === 'multi-in-node');
  check('多处匹配：保留 3 个候选', (r.annotations[0].candidates?.length ?? 0) === 3, String(r.annotations[0].candidates?.length));
}

// ---- 审阅批注：节点删除后全文唯一匹配自动重锚 ----
{
  const d0 = parseDocument(`批注法

第一条
甲条款内容。

第二条
乙条款内容。`).doc;
  renumberAll(d0.root);
  const q = '乙条款内容';
  const ann = createAnnotation(d0.root[1].children[0].id, 0, q.length, q, 'x');
  // 删除第二条，把其正文并入第三条
  const d = parseDocument(`批注法

第一条
甲条款内容。

第三条
乙条款内容。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = d0.root[0].children[0].id;
  const r = relocateAnnotations([ann], d);
  check('节点删除+全文唯一：自动锚到新节点', r.annotations[0].status === 'anchored' && r.annotations[0].nodeId === d.root[1].children[0].id, r.annotations[0].nodeId);
}

// ---- 审阅批注：节点删除且片段消失 → node-missing 待复核 ----
{
  const d0 = parseDocument(`批注法

第一条
甲条款内容。

第二条
乙条款内容。`).doc;
  renumberAll(d0.root);
  const q = '乙条款内容';
  const ann = createAnnotation(d0.root[1].children[0].id, 0, q.length, q, 'x');
  const d = parseDocument(`批注法

第一条
甲条款内容。

第二条
完全不同的新文字。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = d0.root[0].children[0].id;
  d.root[1].id = d0.root[1].id;
  d.root[1].children[0].id = d0.root[1].children[0].id; // 节点 id 保留但文字已改
  const r1 = relocateAnnotations([ann], d);
  check('节点在但片段缺失：missing', r1.annotations[0].status === 'review' && r1.annotations[0].reason === 'missing', r1.annotations[0].reason ?? '');

  const d2 = parseDocument(`批注法

第一条
甲条款内容。`).doc;
  renumberAll(d2.root);
  d2.root[0].id = d0.root[0].id;
  d2.root[0].children[0].id = d0.root[0].children[0].id;
  const r2 = relocateAnnotations([ann], d2);
  check('节点删除且找不到：node-missing', r2.annotations[0].status === 'review' && r2.annotations[0].reason === 'node-missing', r2.annotations[0].reason ?? '');
}

// ---- 审阅批注：归一化（空白/标点差异）匹配 ----
{
  const d0 = parseDocument(`批注法

第一条
引用第五条第二款的规定。`).doc;
  renumberAll(d0.root);
  const n0 = d0.root[0].children[0];
  const q = '第五条第二款';
  const ann = createAnnotation(n0.id, n0.text.indexOf(q), n0.text.indexOf(q) + q.length, n0.text, 'x');
  // 正文在引用片段中间插入了顿号；归一化（剥离标点）后应唯一重锚
  const d = parseDocument(`批注法

第一条
引用第五条、第二款的规定。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = n0.id;
  const r = relocateAnnotations([ann], d);
  check('归一化匹配：标点差异自动重锚', r.annotations[0].status === 'anchored', r.annotations[0].reason ?? 'anchored');
  const relit = d.root[0].children[0].text.slice(r.annotations[0].start, r.annotations[0].end);
  check('归一化匹配：定位覆盖当前文字', relit === '第五条、第二款', relit);
}

// ---- 审阅批注：全文多处匹配 → multi-match + 候选按前后文排序 ----
{
  const d0 = parseDocument(`批注法

第一条
前置文字目标片段后缀文字。`).doc;
  renumberAll(d0.root);
  const n0 = d0.root[0].children[0];
  const q = '目标片段';
  const ann = createAnnotation(n0.id, n0.text.indexOf(q), n0.text.indexOf(q) + q.length, n0.text, 'x');
  const d = parseDocument(`批注法

第一条
无关内容。

第二条
另外一处目标片段在这里。

第三条
前置文字目标片段后缀文字。`).doc;
  renumberAll(d.root);
  d.root[2].children[0].text = '前置文字目标片段后缀文字。'; // 与原前后文一致
  const r = relocateAnnotations([ann], d);
  check('全文多处：multi-match 待复核', r.annotations[0].status === 'review' && r.annotations[0].reason === 'multi-match', r.annotations[0].reason ?? '');
  const cands = r.annotations[0].candidates ?? [];
  check('全文多处：保留候选', cands.length === 2, String(cands.length));
  check('候选排序：前后文最相似者居首', cands[0]?.nodeId === d.root[2].children[0].id, cands[0]?.nodeId ?? '');
}

// ---- 审阅批注：外部数据规整 ----
{
  check('空/非法批注列表 → 空', sanitizeAnnotations(undefined).length === 0);
  check('非法项过滤', sanitizeAnnotations([null, 42, { nodeId: 'x' }, { nodeId: 'x', quote: '', content: '' }]).length === 0);
  const cleaned = sanitizeAnnotations([
    { id: 'a1', nodeId: 'n1', start: 0, end: 3, quote: 'abc', content: 'ok', status: 'review' },
    { nodeId: 'n2', quote: 'd', content: 'ok' }, // 缺 id 自动补
  ]);
  check('合法批注保留', cleaned.length === 2 && cleaned[0].status === 'review');
  check('缺省 id / 时间戳自动补全', Boolean(cleaned[1].id) && typeof cleaned[1].createdAt === 'number');
  check('非法状态回退 anchored', sanitizeAnnotations([{ nodeId: 'n', quote: 'a', content: 'c', status: 'weird' }])[0].status === 'anchored');
}

// ---- 审阅批注：选区边界 → 原正文字符偏移（嵌套 mark / 引用 chip 边界） ----
{
  // 构造与 HighlightedText 渲染同构的简化 DOM：
  //   文本「甲」<ann><term>按照</term></ann> 文本「乙」<chip>第五条第二款</chip> 文本「丙」
  // 线性正文：甲按照乙第五条第二款丙（偏移：甲0、按照[1,3)、乙3、chip[4,10)、丙[10,11)）
  interface FakeNode {
    t?: string;
    c?: FakeNode[];
    parent?: FakeNode | null;
  }
  const tx = (s: string): FakeNode => ({ t: s, parent: null });
  const el = (...children: FakeNode[]): FakeNode => {
    const n: FakeNode = { c: children, parent: null };
    for (const ch of children) ch.parent = n;
    return n;
  };
  const term = el(tx('按照'));
  const ann = el(term);
  const chipText = tx('第五条第二款');
  const chip = el(chipText);
  const outside = el(tx('外部'));
  const container = el(tx('甲'), ann, tx('乙'), chip, tx('丙'));

  const fakeAdapter: SeqNodeAdapter<FakeNode> = {
    isText: (n) => n.t !== undefined,
    isSame: (a, b) => a === b,
    contains: (root, n) => {
      let cur: FakeNode | null | undefined = n;
      while (cur) {
        if (cur === root) return true;
        cur = cur.parent;
      }
      return false;
    },
    textOf: (n) => n.t ?? '',
    textLength: (n) => n.t?.length ?? 0,
    parent: (n) => n.parent ?? null,
    childCount: (n) => n.c?.length ?? 0,
    childAt: (n, i) => n.c![i],
  };

  check('选区线性文本等于原正文', linearText(fakeAdapter, container) === '甲按照乙第五条第二款丙', linearText(fakeAdapter, container));
  check('容器外边界返回 null', boundaryOffset(fakeAdapter, container, outside, 0) === null);
  check('文本节点内部偏移：甲[0,1)', boundaryOffset(fakeAdapter, container, container.c![0], 1) === 1);
  check('mark 内文本起点偏移为 1', boundaryOffset(fakeAdapter, container, term.c![0], 0) === 1);
  check('mark 内文本中部偏移为 2', boundaryOffset(fakeAdapter, container, term.c![0], 1) === 2);
  // 关键回归：端点落在嵌套元素边界（term 之后）应为 3，旧实现忽略元素 offset
  check('嵌套元素后边界：term offset 1 → 3', boundaryOffset(fakeAdapter, container, term, 1) === 3, String(boundaryOffset(fakeAdapter, container, term, 1)));
  check('嵌套元素前边界：term offset 0 → 1', boundaryOffset(fakeAdapter, container, term, 0) === 1);
  check('ann 边界：offset 0/1 → 1/3', boundaryOffset(fakeAdapter, container, ann, 0) === 1 && boundaryOffset(fakeAdapter, container, ann, 1) === 3);
  check('引用 chip 前边界 → 4', boundaryOffset(fakeAdapter, container, chip, 0) === 4);
  check('引用 chip 后边界 → 10', boundaryOffset(fakeAdapter, container, chip, 1) === 10);
  check('chip 内文本偏移：+3 → 7', boundaryOffset(fakeAdapter, container, chipText, 3) === 7);
  check('chip 内文本末尾 → 10', boundaryOffset(fakeAdapter, container, chipText, 6) === 10);
  check('容器边界：第 3 个子节点前（chip 前）→ 4', boundaryOffset(fakeAdapter, container, container, 3) === 4);
  check('容器边界：第 4 个子节点前（丙前）→ 10', boundaryOffset(fakeAdapter, container, container, 4) === 10);
  check('元素 offset 越界钳制到末尾', boundaryOffset(fakeAdapter, container, chip, 9) === 10);
  check('文本 offset 越界钳制到节点末', boundaryOffset(fakeAdapter, container, chipText, 99) === 10);
  check('负数 offset 钳制到 0', boundaryOffset(fakeAdapter, container, term, -3) === 1);

  // 跨「普通文本 + 规范用语 mark + 引用 chip」选区：chip 后边界(10) 到 mark 内文本起(1)
  const selStart = boundaryOffset(fakeAdapter, container, term.c![0], 0);
  const selEnd = boundaryOffset(fakeAdapter, container, chip, 1);
  const full = linearText(fakeAdapter, container);
  check(
    '跨 mark/chip 选区引文按原文序列拼接',
    selStart === 1 && selEnd === 10 && full.slice(selStart!, selEnd!) === '按照乙第五条第二款',
    full.slice(selStart ?? 0, selEnd ?? 0),
  );
}

// ---- 审阅批注：Store 拒绝空 / 越界 / 跨节点无效区间写入 ----
{
  const d = parseDocument(`批注法

第一条
为了规范批注活动，制定本办法。

第二条
另一段正文。`).doc;
  renumberAll(d.root);
  const n1 = d.root[0].children[0];
  const n2 = d.root[1].children[0];
  const store = new AppStore({ doc: d, confirmed: {}, annotations: [] });
  const len = n1.text.length;
  check('Store：空选区不创建批注', store.addAnnotation(n1.id, 3, 3, 'x') === null);
  check('Store：负偏移不创建批注', store.addAnnotation(n1.id, -2, 3, 'x') === null);
  check('Store：越界区间不创建批注', store.addAnnotation(n1.id, 0, len + 1, 'x') === null);
  check('Store：零长度区间不创建批注', store.addAnnotation(n1.id, 5, 5, 'x') === null);
  check('Store：不存在节点不创建批注', store.addAnnotation('no-such-node', 0, 2, 'x') === null);
  check('Store：起止颠倒自动归一化仍可创建', typeof store.addAnnotation(n1.id, 4, 0, 'ok2') === 'string');
  const id = store.addAnnotation(n1.id, 0, 4, 'ok');
  check('Store：合法区间创建成功', typeof id === 'string' && store.getSnapshot().annotations.length === 2, String(id));
  void n2;
}

// ---- 审阅批注：快照携带批注并只读 ----
{
  const d = parseDocument(`快照批注法

第一条
快照正文。`).doc;
  renumberAll(d.root);
  const anns = sanitizeAnnotations([
    { id: 'an1', nodeId: d.root[0].children[0].id, start: 0, end: 2, quote: '快照', content: '留痕' },
  ]);
  const snap = createSnapshot(d, {}, '带批注稿', anns);
  check('快照携带批注', Array.isArray(snap.annotations) && snap.annotations!.length === 1);
  let froze = false;
  try {
    'use strict';
    (snap.annotations as unknown[]).push?.({} as never);
  } catch {
    froze = true;
  }
  check('快照批注只读冻结', froze);
  const loaded = sanitizeSnapshots([
    { id: 's', name: 's', createdAt: 1, doc: d, confirmed: {}, annotations: [{ nodeId: 'x', quote: 'q', content: 'c' }] },
  ]);
  check('快照导入时规整批注', (loaded[0].annotations?.length ?? 0) === 1);
}

// ---- 规范用语：规则规整 ----
{
  check('旧数据缺 termRules → 空规则', sanitizeTermRules(undefined).length === 0);
  check('非法规则项被过滤', sanitizeTermRules([null, 42, {}, { canonical: '  ' }]).length === 0);
  const rules = sanitizeTermRules([
    { canonical: ' 依照 ', variants: [' 按照 ', '按照', '依照', ''] },
    { canonical: '应当' },
  ]);
  check('合法规则保留并 trim', rules.length === 2 && rules[0].canonical === '依照');
  check('变体去重且剔除与规范词相同者', rules[0].variants.length === 1 && rules[0].variants[0] === '按照', JSON.stringify(rules[0].variants));
  check('缺省 id 自动补全', Boolean(rules[1].id));
  check('effectiveVariants 剔除与规范词相同者', effectiveVariants({ id: 'r', canonical: '甲', variants: ['甲', '乙', '乙'], createdAt: 0 }).join(',') === '乙');
}

// ---- 规范用语：扫描、重叠消解与批量替换（纯函数） ----
{
  const d = parseDocument(`术语法

第一条
按照规定应该公开，按照程序应该回避。

第二条
按照后条办理。`).doc;
  renumberAll(d.root);
  const n1 = d.root[0].children[0].id;
  const n2 = d.root[1].children[0].id;

  const rules = sanitizeTermRules([
    { id: 'r1', canonical: '依照', variants: ['按照'] },
    { id: 'r2', canonical: '应当', variants: ['应该'] },
    // 与「按照」同起点的长变体，用于验证长变体优先
    { id: 'r3', canonical: '依规', variants: ['按照规'] },
  ]);
  const hits = scanTerms(d, rules);
  // 第一条：按照规(长) 应该 按照 应该；第二条：按照
  check('扫描命中数（长变体优先，且不递归）', hits.length === 5, String(hits.length));
  const longHit = hits.find((h) => h.variant === '按照规');
  check('同起点长变体胜出', Boolean(longHit) && longHit!.nodeId === n1, JSON.stringify(hits.map(h => h.variant)));
  check('长变体胜出后短变体「按照」不在该处命中', !hits.some((h) => h.nodeId === n1 && h.variant === '按照' && h.start === 0));
  check('命中文档顺序：第一条先于第二条', hits[0].nodeId === n1 && hits[hits.length - 1].nodeId === n2);
  // 起点靠前消解重叠：长变体 [0,3) 覆盖后，规则 r1 在 0 处的「按照」被跳过
  check('命中两两互不交叠', hits.every((h, i) => i === 0 || hits[i - 1].nodeId !== h.nodeId || h.start >= hits[i - 1].end));

  // 规则顺序消解：同起点、同长度、不同规则时顺序靠前的优先
  const dTie = parseDocument(`平手法

第一条
甲乙同字。`).doc;
  renumberAll(dTie.root);
  const tieRules = sanitizeTermRules([
    { id: 'ta', canonical: 'A', variants: ['甲乙'] },
    { id: 'tb', canonical: 'B', variants: ['甲乙'] },
  ]);
  const tieHits = scanTerms(dTie, tieRules);
  check('同长同起点：规则顺序靠前者胜出', tieHits.length === 1 && tieHits[0].ruleId === 'ta', JSON.stringify(tieHits));

  // 批量替换：仅替换勾选命中（取除长命中外的其余 4 处），单遍、按节点从后向前
  const chosen = hits.filter((h) => h.variant !== '按照规');
  const clone = JSON.parse(JSON.stringify(d)) as typeof d;
  const r = replaceTermHits(clone, chosen);
  check('批量替换全部成功', r.replaced === 4 && r.stale === 0, `${r.replaced}/${r.stale}`);
  const newText1 = clone.root[0].children[0].text;
  const newText2 = clone.root[1].children[0].text;
  check('替换结果正确', newText1 === '按照规定应当公开，依照程序应当回避。', newText1);
  check('长变体未被勾选时原样保留', newText1.startsWith('按照规'));
  check('第二条替换', newText2 === '依照后条办理。', newText2);
  // 不递归：替换后出现的规范词即便等于某条规则的变体也不会二次处理（这里变体均不含规范词，另做专项）
  const dRec = parseDocument(`递归法

第一条
甲乙。`).doc;
  renumberAll(dRec.root);
  // 规则：把「甲」替换成「甲乙」——若递归会再次命中，单遍实现只替换一次
  const recHits = scanTerms(dRec, sanitizeTermRules([{ id: 'rr', canonical: '甲乙', variants: ['甲'] }]));
  const recClone = JSON.parse(JSON.stringify(dRec)) as typeof dRec;
  const recR = replaceTermHits(recClone, recHits);
  check('替换不递归处理新生成文字', recR.replaced === 1 && recClone.root[0].children[0].text === '甲乙乙。', recClone.root[0].children[0].text);

  // 整批拒绝：任一命中区间已变化（原文不符）则整批不动
  const staleDoc = JSON.parse(JSON.stringify(d)) as typeof d;
  staleDoc.root[0].children[0].text = '正文已经被人改写过，与快照不一致。';
  const staleR = replaceTermHits(staleDoc, chosen);
  check('区间已变化：整批拒绝（stale>0，replaced=0）', staleR.stale > 0 && staleR.replaced === 0, `${staleR.replaced}/${staleR.stale}`);
  check('整批拒绝时正文完全不动', staleDoc.root[0].children[0].text === '正文已经被人改写过，与快照不一致。');

  // 节点删除 → 失效
  check('节点删除判定为失效', !isHitCurrent(undefined, chosen[0]));
}

// ---- 规范用语：AppStore 扫描快照、批量替换原子性、撤销/重做与持久化 ----
{
  const d = parseDocument(`商店法

第一条
按照规定办理。

第二条
再次按照办理。`).doc;
  renumberAll(d.root);
  const rules = sanitizeTermRules([{ id: 'k1', canonical: '依照', variants: ['按照'] }]);
  const store = new AppStore({ doc: d, confirmed: {}, annotations: [], termRules: rules });
  const snap0 = store.getSnapshot();
  check('Store 实时给出命中', snap0.termHits.length === 2, String(snap0.termHits.length));

  // 仅勾选第一条的命中：替换只处理已选命中，另一处保留
  const firstHit = snap0.termHits.find((h) => h.nodeId === d.root[0].children[0].id)!;
  const res = store.replaceSelectedTerms([firstHit.key]);
  check('Store 替换返回成功', res.replaced === 1 && res.stale === 0, JSON.stringify(res));
  const snap1 = store.getSnapshot();
  check('已选命中被替换', snap1.doc.root[0].children[0].text === '依照规定办理。');
  check('未选命中保留且重新扫描仍可见', snap1.doc.root[1].children[0].text === '再次按照办理。' && snap1.termHits.length === 1);
  check('替换是一步：撤销恢复原文', (store.undo(), store.getSnapshot().doc.root[0].children[0].text === '按照规定办理。'));
  check('撤销后命中恢复为 2 处', store.getSnapshot().termHits.length === 2);
  check('重做再次替换', (store.redo(), store.getSnapshot().doc.root[0].children[0].text === '依照规定办理。'));

  // 过期快照：撤销回旧正文拿到扫描命中后，删除其中一个命中节点，再用旧快照尝试替换 → 整批拒绝
  store.undo();
  const nowStale = store.getSnapshot().termHits; // 旧正文「按照」两处
  const secondNodeId = d.root[1].children[0].id;
  store.deleteNode(secondNodeId); // 结构性分歧：旧快照中第二条的命中已无对应节点
  const rejected = store.replaceSelectedTerms(nowStale.map((h) => h.key));
  check('Store 检测过期快照并整批拒绝', rejected.replaced === 0 && rejected.stale >= 1, JSON.stringify(rejected));
  check('拒绝后第一条正文未被改动', store.getSnapshot().doc.root[0].children[0].text === '按照规定办理。');
  check('规则随状态持久化（currentPersisted 含 termRules）', JSON.stringify(store.getSnapshot().termRules).includes('依照'));

  // 规则增删改进入撤销历史
  const beforeRules = store.getSnapshot().termRules.length;
  const newId = store.addTermRule();
  check('新增规则', store.getSnapshot().termRules.length === beforeRules + 1);
  store.updateTermRule(newId, { canonical: '可以', variants: ['可'] });
  store.undo();
  // updateTermRule 与 addTermRule 之间因合并窗口（测试中同步执行，窗口内）可能合并为一步
  const afterUndo = store.getSnapshot().termRules;
  check('规则编辑可撤销', afterUndo.length === beforeRules || !afterUndo.some((r) => r.canonical === '可以'), JSON.stringify(afterUndo.map(r => r.canonical)));

  // 导出 JSON 带规则；旧导入缺字段按空规则加载且不报错
  const exported = store.exportJson();
  check('导出包含 termRules', Array.isArray(exported.termRules) && exported.termRules!.length >= 1);
  const store2 = new AppStore({ doc: d, confirmed: {}, annotations: [] });
  check('旧数据缺 termRules 按空规则加载（0 命中）', store2.getSnapshot().termHits.length === 0 && store2.getSnapshot().termRules.length === 0);
}

// ---- 组合引用 / 闭区间：扫描 ----
{
  const comb = scanReferences('应当符合第三条、第五条及第七条与第三条至第五条的规定。');
  check('组合引用扫描为单个 span', comb.length === 2 && comb[0].kind === 'articleList', JSON.stringify(comb.map(s=>[s.kind,s.raw])));
  check('组合成员 3/5/7', comb[0].members?.map((m) => m.num).join(',') === '3,5,7', JSON.stringify(comb[0].members));
  check('闭区间扫描为单个 span', comb[1].kind === 'articleRange' && comb[1].raw === '第三条至第五条');
  check('闭区间端点 3..5', comb[1].articleNum === 3 && comb[1].rangeEndNum === 5);
  check('“和”可作组合分隔符', scanReferences('依第三条和第五条办理').some((s) => s.kind === 'articleList'));
  // 组合内暂不解析款、项：回退为独立绝对引用
  const parA = scanReferences('见第三条第二款、第五条。');
  check('组合不解析款（前成员带款）', parA.length === 2 && parA.every((s) => s.kind === 'absolute'), JSON.stringify(parA.map(s=>s.raw)));
  const parB = scanReferences('见第三条、第五条第二款。');
  check('组合不解析款（末成员带款）', parB.length === 2 && parB.every((s) => s.kind === 'absolute'), JSON.stringify(parB.map(s=>s.raw)));
  // 区间后紧跟款号也不成区间
  const parC = scanReferences('见第三条至第五条第二款。');
  check('区间末成员带款不成区间', parC.every((s) => s.kind === 'absolute'), JSON.stringify(parC.map(s=>[s.kind,s.raw])));
}

// ---- 组合引用 / 闭区间：解析为按文档顺序排列的稳定条 ID 集合 ----
const combText = `组合法

第一条
参见第三条、第五条及第七条。

第二条
适用第三条至第五条的规定。

第三条
内容三。

第四条
内容四。

第五条
内容五。

第六条
内容六。

第七条
内容七。`;
const combDoc = parseDocument(combText).doc;
renumberAll(combDoc.root);
const combA = analyze(combDoc, { confirmed: {} });
const listOcc = combA.occurrences.find((o) => o.span.kind === 'articleList')!;
const rangeOcc = combA.occurrences.find((o) => o.span.kind === 'articleRange')!;
check('组合引用解析成功', listOcc?.resolution.status === 'ok', JSON.stringify(listOcc?.resolution));
check('组合目标为稳定条 ID 集合', listOcc?.resolution.targetIds?.length === 3);
check(
  '组合目标按文档顺序排列',
  listOcc?.resolution.targetIds?.join(',') ===
    [combDoc.root[2].id, combDoc.root[4].id, combDoc.root[6].id].join(','),
);
check('闭区间展开为 3 个目标', rangeOcc?.resolution.targetIds?.length === 3, JSON.stringify(rangeOcc?.resolution.targetIds));
check(
  '闭区间目标按文档顺序',
  rangeOcc?.resolution.targetIds?.join(',') ===
    [combDoc.root[2].id, combDoc.root[3].id, combDoc.root[4].id].join(','),
);
check('组合规范形式展开为顿号列表', listOcc?.resolution.canonical === '第三条、第五条、第七条', listOcc?.resolution.canonical ?? '');
check('区间规范形式保持区间', rangeOcc?.resolution.canonical === '第三条至第五条', rangeOcc?.resolution.canonical ?? '');
check('组合引用为每个目标建边', combA.edges.filter((e) => e.refKey === listOcc.key).length === 3);
check('闭区间为每个目标建边', combA.edges.filter((e) => e.refKey === rangeOcc.key).length === 3);

// ---- 组合引用：结构改写（连续→区间，不连续→顿号列表） ----
{
  // 把第二条移到末尾：区间目标 {三,四,五}→{2,3,4} 仍连续；组合 {三,五,七}→{2,4,6} 不连续
  const r = applyStructuralChange(combDoc, combA, (root) => {
    const second = root.splice(1, 1)[0];
    root.push(second);
  });
  const art1 = r.doc.root[0].children[0].text;
  const movedArt = r.doc.root.find((a) => a.id === combDoc.root[1].id)!;
  const art2 = movedArt.children[0].text;
  check('组合不连续 → 展开为顿号列表', art1 === '参见第二条、第四条、第六条。', art1);
  check('区间目标仍连续 → 输出区间', art2 === '适用第二条至第四条的规定。', art2);
  check('组合改写计入 rewritten', r.rewritten === 2, String(r.rewritten));
}

// ---- 组合引用：改写形式随目标集合连续性互换（列表↔区间） ----
{
  // 列表目标连续 → 折叠为区间
  const listDoc = parseDocument(`折叠法

第一条
参见第三条、第四条及第五条。

第二条
内容二。

第三条
内容三。

第四条
内容四。

第五条
内容五。`).doc;
  renumberAll(listDoc.root);
  const listA = analyze(listDoc, { confirmed: {} });
  const r1 = applyStructuralChange(listDoc, listA, (root) => {
    const first = root.shift()!; // 第一条移到末尾：{三,四,五}→{1,2,3} 仍连续
    root.push(first);
  });
  const collapsed = r1.doc.root.find((a) => a.id === listDoc.root[0].id)!.children[0].text;
  check('列表目标连续 → 折叠为区间', collapsed === '参见第二条至第四条。', collapsed);

  // 区间目标被拆散 → 展开为顿号列表
  const rangeDoc = parseDocument(`展开法

第一条
适用第三条至第五条。

第二条
内容二。

第三条
内容三。

第四条
内容四。

第五条
内容五。`).doc;
  renumberAll(rangeDoc.root);
  const rangeA = analyze(rangeDoc, { confirmed: {} });
  const r2 = applyStructuralChange(rangeDoc, rangeA, (root) => {
    const fourth = root.splice(3, 1)[0]; // 第四条移到最前：{三,四,五}→{4,1,5} 不连续
    root.unshift(fourth);
  });
  const expanded = r2.doc.root.find((a) => a.id === rangeDoc.root[0].id)!.children[0].text;
  check('区间目标不连续 → 展开为顿号列表', expanded === '适用第一条、第四条、第五条。', expanded);
}

// ---- 组合引用：沿用原数字风格（阿拉伯数字） ----
{
  const arabDoc = parseDocument(`风格法

第1条
参见第3条至第5条与第2条、第4条。

第2条
内容。

第3条
内容。

第4条
内容。

第5条
内容。`).doc;
  renumberAll(arabDoc.root);
  const arabA = analyze(arabDoc, { confirmed: {} });
  const r = applyStructuralChange(arabDoc, arabA, (root) => {
    const second = root.splice(1, 1)[0];
    root.push(second);
  });
  const art1 = r.doc.root[0].children[0].text;
  check('区间改写沿用阿拉伯风格', art1.includes('第2条至第4条'), art1);
  check('组合展开沿用阿拉伯风格', art1.includes('第3条、第5条'), art1);
}

// ---- 组合引用：任一目标被删除 → 整段不改写 ----
{
  const r = applyStructuralChange(combDoc, combA, (root) => {
    root.splice(4, 1); // 删除第五条
  });
  const texts = JSON.stringify(r.doc);
  check('组合目标被删除 → 组合整段不改写', texts.includes('参见第三条、第五条及第七条。'));
  check('区间目标被删除 → 区间整段不改写', texts.includes('适用第三条至第五条的规定。'));
  check(
    '删除目标计入 skipped（targetMissing）',
    r.skipped.filter((s) => s.targetMissing).length === 2,
    JSON.stringify(r.skipped),
  );
}

// ---- 组合引用：部分目标缺失 → 问题面板列出已解析与缺失目标 ----
{
  const partDoc = parseDocument(`部分缺失法

第一条
参见第三条、第九条。

第二条
内容二。

第三条
内容三。`).doc;
  renumberAll(partDoc.root);
  const partA = analyze(partDoc, { confirmed: {} });
  const occ = partA.occurrences.find((o) => o.span.kind === 'articleList')!;
  check('部分缺失：整体标记 broken', occ?.resolution.status === 'broken');
  check('部分缺失：保留已解析目标', occ?.resolution.targetIds?.join() === partDoc.root[2].id);
  check('部分缺失：记录缺失成员', occ?.resolution.missingTargets?.[0]?.raw === '第九条');
  const issue = partA.issues.find((i) => i.type === 'broken' && i.refKey === occ.key)!;
  check('问题项列出已解析目标', issue?.resolvedTargetIds?.length === 1);
  check('问题项列出缺失目标', issue?.missingTargets?.length === 1);
  check('部分缺失仍为已解析目标建边', partA.edges.some((e) => e.refKey === occ.key && e.targetArticleId === partDoc.root[2].id));
}

// ---- 闭区间：端点有歧义 → 整段不改写并列出缺失 ----
{
  const ambDoc = parseDocument(`歧义区间法

第一条
适用第二条至第三条。

第二条
内容二。

第三条
内容三。

第三条之一
内容三之一。`).doc;
  // 不 renumber：保留“第三条之一”与“第三条”同序号
  const ambA = analyze(ambDoc, { confirmed: {} });
  const occ = ambA.occurrences.find((o) => o.span.kind === 'articleRange')!;
  check('端点歧义：整体 broken', occ?.resolution.status === 'broken', JSON.stringify(occ?.resolution));
  check('端点歧义：缺失目标记录端点', occ?.resolution.missingTargets?.some((m) => m.raw === '第三条'));
  check('端点歧义：已解析端点保留', occ?.resolution.targetIds?.join() === ambDoc.root[1].id);
  const r = applyStructuralChange(ambDoc, ambA, (root) => {
    const first = root.shift()!;
    root.push(first);
  });
  check('端点歧义 → 结构操作后区间原文不变', JSON.stringify(r.doc).includes('适用第二条至第三条。'));
  check('端点歧义计入 skipped', r.skipped.some((s) => s.raw === '第二条至第三条'), JSON.stringify(r.skipped));
}

// ---- 组合引用：目标集合包含本条 → 自引用 ----
{
  const selfDoc = parseDocument(`自指组合法

第一条
内容一。

第二条
适用第一条至第三条。

第三条
内容三。`).doc;
  renumberAll(selfDoc.root);
  const selfA = analyze(selfDoc, { confirmed: {} });
  check(
    '组合目标包含本条 → 自引用',
    selfA.issues.some((i) => i.type === 'self' && i.message.includes('目标集合包含本条')),
    JSON.stringify(selfA.issues.map((i) => i.message)),
  );
}

// ---- 组合引用：结构操作 + 组合改写 = 一次撤销步骤 ----
{
  const storeDoc = parseDocument(combText).doc;
  renumberAll(storeDoc.root);
  const store = new AppStore({ doc: storeDoc, confirmed: {}, annotations: [] });
  const before = store.getSnapshot().doc.root[0].children[0].text;
  store.reorderSibling(storeDoc.root[1].id, 99); // 第二条移到末尾
  const after = store.getSnapshot().doc.root[0].children[0].text;
  check('结构操作后组合引用已改写', after === '参见第二条、第四条、第六条。', after);
  check('组合改写与结构操作为一次撤销', (store.undo(), store.getSnapshot().doc.root[0].children[0].text === before));
  check('撤销后结构一并恢复', store.getSnapshot().doc.root[1].id === storeDoc.root[1].id);
  check('重做再次应用组合改写', (store.redo(), store.getSnapshot().doc.root[0].children[0].text === after));
}

// ---- 问题基线：稳定身份（类型 + 源节点 ID + 原文 + 同文序次；字符偏移不产生新问题） ----
{
  const d0 = parseDocument(`基线法

第一条
参见第二条及第三条；另参见第九条。

第二条
参见第三条。

第三条
参见第一条。`).doc;
  renumberAll(d0.root);
  const a0 = analyze(d0, { confirmed: {} });
  check('基线样例：检出断链', a0.issues.some((i) => i.type === 'broken'));
  check('基线样例：检出循环', a0.issues.some((i) => i.type === 'cycle'));
  for (const issue of a0.issues) check('问题均带稳定身份', typeof issue.identity === 'string' && issue.identity.length > 0);

  // 在断链引用前插入文字：字符偏移变化，问题身份保持不变
  const d1 = parseDocument(`基线法

第一条
前文插入若干不影响引用的文字之后，参见第二条及第三条；另参见第九条。

第二条
参见第三条。

第三条
参见第一条。`).doc;
  renumberAll(d1.root);
  // 沿用稳定节点 ID（模拟同一文档的编辑）
  d1.root[0].id = d0.root[0].id;
  d1.root[1].id = d0.root[1].id;
  d1.root[2].id = d0.root[2].id;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < d0.root[i].children.length; j++) {
      if (d1.root[i].children[j]) d1.root[i].children[j].id = d0.root[i].children[j].id;
    }
  }
  const a1 = analyze(d1, { confirmed: {} });
  const broken0 = a0.issues.filter((i) => i.type === 'broken');
  const broken1 = a1.issues.filter((i) => i.type === 'broken');
  check('偏移变化后断链问题数不变', broken0.length === broken1.length, `${broken0.length}/${broken1.length}`);
  check(
    '字符偏移变化不制造新问题（身份一致）',
    broken0.every((b) => broken1.some((x) => x.identity === b.identity)),
  );
  check('偏移变化后问题仍记录新偏移', broken1[0].refStart !== broken0[0].refStart);

  // 循环身份为排序后的稳定节点 ID 集合，与环的方向 / 起点无关
  const cycles = a0.issues.filter((i) => i.type === 'cycle');
  check('循环问题身份使用排序节点集合', cycles.every((c) => c.identity.startsWith('cycle::') && c.identity.includes(d0.root[0].id) && c.identity.includes(d0.root[1].id) && c.identity.includes(d0.root[2].id)), cycles.map((c) => c.identity).join(','));

  // 同文序次：同节点内两次相同原文分别获得不同身份
  const dup = parseDocument(`序次法

第一条
两次：见第九条；再次见第九条。

第二条
无。`).doc;
  renumberAll(dup.root);
  const dupA = analyze(dup, { confirmed: {} });
  const dupBroken = dupA.issues.filter((i) => i.type === 'broken');
  check('同原文两次出现生成两个问题', dupBroken.length === 2, String(dupBroken.length));
  check('同文序次区分身份', dupBroken[0].identity !== dupBroken[1].identity);

  // 类型参与身份：把断链目标补齐（新增第九条）后，断链身份消失；循环不受影响
  const fixed = parseDocument(`基线法

第一条
前文插入若干不影响引用的文字之后，参见第二条及第三条；另参见第九条。

第二条
参见第三条。

第三条
参见第一条。

第四条
过渡条。

第五条
过渡条。

第六条
过渡条。

第七条
过渡条。

第八条
过渡条。

第九条
新增的目标条。`).doc;
  renumberAll(fixed.root);
  for (let i = 0; i < 3; i++) {
    fixed.root[i].id = d1.root[i].id;
    for (let j = 0; j < d1.root[i].children.length; j++) {
      if (fixed.root[i].children[j]) fixed.root[i].children[j].id = d1.root[i].children[j].id;
    }
  }
  const fixedA = analyze(fixed, { confirmed: {} });
  const diffFixed = diffIssueBaseline(a1, fixedA);
  check('补齐目标：断链问题标记为已解决', diffFixed.resolved.some((e) => e.type === 'broken'), JSON.stringify(diffFixed.resolved.map((e) => e.type)));
  check('补齐目标：无新增断链', !diffFixed.added.some((e) => e.type === 'broken'));
  check('循环未受影响：仍存在', diffFixed.persisting.some((e) => e.type === 'cycle'));
}

// ---- 问题基线：新增 / 已解决 / 仍存在分类与现存源句跳转定位 ----
{
  const baseDoc = parseDocument(`分类法

第一条
参见第二条及第三条；另参见第九条。

第二条
参见第三条。

第三条
参见第一条。`).doc;
  renumberAll(baseDoc.root);
  const baseA = analyze(baseDoc, { confirmed: {} });

  // 实时版：第一条修复“第九条”并新增一处断链“第八条”；第二、三条间循环保持
  const liveDoc = parseDocument(`分类法

第一条
参见第二条及第三条；另参见第八条。

第二条
参见第三条。

第三条
参见第一条。

第四条
过渡条。

第五条
过渡条。

第六条
过渡条。

第七条
过渡条。`).doc;
  renumberAll(liveDoc.root);
  for (let i = 0; i < 3; i++) {
    liveDoc.root[i].id = baseDoc.root[i].id;
    for (let j = 0; j < baseDoc.root[i].children.length; j++) {
      if (liveDoc.root[i].children[j]) liveDoc.root[i].children[j].id = baseDoc.root[i].children[j].id;
    }
  }
  const liveA = analyze(liveDoc, { confirmed: {} });
  const d = diffIssueBaseline(baseA, liveA);
  check('基线比较：新增 1 个问题（第八条断链）', d.added.length === 1 && d.added[0].type === 'broken', String(d.added.length));
  check('基线比较：已解决 1 个问题（第九条断链）', d.resolved.length === 1 && d.resolved[0].type === 'broken', String(d.resolved.length));
  check('基线比较：循环仍存在', d.persisting.some((e) => e.type === 'cycle'));
  check('计数一致', d.counts.added === 1 && d.counts.resolved === 1 && d.counts.persisting >= 1);

  // 新增问题可跳到当前源句
  const addedJump = d.added[0].jump!;
  check('新增问题带当前定位', addedJump.nodeId === liveDoc.root[0].children[0].id && liveDoc.root[0].children[0].text.slice(addedJump.start, addedJump.end).includes('第八条'));

  // 已解决问题：源节点仍在但引用原文已消失 → 退回定位整个现存源节点
  const resolvedJump = d.resolved[0].jump!;
  check('已解决问题回退定位现存源节点', resolvedJump.nodeId === liveDoc.root[0].children[0].id, JSON.stringify(resolvedJump));

  // 另一组：引用原文仍在、仅偏移变化（前缀插入），已解决问题应按原文 + 同文序次重定位源句
  const movedDoc = parseDocument(`分类法

第一条
先写入大段无关前缀文字，参见第二条及第三条；另参见第九条。

第二条
参见第三条。

第三条
参见第一条。`).doc;
  renumberAll(movedDoc.root);
  movedDoc.root[0].id = baseDoc.root[0].id;
  movedDoc.root[1].id = baseDoc.root[1].id;
  movedDoc.root[2].id = baseDoc.root[2].id;
  for (let i = 0; i < 3; i++) {
    movedDoc.root[i].children[0].id = baseDoc.root[i].children[0].id;
  }
  // 该情形下循环仍在、第九条仍断链：没有问题被解决；改以“删除断链但保留节点上其他引用”验证重定位
  const shiftedA = analyze(movedDoc, { confirmed: {} });
  const sameIdentity = shiftedA.issues.some(
    (i) => i.type === 'broken' && baseA.issues.some((b) => b.identity === i.identity) && i.refStart !== baseA.issues.find((b) => b.identity === i.identity)!.refStart,
  );
  check('身份稳定时保留当前偏移（供跳转现存源句）', sameIdentity);

  // 已解决问题（引用原文仍在，仅目标被补齐 + 前缀插入）：按原文与同文序次重定位到现存源句新偏移
  const fixedLiveDoc = parseDocument(`分类法

第一条
先写入一句无关的话。另写入大段前缀文字后，参见第九条。

第二条
参见第三条。

第三条
参见第一条。

第四条
过渡条。

第五条
过渡条。

第六条
过渡条。

第七条
过渡条。

第八条
过渡条。

第九条
新增目标条。`).doc;
  renumberAll(fixedLiveDoc.root);
  for (let i = 0; i < 3; i++) {
    fixedLiveDoc.root[i].id = baseDoc.root[i].id;
    fixedLiveDoc.root[i].children[0].id = baseDoc.root[i].children[0].id;
  }
  const fixedLiveA = analyze(fixedLiveDoc, { confirmed: {} });
  const dFixed = diffIssueBaseline(baseA, fixedLiveA);
  const fixedResolved = dFixed.resolved.find((e) => e.type === 'broken' && e.baseline?.sourceNodeId === baseDoc.root[0].children[0].id);
  check('补齐目标后原断链标记为已解决', Boolean(fixedResolved));
  const fj = fixedResolved!.jump!;
  check('已解决问题按原文重定位现存源句（跟随新偏移）', fj.nodeId === fixedLiveDoc.root[0].children[0].id && fixedLiveDoc.root[0].children[0].text.slice(fj.start, fj.end).includes('第九条') && fj.start > 0, JSON.stringify(fj));

  // 源节点删除 → 已解决问题不可跳转
  const goneDoc = parseDocument(`分类法

第二条
参见第三条。

第三条
参见第一条。`).doc;
  renumberAll(goneDoc.root);
  goneDoc.root[0].id = baseDoc.root[1].id;
  goneDoc.root[1].id = baseDoc.root[2].id;
  const goneA = analyze(goneDoc, { confirmed: {} });
  const dGone = diffIssueBaseline(baseA, goneA);
  const resolvedFromGone = dGone.resolved.find((e) => e.type === 'broken' && e.baseline?.sourceNodeId === baseDoc.root[0].children[0].id);
  check('源节点已删除：已解决问题不可跳转', Boolean(resolvedFromGone) && resolvedFromGone!.jump === null, JSON.stringify(resolvedFromGone?.jump));
}

// ---- 问题基线：偏移变化但问题仍在时，比较结果归为“仍存在”而非新增/已解决 ----
{
  const bDoc = parseDocument(`偏移法

第一条
参见第九条。`).doc;
  renumberAll(bDoc.root);
  const bA = analyze(bDoc, { confirmed: {} });
  const cDoc = parseDocument(`偏移法

第一条
前缀文字插入后，参见第九条。`).doc;
  renumberAll(cDoc.root);
  cDoc.root[0].id = bDoc.root[0].id;
  cDoc.root[0].children[0].id = bDoc.root[0].children[0].id;
  const cA = analyze(cDoc, { confirmed: {} });
  const d = diffIssueBaseline(bA, cA);
  check('仅偏移变化：仍存在 1 个', d.persisting.length === 1 && d.counts.added === 0 && d.counts.resolved === 0, JSON.stringify(d.counts));
  check('仍存在行带当前（新偏移）定位', (d.persisting[0].jump?.start ?? -1) === cA.issues[0].sentenceStart);
}

// ---- 问题基线：创建只读、旧数据缺省为空、随 JSON 导入导出（Store 级） ----
{
  const d = parseDocument(`持久化法

第一条
参见第九条。

第二条
内容。`).doc;
  renumberAll(d.root);

  const baseline = createIssueBaseline(d, {}, '一审基线');
  check('基线名称与时间保存', baseline.name === '一审基线' && baseline.createdAt > 0);
  check('基线与正文脱离引用（深拷贝）', baseline.doc.root[0] !== d.root[0]);
  let froze = false;
  try {
    'use strict';
    (baseline as unknown as { name: string }).name = 'x';
    froze = baseline.name === '一审基线';
  } catch {
    froze = true;
  }
  check('基线只读冻结', froze);
  check('基线可重新分析', analyzeIssueBaseline(baseline).issues.some((i) => i.type === 'broken'));

  check('旧数据缺少 issueBaselines → 空列表', sanitizeIssueBaselines(undefined).length === 0);
  check('非法基线项被过滤', sanitizeIssueBaselines([null, 42, { name: 'x' }, { doc: {} }]).length === 0);
  const loaded = sanitizeIssueBaselines([{ id: 'b1', name: 'b', createdAt: 1, doc: d, confirmed: {} }]);
  check('合法基线保留并冻结', loaded.length === 1 && loaded[0].id === 'b1');

  // Store：保存 / 删除基线不影响正文与撤销历史
  const store = new AppStore({ doc: JSON.parse(JSON.stringify(d)), confirmed: {}, annotations: [] });
  const beforeText = store.getSnapshot().doc.root[0].children[0].text;
  const id = store.saveIssueBaseline('我的基线');
  check('Store 保存基线', store.getSnapshot().issueBaselines.length === 1);
  store.deleteIssueBaseline(id);
  check('Store 删除基线', store.getSnapshot().issueBaselines.length === 0);
  check('删除基线不影响正文', store.getSnapshot().doc.root[0].children[0].text === beforeText);
  check('基线不进入撤销历史', store.getSnapshot().canUndo === false);

  // 导出携带基线，导入恢复
  store.saveIssueBaseline('导出基线');
  const exported = store.exportJson();
  check('导出 JSON 含 issueBaselines', Array.isArray(exported.issueBaselines) && exported.issueBaselines!.length === 1);
  const store2 = new AppStore({ doc: JSON.parse(JSON.stringify(d)), confirmed: {}, annotations: [] });
  check('旧数据缺 issueBaselines 按空列表加载', store2.getSnapshot().issueBaselines.length === 0);
  store2.importJson(exported);
  check('导入 JSON 恢复基线', store2.getSnapshot().issueBaselines.length === 1 && store2.getSnapshot().issueBaselines[0].name === '导出基线');
  check('导入基线可重新分析比较', diffIssueBaseline(analyzeIssueBaseline(store2.getSnapshot().issueBaselines[0]), store2.getSnapshot().analysis).counts.persisting >= 1);
}

// ---- 引用影响分析：直接 / 间接引用分层、循环去重与标注 ----
{
  // 链式：一→二→三（第一条引用第二条，第二条引用第三条）
  const chainDoc = parseDocument(`影响法

第一条
参见第二条。

第二条
参见第三条。

第三条
内容。`).doc;
  renumberAll(chainDoc.root);
  const chainA = analyze(chainDoc, { confirmed: {} });
  const impact3 = computeImpact(chainA, chainDoc.root[2].id);
  check('影响分析：直接引用层 1 个', impact3.layers[0]?.entries.length === 1 && impact3.layers[0].entries[0].articleId === chainDoc.root[1].id);
  check('影响分析：间接引用层为第一条', impact3.layers[1]?.entries[0]?.articleId === chainDoc.root[0].id);
  check('影响分析：距离分层 1/2', impact3.layers[0].entries[0].distance === 1 && impact3.layers[1].entries[0].distance === 2);
  check('影响分析：总数不含目标本身', impact3.total === 2, String(impact3.total));
  check('影响分析：无循环时不标注', impact3.cycleCount === 0 && !impact3.targetInCycle && impact3.dedupedPaths === 0);

  // 无引用者
  const impact1 = computeImpact(chainA, chainDoc.root[0].id);
  check('影响分析：无人引用时为空', impact1.total === 0 && impact1.layers.length === 0);

  // 汇聚（菱形）：四同时引用二、三；二、三都引用一 → 四只列一次且按最短距离
  const diamondDoc = parseDocument(`汇聚法

第一条
目标。

第二条
参见第一条。

第三条
参见第一条。

第四条
参见第二条和第三条。`).doc;
  renumberAll(diamondDoc.root);
  const diamondA = analyze(diamondDoc, { confirmed: {} });
  const impactD = computeImpact(diamondA, diamondDoc.root[0].id);
  check('影响分析：汇聚路径去重（四只出现一次）', impactD.total === 3, String(impactD.total));
  check('影响分析：第一层按文档顺序', impactD.layers[0].entries.map((e) => e.articleId).join(',') === [diamondDoc.root[1].id, diamondDoc.root[2].id].join(','));
  check('影响分析：重复路径计数', impactD.dedupedPaths === 1, String(impactD.dedupedPaths));

  // 最短距离优先：三同时直接引用一、经二间接引用一 → 三在第 1 层
  const nearDoc = parseDocument(`短距法

第一条
目标。

第二条
参见第一条。

第三条
参见第一条和第二条。`).doc;
  renumberAll(nearDoc.root);
  const nearA = analyze(nearDoc, { confirmed: {} });
  const impactN = computeImpact(nearA, nearDoc.root[0].id);
  check(
    '影响分析：多条路径按最短距离分层',
    impactN.layers.length === 1 && impactN.layers[0].entries.length === 2,
    JSON.stringify(impactN.layers.map((l) => l.entries.length)),
  );

  // 循环：一↔二 互引 → 去重并标注
  const cycDoc = parseDocument(`循环影响法

第一条
参见第二条。

第二条
参见第一条。`).doc;
  renumberAll(cycDoc.root);
  const cycA = analyze(cycDoc, { confirmed: {} });
  const impactC = computeImpact(cycA, cycDoc.root[0].id);
  check('影响分析：循环中目标不重复列入自身结果', impactC.total === 1 && impactC.layers[0].entries[0].articleId === cycDoc.root[1].id);
  check('影响分析：循环路径去重计数', impactC.dedupedPaths === 1, String(impactC.dedupedPaths));
  check('影响分析：循环条款标注', impactC.layers[0].entries[0].inCycle === true);
  check('影响分析：目标处于循环中', impactC.targetInCycle === true && impactC.cycleCount === 1);

  // 三环：一→二→三→一，分析一时 三在第 1 层、二在第 2 层，全部标注循环
  const triDoc = parseDocument(`三环法

第一条
参见第二条。

第二条
参见第三条。

第三条
参见第一条。`).doc;
  renumberAll(triDoc.root);
  const triA = analyze(triDoc, { confirmed: {} });
  const impactT = computeImpact(triA, triDoc.root[0].id);
  check(
    '影响分析：三环分层正确',
    impactT.layers[0]?.entries[0]?.articleId === triDoc.root[2].id &&
      impactT.layers[1]?.entries[0]?.articleId === triDoc.root[1].id,
    JSON.stringify(impactT.layers.map((l) => l.entries.map((e) => e.articleId))),
  );
  check('影响分析：三环全部标注', impactT.cycleCount === 2 && impactT.layers.every((l) => l.entries.every((e) => e.inCycle)));

  // 条内绝对自指不构成条款间影响路径
  const selfDoc2 = parseDocument(`自指影响法

第五条
按第五条执行。

第六条
参见第五条。`).doc;
  selfDoc2.root[0].ordinal = 5;
  selfDoc2.root[1].ordinal = 6;
  const selfA2 = analyze(selfDoc2, { confirmed: {} });
  const impactS = computeImpact(selfA2, selfDoc2.root[0].id);
  check('影响分析：条内自指不计入影响路径', impactS.total === 1 && impactS.layers[0].entries[0].articleId === selfDoc2.root[1].id, String(impactS.total));

  // 基于确认后的解析图：歧义引用确认后才计入影响
  const ambDoc2 = parseDocument(`确认影响法

第八条
参见第八条。

第八条之一
补充规定。`).doc;
  ambDoc2.root[1].suffix = '一';
  const ambNoConf = analyze(ambDoc2, { confirmed: {} });
  const ambOcc = ambNoConf.occurrences.find((o) => o.resolution.status === 'ambiguous')!;
  check('影响分析：未确认的歧义引用不计入', computeImpact(ambNoConf, ambDoc2.root[1].id).total === 0);
  const ambConf = analyze(ambDoc2, { confirmed: { [ambOcc.signature]: ambDoc2.root[1].id } });
  const impactAmb = computeImpact(ambConf, ambDoc2.root[1].id);
  check('影响分析：确认后的引用计入影响', impactAmb.total === 1 && impactAmb.layers[0].entries[0].articleId === ambDoc2.root[0].id);

  // 纯计算：不改动分析结果（会话内只读）
  const beforeJson = JSON.stringify(chainA);
  computeImpact(chainA, chainDoc.root[2].id);
  check('影响分析：计算不修改解析图', JSON.stringify(chainA) === beforeJson);
}

// ---- 修订沙盒：条级删除 / 移位 / 换号的预演、失效与一步应用 ----
{
  const sbText = `沙盒办法

第一条【目的】
依第二条、第三条及第五条办理。

第二条【范围】
本条引用第三条，另参见第四条。

第三条【程序】
本条援引第二条，参见第九条。

第四条【过渡】
参见第五条。

第五条【附则】
最终条款。`;
  const mkDoc = () => parseDocument(sbText).doc;

  // —— 删除预演：在克隆上复用改写与分析，不改动正文与撤销历史 ——
  const store = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  const art3 = store.getSnapshot().doc.root[2];
  const beforeJson = JSON.stringify(store.getSnapshot().doc.root);
  const res = store.runSandboxPreview({ kind: 'delete', articleId: art3.id });
  check('沙盒：删除预演生成成功', res.ok);
  const sb = store.getSnapshot().sandbox!;
  check('沙盒：预演记录操作描述', sb.label === '删除第三条', sb.label);
  check(
    '沙盒：预演记录生成时的文档版本',
    typeof sb.docRevision === 'number' && sb.docVersion === store.getSnapshot().doc.updatedAt,
  );
  check('沙盒：预演不改动正文', JSON.stringify(store.getSnapshot().doc.root) === beforeJson);
  check('沙盒：预演不进入撤销历史', store.getSnapshot().canUndo === false);
  check('沙盒：删除预演列出 2 处改写', sb.changes.length === 2, String(sb.changes.length));
  check(
    '沙盒：改写含 第四条→第三条',
    sb.changes.some((c) => c.raw === '第四条' && c.text === '第三条'),
  );
  check(
    '沙盒：改写含 第五条→第四条',
    sb.changes.some((c) => c.raw === '第五条' && c.text === '第四条'),
  );
  check(
    '沙盒：目标被删的引用不自动改写',
    sb.skipped.length === 2 && sb.skipped.every((s) => s.targetMissing),
    JSON.stringify(sb.skipped),
  );
  check(
    '沙盒：组合引用目标被删整段不改写',
    sb.skipped.some((s) => s.raw === '第二条、第三条及第五条'),
  );
  check(
    '沙盒：将新增 1 处断链',
    sb.issuesAdded.length === 1 && sb.issuesAdded[0].type === 'broken',
    JSON.stringify(sb.issuesAdded.map((i) => i.message)),
  );
  check(
    '沙盒：将消失 1 循环 + 1 断链',
    sb.issuesRemoved.length === 2 &&
      sb.issuesRemoved.some((i) => i.type === 'cycle') &&
      sb.issuesRemoved.some((i) => i.type === 'broken'),
    JSON.stringify(sb.issuesRemoved.map((i) => i.type)),
  );
  check(
    '沙盒：新增断链可点击定位当前正文',
    sandboxIssueJump(sb.issuesAdded[0], store.getSnapshot().analysis) !== null,
  );
  check(
    '沙盒：被改写引用可点击定位当前正文',
    sandboxRewriteJump(sb.changes[0], store.getSnapshot().analysis)?.nodeId === sb.changes[0].nodeId,
  );
  check(
    '沙盒：将消失问题可点击定位当前正文',
    sb.issuesRemoved.every((i) => sandboxIssueJump(i, store.getSnapshot().analysis) !== null),
  );

  // —— 应用：操作与全部引用改写作为一步提交，整体撤销 / 重做 ——
  check('沙盒：未失效时可应用', store.applySandboxPreview() === true);
  check('沙盒：应用后预演清空', store.getSnapshot().sandbox === null);
  check('沙盒：应用后结构生效', store.getSnapshot().doc.root.length === 4);
  check(
    '沙盒：应用后引用改写生效',
    store.getSnapshot().doc.root[1].children[0].text === '本条引用第三条，另参见第三条。',
    store.getSnapshot().doc.root[1].children[0].text,
  );
  check(
    '沙盒：应用为一步（撤销一次整体恢复）',
    (store.undo(),
    store.getSnapshot().doc.root.length === 5 &&
      store.getSnapshot().doc.root[1].children[0].text === '本条引用第三条，另参见第四条。'),
  );
  check('沙盒：撤销后结构一并恢复', store.getSnapshot().doc.root[2].id === art3.id);
  check('沙盒：重做再次应用', (store.redo(), store.getSnapshot().doc.root.length === 4));
  check('沙盒：无预演时应用返回 false', store.applySandboxPreview() === false);

  // —— 与直接结构操作结果一致（比较去除节点 id 的结构与文本投影） ——
  const direct = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  direct.deleteNode(direct.getSnapshot().doc.root[2].id);
  const project = (nodes: import('../shared/model').ClauseNode[]): unknown =>
    nodes.map((n) => ({
      kind: n.kind,
      ordinal: n.ordinal,
      suffix: n.suffix ?? '',
      title: n.title ?? '',
      text: n.text,
      children: project(n.children),
    }));
  check(
    '沙盒：应用结果与直接删除一致',
    JSON.stringify(project(store.getSnapshot().doc.root)) ===
      JSON.stringify(project(direct.getSnapshot().doc.root)),
  );

  // —— 正文变化后预演失效并禁止应用 ——
  const store2 = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  store2.runSandboxPreview({ kind: 'delete', articleId: store2.getSnapshot().doc.root[2].id });
  check('沙盒：生成后未失效', store2.getSnapshot().sandboxStale === false);
  const par2 = store2.getSnapshot().doc.root[0].children[0];
  store2.updateNodeText(par2.id, `${par2.text}修改。`);
  check('沙盒：正文变化后预演失效', store2.getSnapshot().sandboxStale === true);
  check('沙盒：失效后禁止应用', store2.applySandboxPreview() === false);
  check('沙盒：失效应用不改动结构', store2.getSnapshot().doc.root.length === 5);
  store2.discardSandboxPreview();
  check('沙盒：放弃预演清空', store2.getSnapshot().sandbox === null);

  // —— 批注等非正文提交不使预演失效（正文版本精确性） ——
  const store3 = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  store3.runSandboxPreview({ kind: 'delete', articleId: store3.getSnapshot().doc.root[2].id });
  const par3 = store3.getSnapshot().doc.root[0].children[0];
  store3.addAnnotation(par3.id, 0, 2, '批注');
  check('沙盒：批注提交不变更正文版本', store3.getSnapshot().sandboxStale === false);
  check('沙盒：批注后仍可应用', store3.applySandboxPreview() === true);

  // —— 歧义确认记录变化同样使预演失效（确认影响改写计划） ——
  const ambDoc = parseDocument(`确认失效法

第八条
参见第八条。

第八条之一
补充规定。

第九条
占位。`).doc;
  ambDoc.root[1].suffix = '一';
  const store7 = new AppStore({ doc: ambDoc, confirmed: {}, annotations: [] });
  store7.runSandboxPreview({
    kind: 'move',
    articleId: store7.getSnapshot().doc.root[2].id,
    toIndex: 0,
  });
  check('沙盒：确认前预演未失效', store7.getSnapshot().sandboxStale === false);
  const ambOcc = store7
    .getSnapshot()
    .analysis.occurrences.find((o) => o.resolution.status === 'ambiguous')!;
  store7.confirmAmbiguous(ambOcc.signature, ambDoc.root[1].id);
  check('沙盒：歧义确认变化后预演失效', store7.getSnapshot().sandboxStale === true);
  check('沙盒：确认变化后禁止应用', store7.applySandboxPreview() === false);

  // —— 换号预演：组合引用随目标集合整体重渲染 ——
  const store4 = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  const art1 = store4.getSnapshot().doc.root[0];
  const res4 = store4.runSandboxPreview({ kind: 'renumber', articleId: art1.id, newOrdinal: 3 });
  check('沙盒：换号预演生成成功', res4.ok);
  const sb4 = store4.getSnapshot().sandbox!;
  check('沙盒：换号描述', sb4.label === '将第一条改为第三条', sb4.label);
  check('沙盒：换号列出 3 处改写', sb4.changes.length === 3, JSON.stringify(sb4.changes));
  check(
    '沙盒：组合引用随目标集合重渲染',
    sb4.changes.some((c) => c.raw === '第二条、第三条及第五条' && c.text === '第一条、第二条、第五条'),
    JSON.stringify(sb4.changes),
  );
  check(
    '沙盒：换号不断增断链与循环',
    sb4.issuesAdded.length === 0 && sb4.issuesRemoved.length === 0,
  );

  // —— 移位预演 ——
  const store5 = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  const art5 = store5.getSnapshot().doc.root[4];
  const res5 = store5.runSandboxPreview({ kind: 'move', articleId: art5.id, toIndex: 0 });
  check('沙盒：移位预演生成成功', res5.ok);
  const sb5 = store5.getSnapshot().sandbox!;
  check('沙盒：移位描述', sb5.label === '将第五条移至第 1 位', sb5.label);
  check('沙盒：移位列出 5 处改写', sb5.changes.length === 5, JSON.stringify(sb5.changes));
  check('沙盒：移位可应用', store5.applySandboxPreview() === true);
  check('沙盒：移位应用后目标条到首位', store5.getSnapshot().doc.root[0].id === art5.id);

  // —— 无效与无变化操作 ——
  const store6 = new AppStore({ doc: mkDoc(), confirmed: {}, annotations: [] });
  const root6 = store6.getSnapshot().doc.root;
  check(
    '沙盒：移动到原位报错',
    store6.runSandboxPreview({ kind: 'move', articleId: root6[0].id, toIndex: 0 }).ok === false,
  );
  check(
    '沙盒：换号为自身报错',
    store6.runSandboxPreview({ kind: 'renumber', articleId: root6[0].id, newOrdinal: 1 }).ok === false,
  );
  check(
    '沙盒：换号超出范围报错',
    store6.runSandboxPreview({ kind: 'renumber', articleId: root6[0].id, newOrdinal: 99 }).ok === false,
  );
  check(
    '沙盒：目标不存在报错',
    store6.runSandboxPreview({ kind: 'delete', articleId: 'art_none' }).ok === false,
  );
  check('沙盒：报错后不残留预演', store6.getSnapshot().sandbox === null);

  // —— 预演纯计算：不修改传入的文档与分析 ——
  const pureDoc = mkDoc();
  const pureAnalysis = analyze(pureDoc, { confirmed: {} });
  const pureDocJson = JSON.stringify(pureDoc.root);
  const pureIssuesJson = JSON.stringify(pureAnalysis.issues);
  const purePreview = buildSandboxPreview(
    pureDoc,
    pureAnalysis,
    {},
    { kind: 'delete', articleId: pureDoc.root[2].id },
    0,
  );
  check('沙盒：纯函数预演成功', !('error' in purePreview));
  check('沙盒：预演不修改传入文档', JSON.stringify(pureDoc.root) === pureDocJson);
  check('沙盒：预演不修改传入分析', JSON.stringify(pureAnalysis.issues) === pureIssuesJson);
}

// ---- 引用阅读包：沿引用方向收集依赖全文、循环/汇合去重、断链歧义列示、失效与纯文本 ----
{
  const rpText = `阅读包办法

第一条【目的】
依第二条、第四条办理。

第二条【程序】
本条引用第三条。

第三条【细则】
参见第五条。

第四条【例外】
参见第三条和第二十条。

第五条【附则】
最终条款。`;
  const mkRpDoc = () => parseDocument(rpText).doc;

  // 链式 + 组合：第一条→{第二条,第四条}；第二条→第三条；第四条→第三条、第二十条(断链)；第三条→第五条
  const rpStore = new AppStore({ doc: mkRpDoc(), confirmed: {}, annotations: [] });
  const rpDoc0 = rpStore.getSnapshot().doc;
  const res1 = rpStore.generateReadingPack(rpDoc0.root[0].id);
  check('阅读包：生成成功', res1.ok === true);
  const pack = rpStore.getSnapshot().readingPack!;
  check('阅读包：收录全部 5 条（起点+直接+间接）', pack.total === 5, String(pack.total));
  check(
    '阅读包：按原文档顺序排列',
    pack.entries.map((e) => e.articleId).join(',') === rpDoc0.root.map((a) => a.id).join(','),
  );
  check('阅读包：起点距离 0', pack.entries[0].distance === 0);
  check(
    '阅读包：第二、四条为直接依赖(距离1)',
    pack.entries[1].distance === 1 && pack.entries[3].distance === 1,
  );
  check('阅读包：第三条多路径汇合只收录一次且最短距离2', (() => {
    const e = pack.entries.find((x) => x.articleId === rpDoc0.root[2].id)!;
    return e.distance === 2 && pack.entries.filter((x) => x.articleId === rpDoc0.root[2].id).length === 1;
  })());
  check('阅读包：第五条为间接依赖(距离3，经第三条)', pack.entries.find((x) => x.articleId === rpDoc0.root[4].id)!.distance === 3);
  check('阅读包：最大距离 3', pack.maxDistance === 3, String(pack.maxDistance));
  check('阅读包：汇合路径去重计数为 1（第四条→第三条 与 第二条→第三条 汇合）', pack.dedupedPaths === 1, String(pack.dedupedPaths));

  // 断链列示：第四条的组合引用“第三条和第二十条”部分缺失（整段为一条 broken 出现）
  check('阅读包：收录条款中的断链被列示', pack.warnings.some((w) => w.kind === 'broken' && w.raw === '第三条和第二十条'), JSON.stringify(pack.warnings.map((w) => [w.kind, w.raw])));
  const brokenW = pack.warnings.find((w) => w.raw === '第三条和第二十条')!;
  check('阅读包：断链标明来源条', brokenW.sourceArticleId === rpDoc0.root[3].id);
  check('阅读包：断链含原因', brokenW.reason.length > 0);
  check('阅读包：断链列出缺失目标原文', (brokenW.missingTargets ?? []).some((m) => m.raw === '第九条' || m.raw.includes('第二十条')));
  check('阅读包：断链列出已解析目标（第三条）', (brokenW.resolvedLabels ?? []).includes('第三条'));
  check('阅读包：警告可跳回当前正文（失效前）', readingPackWarningJump(brokenW, rpStore.getSnapshot().analysis)?.nodeId === brokenW.sourceNodeId);

  // 纯文本：保留原编号与正文、不改写原文；含起点标签与警告
  const plain = renderReadingPackText(pack, rpStore.getSnapshot().doc);
  check('阅读包：纯文本含标题与起点', plain.includes('引用阅读包') && plain.includes('阅读包办法') && plain.includes('起点条款：第一条'));
  check('阅读包：纯文本完整列出条款正文', plain.includes('本条引用第三条。') && plain.includes('最终条款。'));
  check('阅读包：纯文本保留款之外的条编号', plain.includes('第五条【附则】'));
  check('阅读包：纯文本末尾列断链及原因', plain.includes('断链 / 歧义引用') && plain.includes('第二十条'));
  check('阅读包：纯文本不把摘录当自足', plain.includes('不是自足文件'));
  check('阅读包：纯文本不改写原文（原文仍为第二十条）', plain.includes('参见第三条和第二十条。'));

  // 失效：正文变化后标记失效，禁止复制旧结果（UI 层禁用，此处校验判定）
  check('阅读包：生成后未失效', rpStore.getSnapshot().readingPackStale === false);
  const par = rpStore.getSnapshot().doc.root[1].children[0];
  rpStore.updateNodeText(par.id, `${par.text}补充。`);
  check('阅读包：正文变化后失效', rpStore.getSnapshot().readingPackStale === true);
  check('阅读包：失效判定（正文版本号变化）', isReadingPackStale(pack, rpStore.getDocRevision(), {}) === true);
  check('阅读包：确认记录变化同样判定失效', isReadingPackStale(pack, pack.docRevision, { some: 'other' }) === true);

  // 重新生成：按最新分析重建，不能复制旧结果
  const resRegen = rpStore.regenerateReadingPack();
  check('阅读包：重新生成成功', resRegen.ok);
  check('阅读包：重新生成后不再失效', rpStore.getSnapshot().readingPackStale === false);
  const pack2 = rpStore.getSnapshot().readingPack!;
  check('阅读包：新包含补充后的正文', renderReadingPackText(pack2, rpStore.getSnapshot().doc).includes('补充。'));
  check('阅读包：旧包不含补充正文（旧结果不被复用）', !renderReadingPackText(pack, mkRpDoc()).includes('补充。'));

  // 批注提交不变更正文版本：不使阅读包失效
  const rpStoreA = new AppStore({ doc: mkRpDoc(), confirmed: {}, annotations: [] });
  rpStoreA.generateReadingPack(rpStoreA.getSnapshot().doc.root[0].id);
  const annPar = rpStoreA.getSnapshot().doc.root[0].children[0];
  rpStoreA.addAnnotation(annPar.id, 0, 2, '批注');
  check('阅读包：批注提交不使阅读包失效', rpStoreA.getSnapshot().readingPackStale === false);

  // 歧义确认变化使阅读包失效；确认前歧义列入警告且不参与收集，确认后参与收集并移出警告
  const ambDoc = parseDocument(`歧义阅读法

第八条
参见第八条。

第八条之一
补充规定。

第九条
引用第八条之一。`).doc;
  ambDoc.root[1].suffix = '一';
  const rpStoreB = new AppStore({ doc: ambDoc, confirmed: {}, annotations: [] });
  const ambOcc = rpStoreB.getSnapshot().analysis.occurrences.find((o) => o.resolution.status === 'ambiguous')!;
  // 以第九条为起点：它引用第八条之一（唯一），第八条之一无出边 → 只收 2 条
  rpStoreB.generateReadingPack(ambDoc.root[2].id);
  const packAmb = rpStoreB.getSnapshot().readingPack!;
  check('阅读包：起点不含歧义时无歧义警告', packAmb.total === 2 && packAmb.warnings.length === 0, JSON.stringify(packAmb.warnings.map((w) => w.raw)));
  // 以第八条（含未确认歧义）为起点：歧义列入警告，且不向任何候选延伸
  rpStoreB.generateReadingPack(ambDoc.root[0].id);
  const packAmb2 = rpStoreB.getSnapshot().readingPack!;
  check('阅读包：未确认歧义列入警告', packAmb2.warnings.some((w) => w.kind === 'ambiguous' && w.raw === '第八条'));
  check('阅读包：歧义警告含候选', (packAmb2.warnings.find((w) => w.kind === 'ambiguous')!.candidateLabels ?? []).length === 2);
  check('阅读包：未确认歧义不参与收集（不延伸到候选）', packAmb2.total === 1, String(packAmb2.total));
  // 确认后重新生成：按所确认目标延伸，警告消失
  rpStoreB.confirmAmbiguous(ambOcc.signature, ambDoc.root[1].id);
  check('阅读包：歧义确认变化后旧包失效', rpStoreB.getSnapshot().readingPackStale === true);
  rpStoreB.regenerateReadingPack();
  const packAmb3 = rpStoreB.getSnapshot().readingPack!;
  check('阅读包：确认后阅读包不再失效', rpStoreB.getSnapshot().readingPackStale === false);
  check('阅读包：已确认歧义不再列入警告', !packAmb3.warnings.some((w) => w.kind === 'ambiguous'));
  check('阅读包：确认后按目标参与收集（第八条→第八条之一）', packAmb3.total === 2 && packAmb3.entries.some((e) => e.articleId === ambDoc.root[1].id), String(packAmb3.total));

  // 组合引用每个已解析目标都参与收集
  const comboDoc = parseDocument(`组合阅读法

第一条
依第二条、第三条及第四条办理。

第二条
内容二。

第三条
内容三。

第四条
内容四。`).doc;
  const comboStore = new AppStore({ doc: comboDoc, confirmed: {}, annotations: [] });
  comboStore.generateReadingPack(comboDoc.root[0].id);
  const comboPack = comboStore.getSnapshot().readingPack!;
  check('阅读包：组合引用每个目标都收录', comboPack.total === 4, String(comboPack.total));
  check(
    '阅读包：组合目标全部距离1',
    comboPack.entries.slice(1).every((e) => e.distance === 1),
  );

  // 部分缺失的组合引用：已解析目标参与收集，缺失目标列入断链并附已解析清单
  const partialDoc = parseDocument(`部分组合法

第一条
依第二条、第三条及第九条办理。

第二条
内容二。

第三条
内容三。`).doc;
  const partialStore = new AppStore({ doc: partialDoc, confirmed: {}, annotations: [] });
  partialStore.generateReadingPack(partialDoc.root[0].id);
  const pPack = partialStore.getSnapshot().readingPack!;
  check('阅读包：部分组合已解析目标仍收录', pPack.total === 3, String(pPack.total));
  const pW = pPack.warnings.find((w) => w.kind === 'broken')!;
  check('阅读包：部分组合列入断链警告', Boolean(pW) && pW.raw.includes('第九条'));
  check('阅读包：部分组合列出缺失目标', (pW.missingTargets ?? []).some((m) => m.raw.includes('第九条')));
  check('阅读包：部分组合列出已解析目标', (pW.resolvedLabels ?? []).length === 2 && (pW.resolvedLabels ?? []).includes('第二条'));

  // 循环：只收录一次并标注，去重计数
  const cycRpDoc = parseDocument(`循环阅读法

第一条
参见第二条。

第二条
参见第一条。`).doc;
  const cycStore = new AppStore({ doc: cycRpDoc, confirmed: {}, annotations: [] });
  cycStore.generateReadingPack(cycRpDoc.root[0].id);
  const cycPack = cycStore.getSnapshot().readingPack!;
  check('阅读包：循环只收录一次', cycPack.total === 2 && new Set(cycPack.entries.map((e) => e.articleId)).size === 2);
  check('阅读包：循环条款标注', cycPack.entries.every((e) => e.inCycle));
  check('阅读包：循环回指去重计数', cycPack.dedupedPaths === 1, String(cycPack.dedupedPaths));

  // 起点条款不存在 / 款、项完整收录与结构编号
  const itemDoc = parseDocument(`款项阅读法

第一条
如下：
（一）参见第二条；
（二）其他。

第二条
回复。`).doc;
  const itemStore = new AppStore({ doc: itemDoc, confirmed: {}, annotations: [] });
  check('阅读包：起点不存在报错', itemStore.generateReadingPack('art_nope').ok === false);
  itemStore.generateReadingPack(itemDoc.root[0].id);
  const itemPack = itemStore.getSnapshot().readingPack!;
  check('阅读包：含款、项的条完整收录', itemPack.total === 2);
  const itemPlain = renderReadingPackText(itemPack, itemStore.getSnapshot().doc);
  check('阅读包：纯文本保留款、项编号与正文', itemPlain.includes('第一款') && itemPlain.includes('（一）参见第二条；') && itemPlain.includes('（二）其他。'));

  // 纯计算：buildReadingPack 不修改传入的文档与分析
  const pureRpDoc = mkRpDoc();
  const pureRpA = analyze(pureRpDoc, { confirmed: {} });
  const docJson = JSON.stringify(pureRpDoc);
  const analysisJson = JSON.stringify(pureRpA);
  const built = buildReadingPack(pureRpDoc, pureRpA, pureRpDoc.root[0].id, 0, {});
  check('阅读包：纯函数生成成功', !('error' in built));
  check('阅读包：不修改传入文档', JSON.stringify(pureRpDoc) === docJson);
  check('阅读包：不修改传入分析', JSON.stringify(pureRpA) === analysisJson);

  // 会话内临时：不持久化、不进入撤销历史；清空不影响正文
  const tmpStore = new AppStore({ doc: mkRpDoc(), confirmed: {}, annotations: [] });
  tmpStore.generateReadingPack(tmpStore.getSnapshot().doc.root[0].id);
  check('阅读包：生成不进入撤销历史', tmpStore.getSnapshot().canUndo === false);
  const beforeTmp = JSON.stringify(tmpStore.getSnapshot().doc);
  tmpStore.clearReadingPack();
  check('阅读包：清空后无阅读包', tmpStore.getSnapshot().readingPack === null);
  check('阅读包：清空不影响正文', JSON.stringify(tmpStore.getSnapshot().doc) === beforeTmp);
  const exported = tmpStore.exportJson();
  check('阅读包：不随 JSON 导出', !('readingPack' in exported));
}

// ---- 条款审签：条文指纹、签署 / 重签 / 撤销恢复、删除不计统计、持久化与导入导出 ----
{
  const sgText = `审签办法

第一条【目的】
为了规范审签活动，制定本办法。

第二条【程序】
程序如下：
（一）起草；
（二）审查。

第三条【附则】
参见第一条。`;
  const mkSgDoc = () => parseDocument(sgText).doc;

  // —— 指纹：相同条文稳定，条号 / 标题 / 正文 / 款 / 项任一变化即改变 ——
  const d0 = mkSgDoc();
  const fp1 = articleFingerprint(d0.root[0]);
  check('审签：指纹为 16 位十六进制', /^[0-9a-f]{16}$/.test(fp1), fp1);
  check('审签：相同条文指纹稳定', articleFingerprint(cloneTree(d0.root)[0]) === fp1);
  check('审签：FNV 空串向量', fnv1a64('') === 'cbf29ce484222325', fnv1a64(''));
  check('审签：规范化投影含条号/标题/正文/款/项', (() => {
    const c = canonicalArticle(d0.root[1]) as Record<string, unknown>;
    const p = c.p as { t: string; c: unknown[] }[];
    return c.n === 2 && c.h === '程序' && Array.isArray(p) && p.length === 1 && p[0].t === '程序如下：';
  })());
  const canonItem = (canonicalArticle(d0.root[1]).p as { c: unknown[] }[])[0];
  check('审签：款下含 2 项', canonItem.c.length === 2, String(canonItem.c.length));

  const titleChanged = cloneTree(d0.root);
  titleChanged[0].title = '目标';
  check('审签：标题变化指纹改变', articleFingerprint(titleChanged[0]) !== fp1);
  const headChanged = cloneTree(d0.root);
  headChanged[0].text = `${headChanged[0].text}补充。`;
  check('审签：条头正文变化指纹改变', articleFingerprint(headChanged[0]) !== fp1);
  const paraChanged = cloneTree(d0.root);
  paraChanged[1].children[0].text = `${paraChanged[1].children[0].text}。`;
  check('审签：款正文变化该条指纹改变', articleFingerprint(paraChanged[1]) !== articleFingerprint(d0.root[1]));
  const itemChanged = cloneTree(d0.root);
  itemChanged[1].children[0].children[1].text = '（二）复核。';
  check('审签：项正文变化该条指纹改变', articleFingerprint(itemChanged[1]) !== articleFingerprint(d0.root[1]));
  const otherUnchanged = cloneTree(d0.root);
  check('审签：编辑第二条不影响第一条指纹', articleFingerprint(otherUnchanged[0]) === fp1);

  // —— 签署：有效 / 未签统计 ——
  const sgStore = new AppStore({ doc: mkSgDoc(), confirmed: {}, annotations: [] });
  const art1 = sgStore.getSnapshot().doc.root[0];
  const art2 = sgStore.getSnapshot().doc.root[1];
  const art3 = sgStore.getSnapshot().doc.root[2];
  check('审签：初始全部未签', (() => {
    const v = sgStore.getSignoffView();
    return v.counts.total === 3 && v.counts.unsigned === 3 && v.counts.valid === 0 && v.counts.stale === 0;
  })());
  check('审签：空审签人被拒绝', sgStore.signArticle(art1.id, '  ').ok === false);
  check('审签：不存在的条被拒绝', sgStore.signArticle('art_nope', '张三').ok === false);
  check('审签：签署成功', sgStore.signArticle(art1.id, '张三').ok === true);
  {
    const v = sgStore.getSignoffView();
    check('审签：签署后 1 有效 2 未签', v.counts.valid === 1 && v.counts.unsigned === 2, JSON.stringify(v.counts));
    const e = v.entries[0];
    check('审签：有效条目记录审签人与指纹', e.status === 'valid' && e.signoff?.signer === '张三' && e.signoff.fingerprint === fp1);
    check('审签：签署不进入撤销历史', sgStore.getSnapshot().canUndo === false);
  }

  // —— 正文编辑 -> 待重签；撤销恢复原文 -> 恢复有效 ——
  sgStore.updateNodeText(art1.id, `${art1.text}新增内容。`);
  check('审签：正文编辑后待重签', sgStore.getSignoffView().entries[0].status === 'stale');
  check('审签：统计 1 待重签 2 未签 0 有效', (() => {
    const c = sgStore.getSignoffView().counts;
    return c.stale === 1 && c.unsigned === 2 && c.valid === 0;
  })());
  sgStore.undo();
  check('审签：撤销恢复原文后恢复有效', sgStore.getSignoffView().entries[0].status === 'valid');
  sgStore.redo();
  check('审签：重做后再次待重签', sgStore.getSignoffView().entries[0].status === 'stale');
  sgStore.undo();

  // —— 结构调整（拖拽换序 + 自动引用改写）-> 受影响条待重签，未变化条保持有效 ——
  check('审签：第二条签署有效', sgStore.signArticle(art2.id, '李四').ok === true);
  // 第三条引用第一条，结构操作前先签署：它正文含引用，第三条移到首位时其自身编号不变但其他条改写
  check('审签：第三条签署有效', sgStore.signArticle(art3.id, '王五').ok === true);
  check('审签：三条均有效', sgStore.getSignoffView().counts.valid === 3);
  // 把第三条移到首位（3->1, 1->2, 2->3）：条号变化使三条全部指纹改变，且第一/二条正文被自动改写
  sgStore.reorderSibling(art3.id, 0);
  {
    const v = sgStore.getSignoffView();
    check('审签：结构调整后全部待重签（条号即条文的一部分）', v.counts.stale === 3 && v.counts.valid === 0, JSON.stringify(v.counts));
    check('审签：稳定 ID 仍可定位到原条', v.entries[0].articleId === art3.id);
  }
  sgStore.undo();
  check('审签：撤销结构调整后三条恢复有效', sgStore.getSignoffView().counts.valid === 3);

  // —— 仅影响单条的编辑：其他条保持有效 ——
  sgStore.updateNodeText(art2.children[0].id, `${art2.children[0].text}补充。`);
  {
    const v = sgStore.getSignoffView();
    const byId = new Map(v.entries.map((e) => [e.articleId, e.status]));
    check('审签：改款正文仅第二条待重签', byId.get(art2.id) === 'stale' && byId.get(art1.id) === 'valid' && byId.get(art3.id) === 'valid');
  }
  sgStore.undo();

  // —— 删除条：记录保留但不计入当前统计；其后条因重编号显示待重签；撤销删除恢复 ——
  sgStore.deleteNode(art2.id);
  {
    const v = sgStore.getSignoffView();
    check('审签：删除后当前统计 2 条', v.counts.total === 2 && v.deleted.length === 1, JSON.stringify(v.counts));
    check('审签：删除条记录进入已删除列表', v.deleted[0].articleId === art2.id && v.deleted[0].status === 'deleted' && v.deleted[0].signoff?.signer === '李四');
    // 第三条重编号为第二条 -> 受结构调整影响待重签；第一条编号未变保持有效
    const byId = new Map(v.entries.map((e) => [e.articleId, e.status]));
    check('审签：删除后首条仍有效、其后条因重编号待重签', byId.get(art1.id) === 'valid' && byId.get(art3.id) === 'stale');
  }
  sgStore.undo();
  {
    const v = sgStore.getSignoffView();
    check('审签：撤销删除后恢复且条文一致即有效', v.counts.total === 3 && v.deleted.length === 0 && v.counts.valid === 3);
  }

  // —— 重新签署：刷新指纹与时间，归档上一版签署 ——
  sgStore.updateNodeText(art1.id, `${art1.text}修订。`);
  check('审签：修订后待重签', sgStore.getSignoffView().entries.find((e) => e.articleId === art1.id)!.status === 'stale');
  const beforeResign = sgStore.getSignoffView().entries.find((e) => e.articleId === art1.id)!.signoff!;
  check('审签：重新签署成功', sgStore.signArticle(art1.id, '赵六').ok === true);
  {
    const e = sgStore.getSignoffView().entries.find((x) => x.articleId === art1.id)!;
    check('审签：重签后恢复有效且审签人更新', e.status === 'valid' && e.signoff!.signer === '赵六');
    check('审签：上一版签署归档', e.signoff!.history?.length === 1 && e.signoff!.history![0].signer === '张三');
    check('审签：归档指纹为旧指纹', e.signoff!.history![0].fingerprint === beforeResign.fingerprint);
  }

  // —— 持久化 + JSON 导入导出：随包往返，旧数据按空记录加载 ——
  const bundle = sgStore.exportJson();
  check('审签：随 JSON 导出 3 条记录', Array.isArray(bundle.signoffs) && bundle.signoffs!.length === 3, String(bundle.signoffs?.length));
  const reimported = new AppStore({ doc: mkSgDoc(), confirmed: {}, annotations: [] });
  reimported.importJson(bundle);
  {
    const v = reimported.getSignoffView();
    check('审签：导入后按当前条文重算（同文档 -> 2 有效，第一条为重签后的新指纹仍有效）', v.counts.valid === 3 && v.counts.stale === 0, JSON.stringify(v.counts));
  }
  // 旧文件缺少 signoffs：按空记录加载
  const legacy = new AppStore({ doc: mkSgDoc(), confirmed: {}, annotations: [] });
  legacy.importJson({ ...bundle, signoffs: undefined });
  check('审签：旧数据缺少 signoffs 按空记录加载', legacy.getSignoffView().counts.unsigned === 3);

  // —— 规整：非法记录被剔除，同一条多条记录取最新 ——
  check('审签：非数组规整为空', sanitizeSignoffs(null).length === 0);
  check('审签：缺字段记录被剔除', sanitizeSignoffs([
    { id: 'a', articleId: art1.id, signer: '  ', fingerprint: 'x', signedAt: 1 },
    { id: 'b', articleId: art1.id, signer: '张三', fingerprint: '', signedAt: 1 },
    { id: 'c', articleId: '', signer: '张三', fingerprint: 'x', signedAt: 1 },
  ]).length === 0);
  check('审签：合法记录保留并 trim 审签人', sanitizeSignoffs([
    { id: 'a', articleId: art1.id, signer: ' 张三 ', fingerprint: 'x', signedAt: 1 },
  ])[0].signer === '张三');
  {
    const dupDoc = mkSgDoc();
    const dupArtId = dupDoc.root[0].id;
    const s1 = { id: 'a', articleId: dupArtId, signer: '张三', fingerprint: 'x', signedAt: 1 };
    const s2 = { id: 'b', articleId: dupArtId, signer: '李四', fingerprint: 'y', signedAt: 2 };
    const v = buildSignoffView(dupDoc, [s1, s2]);
    check('审签：同条多条记录汇总取最新签署', v.entries[0].signoff?.id === 'b');
  }

  // —— 粘贴替换 / 载入示例：审签清空 ——
  reimported.importPastedText(sgText);
  check('审签：粘贴新文档后清空', reimported.getSignoffView().counts.unsigned === 3 && reimported.getSignoffView().deleted.length === 0);
}

// ---- 断链 / 自引用问题的例外处置：稳定身份 + 来源句证据、实时三态、筛选、持久化与导入导出 ----
{
  const exText = `例外办法

第一条【目的】
本条引用不存在的第十二条，属于断链。
如下：
（一）本项规定本项的适用，自指一例。

第二条
普通条文，参见第三条。

第三条
程序条文。

第四条
参见第二条。

第五条
附则。`;
  // 解析一次：所有变体均克隆该树，保证稳定节点 ID（重新 parse 会生成新 ID）
  const baseDoc = parseDocument(exText).doc;
  const mkExDoc = () => ({ ...baseDoc, root: cloneTree(baseDoc.root) });

  // —— 初始分析：一个断链（第一款）+ 两个自引用（项内“本项”），无循环 / 歧义 ——
  const aA = analyze(mkExDoc(), { confirmed: {} });
  const brokenIssue = aA.issues.find((i) => i.type === 'broken')!;
  const selfIssue = aA.issues.find((i) => i.type === 'self')!;
  check('例外：初始存在断链与自引用', Boolean(brokenIssue) && aA.issues.filter((i) => i.type === 'self').length === 2);
  check('例外：断链 / 自引用可处置，循环 / 歧义不可', isExceptionableIssue(brokenIssue) && isExceptionableIssue(selfIssue));
  check('例外：示例无循环 / 歧义', !aA.issues.some((i) => !isExceptionableIssue(i)));

  const exStore = new AppStore({ doc: mkExDoc(), confirmed: {}, annotations: [] });
  const broken = exStore.getSnapshot().analysis.issues.find((i) => i.type === 'broken')!;
  const selfRef = exStore.getSnapshot().analysis.issues.find((i) => i.type === 'self')!;
  const brokenNode = exStore.getSnapshot().analysis.nodes[broken.sourceNodeId];
  const brokenSentence = brokenNode.text.slice(broken.sentenceStart, broken.sentenceEnd).trim();

  // —— 接受例外：理由必填，记录身份与来源句证据 ——
  check('例外：空理由被拒绝', exStore.acceptIssueException(broken.identity, '   ').ok === false);
  check('例外：不存在的身份被拒绝', exStore.acceptIssueException('broken::nope::第九条::9', 'r').ok === false);
  check('例外：接受成功', exStore.acceptIssueException(broken.identity, '  该条后续立法另行补充  ').ok === true);
  check('例外：接受不进入撤销历史', exStore.getSnapshot().canUndo === false);
  {
    const rec = exStore.getSnapshot().issueExceptions[0];
    check('例外：记录理由被 trim', rec.reason === '该条后续立法另行补充');
    check('例外：记录绑定稳定身份', rec.identity === broken.identity);
    check('例外：保存处置时来源句原文', rec.sourceSentence === brokenSentence && rec.sourceSentence.includes('第十二条'));
    check('例外：保存源节点稳定 ID', rec.sourceNodeId === broken.sourceNodeId);
    check('例外：记录类型为断链', rec.type === 'broken');
    const v = exStore.getExceptionView();
    check('例外：实时重算为已接受', v.length === 1 && v[0].status === 'accepted' && v[0].currentSentence === rec.sourceSentence);
  }

  // —— 偏移变化但来源句不变：身份仍在、句子一致，仍判已接受 ——
  exStore.updateNodeText(broken.sourceNodeId, `前言增补。${brokenNode.text}`);
  check('例外：句前加字偏移变化仍判已接受', exStore.getExceptionView()[0].status === 'accepted');
  exStore.undo();
  check('例外：撤销加字后仍已接受', exStore.getExceptionView()[0].status === 'accepted');

  // —— 来源句变化（引用原文不变、句中其他文字改变）：身份仍在但句子不一致，转待复核；重新确认刷新证据 ——
  exStore.updateNodeText(broken.sourceNodeId, brokenNode.text.replace('属于断链', '属于明显断链'));
  {
    const v = exStore.getExceptionView();
    check('例外：来源句变化转待复核', v[0].status === 'review' && v[0].currentSentence !== v[0].record.sourceSentence);
    check('例外：待复核数量可汇总（侧栏徽标用）', exStore.getSnapshot().exceptionView.filter((e) => e.status === 'review').length === 1);
    check('例外：重新确认空理由被拒绝', exStore.reconfirmIssueException(broken.identity, ' ').ok === false);
    check('例外：身份已消失时重新确认被拒绝', exStore.reconfirmIssueException('broken::gone::第九条::9', 'r').ok === false);
    check('例外：重新确认成功', exStore.reconfirmIssueException(broken.identity, '句中文字修订，仍按例外处理').ok === true);
    const v2 = exStore.getExceptionView();
    check('例外：重新确认后恢复已接受', v2[0].status === 'accepted');
    check('例外：重新确认刷新来源句证据', v2[0].record.sourceSentence.includes('明显断链') && v2[0].currentSentence === v2[0].record.sourceSentence);
    check('例外：重新确认更新理由与时间', v2[0].record.reason === '句中文字修订，仍按例外处理' && v2[0].record.acceptedAt > 0);
  }
  // 撤销编辑回到初始正文：证据是“明显断链”句子，当前为原句 → 待复核（记录不随撤销删除）
  exStore.undo();
  check('例外：撤销正文不撤销记录，按当前句子重判待复核', exStore.getExceptionView()[0].status === 'review');

  // —— 撤销处置：记录删除，问题恢复未处置（不改正文、不进历史）——
  exStore.revokeIssueException(broken.identity);
  check('例外：撤销处置后无记录', exStore.getSnapshot().issueExceptions.length === 0);
  check('例外：撤销处置不改正文、不进历史', exStore.getSnapshot().canUndo === false && exStore.getSnapshot().analysis.issues.some((i) => i.identity === broken.identity));

  // —— 问题消失：改正正文使身份从实时问题中消失，记录转已消失 ——
  check('例外：再次接受成功', exStore.acceptIssueException(broken.identity, '后续立法补充').ok === true);
  exStore.acceptIssueException(selfRef.identity, '表述需要，接受本项自指');
  check('例外：两条已接受', exStore.getExceptionView().filter((e) => e.status === 'accepted').length === 2);
  exStore.updateNodeText(
    broken.sourceNodeId,
    brokenNode.text.replace('本条引用不存在的第十二条，属于断链。', '本条引用第三条，正常无断链。'),
  );
  {
    const v = exStore.getExceptionView();
    const gone = v.find((e) => e.record.identity === broken.identity)!;
    check('例外：问题改正后记录转已消失', gone.status === 'gone' && gone.currentIssue === null && gone.currentSentence === null);
    check('例外：自引用记录不受影响仍已接受', v.find((e) => e.record.identity === selfRef.identity)?.status === 'accepted');
    check('例外：已消失不计入已接受统计', exStore.getSnapshot().exceptionView.filter((e) => e.status === 'accepted').length === 1);
  }
  // 撤销改正：问题按同一身份回来且来源句与证据一致 → 自动恢复已接受
  exStore.undo();
  check('例外：撤销改正后身份回来、句子一致恢复已接受', exStore.getExceptionView().find((e) => e.record.identity === broken.identity)?.status === 'accepted');

  // —— 源节点删除：断链与自引用（同在第一条）均转已消失，留痕可删除 ——
  const art1Id = exStore.getSnapshot().doc.root[0].id;
  exStore.deleteNode(art1Id);
  {
    const v = exStore.getExceptionView();
    check('例外：删除第一条后该条两个问题记录均转已消失', v.filter((e) => e.status === 'gone').length === 2, String(v.map((e) => e.status)));
    const gone = v.find((e) => e.record.identity === broken.identity)!;
    check('例外：已消失保留处置时来源句证据', gone.record.sourceSentence.includes('第十二条'));
  }
  // 撤销删除：问题按同一身份回来，两条记录自动恢复已接受（留痕删除不进撤销历史，故放在撤销之后验证）
  exStore.undo();
  check('例外：撤销删除后记录恢复已接受', exStore.getExceptionView().filter((e) => e.status === 'accepted').length === 2);
  // 再次删除后可清理留痕
  exStore.deleteNode(art1Id);
  const beforeDelete = exStore.getSnapshot().issueExceptions.length;
  exStore.deleteIssueException(exStore.getExceptionView().find((e) => e.record.identity === broken.identity)!.record.id);
  check('例外：已消失记录可删除留痕', exStore.getSnapshot().issueExceptions.length === beforeDelete - 1);
  exStore.undo();

  // —— 纯函数：accept / reconfirm（同文档克隆，节点 ID 稳定）——
  const pureDoc = mkExDoc();
  const aPure = analyze(pureDoc, { confirmed: {} });
  const pureIssue = aPure.issues.find((i) => i.type === 'broken')!;
  const rec1 = acceptIssueException(pureIssue, aPure, '理由');
  check('例外：acceptIssueException 生成记录', rec1.identity === pureIssue.identity && rec1.reason === '理由' && rec1.sourceSentence.includes('第十二条'));
  const changedDoc = mkExDoc();
  const pNode = changedDoc.root[0].children.find((n) => n.id === pureIssue.sourceNodeId)!;
  pNode.text = pNode.text.replace('属于断链', '属于明显断链');
  const aChanged = analyze(changedDoc, { confirmed: {} });
  const changedIssue = aChanged.issues.find((i) => i.identity === pureIssue.identity)!;
  check('例外：身份不依赖字符偏移（同节点、同引用原文、同序次）', Boolean(changedIssue) && changedIssue.identity === pureIssue.identity);
  const later = rec1.acceptedAt + 10;
  const rec2 = reconfirmIssueException(rec1, changedIssue, aChanged, '新理由', later);
  check('例外：reconfirm 刷新证据保留 id', rec2.id === rec1.id && rec2.sourceSentence.includes('明显断链') && rec2.reason === '新理由' && rec2.acceptedAt === later);
  // 视图纯计算：句子一致已接受 / 句子变化待复核 / 身份消失已消失
  check('例外：视图判已接受', buildIssueExceptionView(aPure, [rec1])[0].status === 'accepted');
  check('例外：视图判待复核', buildIssueExceptionView(aChanged, [rec1])[0].status === 'review');
  check('例外：视图判已消失', buildIssueExceptionView(analyze(mkExDoc(), { confirmed: {} }), [
    { ...rec1, identity: 'broken::nope::第九条::9' },
  ])[0].status === 'gone');

  // —— 规整：非法记录剔除、trim、同身份去重 ——
  check('例外：非数组规整为空', sanitizeIssueExceptions(null).length === 0);
  check('例外：非法记录被剔除', sanitizeIssueExceptions([
    null,
    { id: 'a' },
    { id: 'b', identity: 'x', type: 'cycle', reason: 'r', sourceNodeId: 'n', sourceSentence: 's', acceptedAt: 1 },
    { id: 'c', identity: 'x', type: 'broken', reason: '  ', sourceNodeId: 'n', sourceSentence: 's', acceptedAt: 1 },
    { id: 'd', identity: 'x', type: 'broken', reason: 'r', sourceNodeId: '', sourceSentence: 's', acceptedAt: 1 },
    { id: 'e', identity: 'x', type: 'broken', reason: 'r', sourceNodeId: 'n', sourceSentence: '', acceptedAt: 1 },
  ]).length === 0);
  check('例外：合法记录规整 trim 并补 id', (() => {
    const out = sanitizeIssueExceptions([
      { identity: 'x', type: 'self', reason: ' 理由 ', sourceNodeId: 'n', sourceSentence: ' 句子 ', acceptedAt: 5 },
    ]);
    return out.length === 1 && out[0].reason === '理由' && out[0].sourceSentence === '句子' && Boolean(out[0].id);
  })());
  check('例外：同一身份多条只保留一条', sanitizeIssueExceptions([
    { identity: 'x', type: 'broken', reason: 'r1', sourceNodeId: 'n', sourceSentence: 's', acceptedAt: 1 },
    { identity: 'x', type: 'broken', reason: 'r2', sourceNodeId: 'n', sourceSentence: 's', acceptedAt: 2 },
  ]).length === 1);

  // —— 持久化 + JSON 导入导出：随包往返，旧数据按空记录加载 ——
  const persistStore = new AppStore({ doc: mkExDoc(), confirmed: {}, annotations: [] });
  persistStore.acceptIssueException(
    persistStore.getSnapshot().analysis.issues.find((i) => i.type === 'broken')!.identity,
    '持久化理由',
  );
  const bundle = persistStore.exportJson();
  check('例外：随 JSON 导出', Array.isArray(bundle.issueExceptions) && bundle.issueExceptions!.length === 1 && bundle.issueExceptions![0].reason === '持久化理由');
  const reimported = new AppStore({ doc: mkExDoc(), confirmed: {}, annotations: [] });
  reimported.importJson(bundle);
  check('例外：导入后按当前分析重算已接受', reimported.getExceptionView()[0]?.status === 'accepted');
  // 例外记录随文档导入到来源句已变化的版本（引用原文不变、句中文字改变）：转待复核
  const changedImportDoc = mkExDoc();
  {
    const p = changedImportDoc.root[0].children.find((n) => n.id === bundle.issueExceptions![0].sourceNodeId)!;
    p.text = p.text.replace('属于断链', '属于明显断链');
  }
  const changedImport = new AppStore({ doc: mkExDoc(), confirmed: {}, annotations: [] });
  changedImport.importJson({ doc: changedImportDoc, confirmed: {}, issueExceptions: bundle.issueExceptions });
  check('例外：导入到变化后文档转待复核', changedImport.getExceptionView()[0]?.status === 'review', changedImport.getExceptionView()[0]?.status);
  // 问题已消失的文档导入：转已消失
  const goneDoc = mkExDoc();
  {
    const p = goneDoc.root[0].children.find((n) => n.id === bundle.issueExceptions![0].sourceNodeId)!;
    p.text = p.text.replace('本条引用不存在的第十二条，属于断链。', '本条引用第三条，属于断链。');
  }
  const goneImport = new AppStore({ doc: mkExDoc(), confirmed: {}, annotations: [] });
  goneImport.importJson({ doc: goneDoc, confirmed: {}, issueExceptions: bundle.issueExceptions });
  check('例外：导入到问题已消失文档转已消失', goneImport.getExceptionView()[0]?.status === 'gone');
  // 旧文件缺少 issueExceptions：按空记录加载
  const legacy = new AppStore({ doc: mkExDoc(), confirmed: {}, annotations: [] });
  legacy.importJson({ ...bundle, issueExceptions: undefined });
  check('例外：旧数据缺少 issueExceptions 按空记录加载', legacy.getSnapshot().issueExceptions.length === 0);

  // —— 粘贴替换 / 载入示例：例外记录清空 ——
  reimported.importPastedText(exText);
  check('例外：粘贴新文档后清空', reimported.getSnapshot().issueExceptions.length === 0);
}

// ---- 引用路径核对：最短有向路径、组合引用各目标成边、正文顺序取证据、循环不重复搜索、随确认/正文重算 ----
{
  // 第一条→第二条；第二条→第三条；第三条→第四条；另第一条→第四条（更长的直达？实际直达更短）
  // 另构「长链 + 捷径」：第一条→第二条→第三条→第四条，且第一条直接→第四条（直达为最短）
  const pfText = `路径核对办法

第一条
依第二条办理。

第二条
引用第三条。

第三条
参见第四条。

第四条
终点条款。`;
  const mkPfDoc = () => parseDocument(pfText).doc;
  const pfStore = new AppStore({ doc: mkPfDoc(), confirmed: {}, annotations: [] });
  const pfDoc = pfStore.getSnapshot().doc;
  const A1 = pfDoc.root[0].id, A2 = pfDoc.root[1].id, A3 = pfDoc.root[2].id, A4 = pfDoc.root[3].id;
  let pf = findReferencePath(pfStore.getSnapshot().analysis, A1, A4);
  check('路径核对：长链可达', pf.kind === 'path');
  if (pf.kind === 'path') {
    check('路径核对：长链跳数 3', pf.hopsCount === 3, String(pf.hopsCount));
    check(
      '路径核对：逐跳节点顺序 一→二→三→四',
      pf.hops.map((h) => h.targetArticleId).join(',') === [A2, A3, A4].join(','),
    );
    check('路径核对：每跳带来源条', pf.hops[0].sourceArticleId === A1 && pf.hops[2].sourceArticleId === A3);
    check('路径核对：证据为来源句原文', pf.hops[0].sentenceText.includes('依第二条办理'));
    check('路径核对：引用原文为第二条', pf.hops[0].refRaw === '第二条');
    check('路径核对：句内相对区间指向引用原文', pf.hops[0].sentenceText.slice(pf.hops[0].refInSentenceStart, pf.hops[0].refInSentenceEnd) === '第二条');
    check('路径核对：目标节点可定位到条', pf.hops[0].targetNodeId === A2);
  }

  // 新增捷径：第一条直接引用第四条 → 最短路径变为 1 跳（结果随当前分析重算）
  {
    const par = pfStore.getSnapshot().doc.root[0].children[0];
    pfStore.updateNodeText(par.id, '依第二条、第四条办理。');
  }
  pf = findReferencePath(pfStore.getSnapshot().analysis, A1, A4);
  check('路径核对：出现组合捷径后重算为最短 1 跳', pf.kind === 'path' && pf.hopsCount === 1, pf.kind);
  if (pf.kind === 'path') {
    check('路径核对：捷径边目标为第四条', pf.hops[0].targetArticleId === A4);
    check('路径核对：组合引用标记', pf.hops[0].combined === true && pf.hops[0].refRaw === '第二条、第四条');
  }

  // 无路径：第四条（无出边）→ 第一条
  const noPath = findReferencePath(pfStore.getSnapshot().analysis, A4, A1);
  check('路径核对：无路径明确提示', noPath.kind === 'no-path', noPath.kind);
  if (noPath.kind === 'no-path') check('路径核对：无路径可达数为 0', noPath.reachedCount === 0, String(noPath.reachedCount));

  // 起点 === 终点：零跳
  const same = findReferencePath(pfStore.getSnapshot().analysis, A2, A2);
  check('路径核对：同条零跳', same.kind === 'same' && same.hops.length === 0);

  // 端点不存在
  const missing = findReferencePath(pfStore.getSnapshot().analysis, A1, 'art_nope');
  check('路径核对：终点缺失', missing.kind === 'missing-endpoint' && missing.missing === 'target');

  // 组合引用每个已解析目标各作为一条边
  const comboDoc = parseDocument(`组合路径法

第一条
依第二条、第三条及第四条办理。

第二条
参见第四条。

第三条
参见第四条。

第四条
终。`).doc;
  const comboStore = new AppStore({ doc: comboDoc, confirmed: {}, annotations: [] });
  const cA1 = comboDoc.root[0].id, cA2 = comboDoc.root[1].id, cA4 = comboDoc.root[3].id;
  const cp = findReferencePath(comboStore.getSnapshot().analysis, cA1, cA4);
  check('路径核对：组合直达目标 1 跳', cp.kind === 'path' && cp.hopsCount === 1, cp.kind);
  // 第一条→第二条（组合中的成员）也成边
  const cp2 = findReferencePath(comboStore.getSnapshot().analysis, cA1, cA2);
  check('路径核对：组合成员第二条也成边', cp2.kind === 'path' && cp2.hopsCount === 1);

  // 同一条对多处引用：按正文顺序取最先出现且可展示的证据
  const multiDoc = parseDocument(`多处引用法

第一条
先参见第三条。
再引用第三条。

第二条
无关条款。

第三条
被引条款。`).doc;
  const multiStore = new AppStore({ doc: multiDoc, confirmed: {}, annotations: [] });
  const mA1 = multiDoc.root[0].id, mA3 = multiDoc.root[2].id;
  const mp = findReferencePath(multiStore.getSnapshot().analysis, mA1, mA3);
  check('路径核对：多处引用取正文顺序最先者', mp.kind === 'path');
  if (mp.kind === 'path') {
    check('路径核对：证据为第一处（先参见第三条）', mp.hops[0].sentenceText.includes('先参见第三条'), mp.hops[0].sentenceText);
  }

  // 循环不导致重复搜索：一↔二，且二→三；一→三最短 2 跳；去重计数 > 0
  const cycDoc = parseDocument(`循环路径法

第一条
参见第二条。

第二条
引用第一条和第三条。

第三条
终。`).doc;
  const cycStore = new AppStore({ doc: cycDoc, confirmed: {}, annotations: [] });
  const y1 = cycDoc.root[0].id, y3 = cycDoc.root[2].id;
  const yp = findReferencePath(cycStore.getSnapshot().analysis, y1, y3);
  check('路径核对：循环图仍找到最短路径', yp.kind === 'path' && yp.hopsCount === 2, yp.kind);
  if (yp.kind === 'path') {
    check('路径核对：循环回指去重计数 ≥ 1', yp.dedupedEdges >= 1, String(yp.dedupedEdges));
  }

  // 歧义确认变化后重算：未确认歧义不成边（无路径），确认后成边（出现路径）
  const ambDoc = parseDocument(`歧义路径法

第一条
参见第二条。

第二条之一
补充规定。

第二条
内容。`).doc;
  ambDoc.root[1].suffix = '一';
  // 注意：root[1] 为「第二条之一」，root[2] 为「第二条」
  const ambStore = new AppStore({ doc: ambDoc, confirmed: {}, annotations: [] });
  const b1 = ambDoc.root[0].id, b2one = ambDoc.root[1].id;
  const ambOcc = ambStore.getSnapshot().analysis.occurrences.find((o) => o.resolution.status === 'ambiguous')!;
  check('路径核对：未确认歧义不作为边', (() => {
    const r = findReferencePath(ambStore.getSnapshot().analysis, b1, b2one);
    return r.kind === 'no-path';
  })());
  ambStore.confirmAmbiguous(ambOcc.signature, b2one);
  const after = findReferencePath(ambStore.getSnapshot().analysis, b1, b2one);
  check('路径核对：歧义确认后边出现、路径可达', after.kind === 'path' && after.hopsCount === 1, after.kind);

  // 正文变化后证据实时刷新（不展示旧偏移 / 旧句）
  const evDoc = parseDocument(`证据刷新法

第一条
引用第二条。

第二条
终。`).doc;
  const evStore = new AppStore({ doc: evDoc, confirmed: {}, annotations: [] });
  const e1 = evDoc.root[0].id, e2 = evDoc.root[1].id;
  const before = findReferencePath(evStore.getSnapshot().analysis, e1, e2);
  check('路径核对：旧证据句', before.kind === 'path' && before.hops[0].sentenceText === '引用第二条。', before.kind === 'path' ? before.hops[0].sentenceText : '');
  const evPar = evStore.getSnapshot().doc.root[0].children[0];
  evStore.updateNodeText(evPar.id, '前文补充，引用第二条办理。');
  const afterEv = findReferencePath(evStore.getSnapshot().analysis, e1, e2);
  check('路径核对：正文变化后取新句，不展示旧证据', afterEv.kind === 'path' && afterEv.hops[0].sentenceText === '前文补充，引用第二条办理。' && !afterEv.hops[0].sentenceText.startsWith('引用第二条'), afterEv.kind === 'path' ? afterEv.hops[0].sentenceText : '');
  check('路径核对：句内相对区间仍指向引用原文', afterEv.kind === 'path' && afterEv.hops[0].sentenceText.slice(afterEv.hops[0].refInSentenceStart, afterEv.hops[0].refInSentenceEnd) === '第二条');

  // 条内自指边不参与条款间路径（本条以绝对形式回指本条不产生自环边）
  const selfDoc = parseDocument(`自指路径法

第一条
本条引用第一条并参见第二条。

第二条
终。`).doc;
  const selfStore = new AppStore({ doc: selfDoc, confirmed: {}, annotations: [] });
  const sp = findReferencePath(selfStore.getSnapshot().analysis, selfDoc.root[0].id, selfDoc.root[1].id);
  check('路径核对：自指不影响到达第二条', sp.kind === 'path' && sp.hopsCount === 1, sp.kind);

  // 精确到款 / 项的目标：targetNodeId 为款/项，targetArticleId 仍为条
  const itemDoc = parseDocument(`款项路径法

第一条
引用第二条第一款。

第二条
如下：
（一）甲。
（二）乙。`).doc;
  const itemStore = new AppStore({ doc: itemDoc, confirmed: {}, annotations: [] });
  const ip = findReferencePath(itemStore.getSnapshot().analysis, itemDoc.root[0].id, itemDoc.root[1].id);
  check('路径核对：条间路径存在', ip.kind === 'path' && ip.hopsCount === 1);
  if (ip.kind === 'path') {
    check('路径核对：边目标条为第二条、目标节点精确到第一款', ip.hops[0].targetArticleId === itemDoc.root[1].id && ip.hops[0].targetNodeId === itemDoc.root[1].children[0].id);
  }

  // 纯函数：不修改传入分析
  const pureA = analyze(mkPfDoc(), { confirmed: {} });
  const pureJson = JSON.stringify(pureA);
  findReferencePath(pureA, pfDoc.root[0].id, pfDoc.root[3].id);
  check('路径核对：不修改传入分析', JSON.stringify(pureA) === pureJson);
}

// ---- 整份文档替换事务：撤销恢复替换前整套状态、重做恢复替换后整套状态；跨文档临时产物失效 ----
{
  const txTextA = `替换法甲

第一条
参见第三条。

第二条
参见第三条。`;
  const txTextB = `替换法乙

第一条【总则】
本条引用不存在的第九条，属于断链。

第二条
普通条文。`;
  const mkTxDocA = () => parseDocument(txTextA).doc;

  // —— 粘贴替换：旧留痕不随替换呈现，但撤销整套恢复 ——
  const store = new AppStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
  const docA = store.getSnapshot().doc;
  const artA1 = docA.root[0].id;
  const parA1 = docA.root[0].children[0].id;
  const brokenInA = store.getSnapshot().analysis.issues.find((i) => i.type === 'broken')!;
  // 替换前世界：签署、例外处置、快照、问题基线、批注、规则各留一份痕迹
  check('事务：替换前签署成功', store.signArticle(artA1, '甲签人').ok === true);
  check('事务：替换前接受例外成功', store.acceptIssueException(brokenInA.identity, '旧文档例外理由').ok === true);
  const snapAId = store.saveSnapshot('甲快照');
  const baseAId = store.saveIssueBaseline('甲基线');
  const annAId = store.addAnnotation(parA1, 0, 2, '甲批注');
  const ruleAId = store.addTermRule();
  store.updateTermRule(ruleAId, { canonical: '依照', variants: ['按照'] }, true);
  check('事务：替换前四套留痕齐备', (() => {
    const s = store.getSnapshot();
    return s.snapshots.length === 1 && s.issueBaselines.length === 1 &&
      s.signoffView.counts.valid === 1 && s.issueExceptions.length === 1 &&
      s.annotations.length === 1 && s.termRules.length === 1;
  })());

  store.importPastedText(txTextB);
  {
    const s = store.getSnapshot();
    check('事务：粘贴后正文为乙文档', s.doc.title === '替换法乙' && s.doc.root.length === 2, s.doc.title);
    check('事务：粘贴后四套留痕清空', s.snapshots.length === 0 && s.issueBaselines.length === 0 &&
      s.issueExceptions.length === 0 && s.signoffView.counts.total === 2 && s.signoffView.counts.unsigned === 2 &&
      s.signoffView.deleted.length === 0);
    check('事务：粘贴后批注 / 确认清空', s.annotations.length === 0 && Object.keys(s.confirmed).length === 0);
    check('事务：用户词表跨粘贴保留', s.termRules.length === 1 && s.termRules[0].id === ruleAId);
  }

  // 撤销整份替换：旧正文与同一文档的旧留痕并存，且没有乙文档留痕串入
  store.undo();
  {
    const s = store.getSnapshot();
    check('事务：撤销恢复甲正文', s.doc.title === '替换法甲' && s.doc.root[0].id === artA1, s.doc.title);
    check('事务：撤销恢复快照 / 基线', s.snapshots.some((x) => x.id === snapAId) && s.issueBaselines.some((x) => x.id === baseAId));
    check('事务：撤销恢复批注 / 规则', s.annotations.some((a) => a.id === annAId) && s.termRules.some((r) => r.id === ruleAId));
    check('事务：撤销恢复审签且按旧条文判有效', s.signoffView.counts.valid === 1 && s.signoffView.deleted.length === 0, JSON.stringify(s.signoffView.counts));
    const ev = store.getExceptionView();
    check('事务：撤销恢复例外处置记录', ev.length === 1 && ev[0].record.reason === '旧文档例外理由' && ev[0].status === 'accepted');
    check('事务：撤销后无乙文档串入的记录', s.issueExceptions.every((r) => r.identity === brokenInA.identity));
  }

  // 重做：恢复替换后整套状态（乙正文 + 乙世界留痕：全空）
  store.redo();
  {
    const s = store.getSnapshot();
    check('事务：重做恢复乙正文', s.doc.title === '替换法乙');
    check('事务：重做恢复乙世界留痕（空）', s.snapshots.length === 0 && s.issueBaselines.length === 0 &&
      s.issueExceptions.length === 0 && s.annotations.length === 0 && s.signoffView.deleted.length === 0);
    check('事务：重做后词表仍保留', s.termRules.length === 1 && s.termRules[0].id === ruleAId);
  }
  store.undo();

  // —— 替换后在乙世界新增的留痕，撤销回甲后不可见；重做回乙后原样恢复 ——
  store.redo();
  const docB = store.getSnapshot().doc;
  const artB1 = docB.root[0].id;
  const brokenInB = store.getSnapshot().analysis.issues.find((i) => i.type === 'broken')!;
  check('事务：乙世界签署成功', store.signArticle(artB1, '乙签人').ok === true);
  check('事务：乙世界接受例外成功', store.acceptIssueException(brokenInB.identity, '新文档例外理由').ok === true);
  const snapBId = store.saveSnapshot('乙快照');
  store.undo();
  {
    const s = store.getSnapshot();
    check('事务：撤销回甲后乙世界新增留痕不可见', s.doc.title === '替换法甲' &&
      !s.snapshots.some((x) => x.id === snapBId) &&
      !s.issueExceptions.some((r) => r.reason === '新文档例外理由') &&
      s.signoffView.counts.total === 2 && s.signoffView.counts.valid === 1, JSON.stringify(s.signoffView.counts));
    check('事务：甲世界原有留痕仍在', s.snapshots.some((x) => x.id === snapAId) &&
      s.issueExceptions.some((r) => r.reason === '旧文档例外理由'));
  }
  store.redo();
  {
    const s = store.getSnapshot();
    check('事务：重做回乙后乙世界新增留痕恢复', s.doc.title === '替换法乙' &&
      s.snapshots.some((x) => x.id === snapBId) &&
      s.issueExceptions.some((r) => r.reason === '新文档例外理由') &&
      s.signoffView.counts.valid === 1);
    check('事务：重做回乙后甲留痕不串入', !s.snapshots.some((x) => x.id === snapAId) &&
      !s.issueExceptions.some((r) => r.reason === '旧文档例外理由'));
  }

  // —— JSON 导入：导入包整套状态随事务切换，撤销恢复导入前状态 ——
  const bundle = store.exportJson();
  const imp = new AppStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
  const impArt1 = imp.getSnapshot().doc.root[0].id;
  check('事务：导入前签署一份', imp.signArticle(impArt1, '导入前签人').ok === true);
  imp.importJson(bundle);
  {
    const s = imp.getSnapshot();
    check('事务：JSON 导入后为乙正文', s.doc.title === '替换法乙');
    check('事务：JSON 导入恢复包内审签', s.signoffView.counts.valid === 1 && s.signoffView.entries[0].signoff?.signer === '乙签人');
    check('事务：JSON 导入恢复包内快照 / 例外 / 批注', s.snapshots.some((x) => x.id === snapBId) &&
      s.issueExceptions.some((r) => r.reason === '新文档例外理由'));
  }
  imp.undo();
  {
    const s = imp.getSnapshot();
    check('事务：撤销 JSON 导入恢复导入前正文', s.doc.title === '替换法甲' && s.doc.root[0].id === impArt1, s.doc.title);
    check('事务：撤销 JSON 导入恢复导入前审签', s.signoffView.counts.valid === 1 &&
      s.signoffView.entries[0].signoff?.signer === '导入前签人', JSON.stringify(s.signoffView.entries.map((e) => e.signoff?.signer)));
    check('事务：撤销导入后包内留痕不串入', !s.snapshots.some((x) => x.id === snapBId) &&
      !s.issueExceptions.some((r) => r.reason === '新文档例外理由'));
  }
  imp.redo();
  check('事务：重做 JSON 导入再次恢复包内状态', imp.getSnapshot().doc.title === '替换法乙' &&
    imp.getSnapshot().signoffView.entries[0].signoff?.signer === '乙签人');

  // —— 导出包内快照为只读冻结对象，再次导入不得因规范化写 ordinal 而报错 ——
  {
    const frozenBundle = store.exportJson();
    check('事务：导出包快照已冻结', Object.isFrozen(frozenBundle.snapshots![0].doc.root[0]));
    const reimp = new AppStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
    let importOk = true;
    try {
      reimp.importJson(frozenBundle);
    } catch {
      importOk = false;
    }
    check('事务：冻结快照往返导入不报错且可撤销', importOk && reimp.getSnapshot().doc.title === '替换法乙');
    reimp.undo();
    check('事务：冻结快照导入事务可撤销回原文档', reimp.getSnapshot().doc.title === '替换法甲');
  }

  // —— 载入示例：同样为单步事务，且旧预演 / 阅读包失效 ——
  imp.replaceWithSample(sampleDocument());
  check('事务：载入示例后为示例文档', imp.getSnapshot().doc.root.length > 2);
  check('事务：载入示例留痕清空', imp.getSnapshot().snapshots.length === 0 &&
    imp.getSnapshot().issueExceptions.length === 0 && imp.getSnapshot().signoffView.deleted.length === 0);
  imp.undo();
  check('事务：撤销示例恢复导入的乙文档与留痕', imp.getSnapshot().doc.title === '替换法乙' &&
    imp.getSnapshot().issueExceptions.some((r) => r.reason === '新文档例外理由'));
  imp.redo();
  check('事务：重做示例恢复示例文档', imp.getSnapshot().doc.title === sampleDocument().title);
  imp.undo();

  // —— 跨文档撤销 / 重做：旧修订预演与引用阅读包失效，不能应用或复制 ——
  const epStore = new AppStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
  epStore.importPastedText(txTextB);
  const epArt1 = epStore.getSnapshot().doc.root[0].id;
  check('事务：乙文档生成预演成功', epStore.runSandboxPreview({ kind: 'delete', articleId: epArt1 }).ok === true);
  check('事务：乙文档生成阅读包成功', epStore.generateReadingPack(epArt1).ok === true);
  epStore.undo();
  check('事务：跨文档撤销后预演失效清空', epStore.getSnapshot().sandbox === null);
  check('事务：跨文档撤销后阅读包失效清空', epStore.getSnapshot().readingPack === null);
  check('事务：跨文档撤销后禁止应用旧预演', epStore.applySandboxPreview() === false);
  epStore.redo();
  check('事务：跨文档重做后旧预演仍不可用', epStore.getSnapshot().sandbox === null &&
    epStore.applySandboxPreview() === false);
  check('事务：跨文档重做后旧阅读包不可复制', epStore.getSnapshot().readingPack === null);

  // —— 替换后的普通编辑仍按现有粒度撤销（一次编辑一步，不跨文档）——
  const grStore = new AppStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
  grStore.importPastedText(txTextB);
  const grArt2 = grStore.getSnapshot().doc.root[1].id;
  const grParId = grStore.getSnapshot().doc.root[1].children[0].id;
  const grBefore = grStore.getSnapshot().doc.root[1].children[0].text;
  grStore.updateNodeText(grParId, '替换后新增的正文。');
  grStore.updateNodeText(grArt2, '结构无关编辑。');
  grStore.undo();
  check('事务：替换后编辑按粒度撤销（仅撤销第二步编辑）',
    grStore.getSnapshot().doc.root[1].children[0].text === '替换后新增的正文。' &&
    grStore.getSnapshot().doc.title === '替换法乙');
  grStore.undo();
  check('事务：再次撤销回到刚替换状态（仍是乙文档）',
    grStore.getSnapshot().doc.root[1].children[0].text === grBefore &&
    grStore.getSnapshot().doc.title === '替换法乙');
  grStore.undo();
  check('事务：第三次撤销才跨过事务恢复甲文档', grStore.getSnapshot().doc.title === '替换法甲');

  // —— 持久化与 JSON 导出始终反映当前一致状态 ——
  const psStore = new AppStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
  const psArt1 = psStore.getSnapshot().doc.root[0].id;
  check('事务：甲世界签署', psStore.signArticle(psArt1, '持久签人').ok === true);
  psStore.importPastedText(txTextB);
  {
    const ex = psStore.exportJson();
    check('事务：导出始终反映替换后状态（无甲留痕）', ex.document.title === '替换法乙' &&
      (ex.signoffs ?? []).length === 0 && (ex.issueExceptions ?? []).length === 0 &&
      (ex.snapshots ?? []).length === 0);
  }
  psStore.undo();
  {
    const ex = psStore.exportJson();
    check('事务：撤销后导出恢复甲状态', ex.document.title === '替换法甲' &&
      (ex.signoffs ?? []).some((r) => r.signer === '持久签人'));
  }

  // —— localStorage 持久化：撤销 / 重做后自动保存的状态可原样重载，历史不留存旧世界串味 ——
  {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    } as Storage;
    // 动态加载使模块内 localStorage 引用拿到上面的 mock
    const { AppStore: LSStore } = await import('../src/lib/store');
    const { localStore } = await import('../src/lib/storage');
    const ls = new LSStore({ doc: mkTxDocA(), confirmed: {}, annotations: [] });
    const lsArt = ls.getSnapshot().doc.root[0].id;
    ls.signArticle(lsArt, '本地签人');
    ls.importPastedText(txTextB);
    const savedB = localStore.load()!;
    check('事务：替换后本地保存为乙文档且无甲留痕', savedB.doc.title === '替换法乙' &&
      (savedB.signoffs ?? []).length === 0);
    ls.undo();
    const savedA = localStore.load()!;
    check('事务：撤销后本地保存恢复甲文档与审签', savedA.doc.title === '替换法甲' &&
      (savedA.signoffs ?? []).some((r) => r.signer === '本地签人') &&
      (savedA.issueExceptions ?? []).length === 0);
    // 从保存状态重载：新 store 干净一致（历史本身不持久化）
    const reloaded = new LSStore(savedA);
    const rs = reloaded.getSnapshot();
    check('事务：重载后正文与留痕一致', rs.doc.title === '替换法甲' &&
      rs.signoffView.counts.valid === 1 && rs.canUndo === false);
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

// ---- JSON 导入全树校验：条→款→项层级、必需字段、全树 ID 唯一；不合格整次拒绝且现状不变 ----
{
  const mkNode = (
    id: string,
    kind: 'article' | 'paragraph' | 'item',
    children: unknown[] = [],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ id, kind, ordinal: 1, text: '', children, ...extra });

  // —— 合法形态 ——
  check('校验：空 root 合法', validateClauseDocument({ id: 'd', title: '空', root: [] }).ok === true);
  const validTree = [
    mkNode('art1', 'article', [
      mkNode('par1', 'paragraph', [mkNode('itm1', 'item', [])]),
      mkNode('par2', 'paragraph', []),
    ]),
  ];
  {
    const r = validateClauseDocument({ id: 'd', title: '合法', root: validTree });
    check('校验：条款项三层合法', r.ok === true, r.errors.join('；'));
    check('校验：rootCount 统计正确', r.rootCount === 1);
  }

  // —— 缺少 root / root 非数组 ——
  check(
    '校验：缺少 document.root',
    validateClauseDocument({ title: 'x' }).errors[0] === 'MISSING_ROOT',
  );
  check(
    '校验：root 非数组',
    validateClauseDocument({ root: {} }).errors[0] === 'MISSING_ROOT',
  );

  // —— 层级错误 ——
  {
    const itemAtTop = [mkNode('itmX', 'item', [])];
    const r = validateClauseDocument({ root: itemAtTop });
    check('校验：顶层必须为条（item 拒绝）', !r.ok && r.errors.some((e) => e.includes('层级不合法')));
  }
  {
    const itemChild = [mkNode('art1', 'article', [mkNode('itmX', 'item', [])])];
    const r = validateClauseDocument({ root: itemChild });
    check('校验：条下必须为款（item 拒绝）', !r.ok && r.errors.some((e) => e.includes('层级不合法')));
  }
  {
    const deep = [
      mkNode('art1', 'article', [
        mkNode('par1', 'paragraph', [
          mkNode('itm1', 'item', [mkNode('nested', 'item', [])]),
        ]),
      ]),
    ];
    const r = validateClauseDocument({ root: deep });
    check('校验：项下不可再嵌套', !r.ok && r.errors.some((e) => e.includes('项节点不可再包含子节点')));
  }
  {
    const badKind = [{ id: 'x', kind: 'chapter', ordinal: 1, text: '', children: [] }];
    const r = validateClauseDocument({ root: badKind });
    check('校验：kind 取值非法', !r.ok && r.errors.some((e) => e.includes('kind 必须是')));
    check('校验：错误信息含结构路径', r.errors.some((e) => e.includes('第 1 条')));
  }

  // —— 必需字段缺失（修复“子节点缺 children 抛错”）——
  for (const field of ['id', 'ordinal', 'text', 'children', 'kind']) {
    const node = mkNode('art1', 'article', []);
    delete node[field];
    const r = validateClauseDocument({ root: [node] });
    check(
      `校验：缺少必需字段 ${field} 被拒绝且不抛错`,
      !r.ok && r.errors.some((e) => e.includes(field)),
      r.errors.join('；'),
    );
  }
  {
    const noChildrenChild = [
      {
        id: 'art1',
        kind: 'article',
        ordinal: 1,
        text: '',
        children: [{ id: 'par1', kind: 'paragraph', ordinal: 1, text: '' }],
      },
    ];
    let threw = false;
    let r;
    try {
      r = validateClauseDocument({ root: noChildrenChild });
    } catch {
      threw = true;
    }
    check('校验：子节点缺 children 不再抛错而是报告原因', !threw && r && !r.ok && r.errors.some((e) => e.includes('children')));
  }

  // —— 全树 ID 唯一（修复分析索引覆盖、引用/审签关联错误）——
  {
    const dup = [
      mkNode('dup', 'article', []),
      mkNode('art2', 'article', [
        mkNode('dup', 'paragraph', []),
      ]),
    ];
    const r = validateClauseDocument({ root: dup });
    check('校验：跨层重复 ID 拒绝', !r.ok && r.errors.some((e) => e.includes('重复')));
    check('校验：重复 ID 报错给出两个位置', (r.errors.find((e) => e.includes('重复'))?.match(/第 \d+ 条/g) ?? []).length >= 1);
  }
  {
    const dupInner = [
      mkNode('art1', 'article', [
        mkNode('par1', 'paragraph', [mkNode('same', 'item'), mkNode('same2', 'item')]),
        mkNode('par2', 'paragraph', [mkNode('same', 'item')]),
      ]),
    ];
    const r = validateClauseDocument({ root: dupInner });
    check('校验：项级重复 ID 拒绝且路径定位到款项', !r.ok &&
      r.errors.some((e) => e.includes('重复') && e.includes('款') && e.includes('项')));
  }

  // —— 可选字段类型 ——
  check(
    '校验：title 非字符串拒绝',
    !validateClauseDocument({ title: 123, root: [] }).ok,
  );
  {
    const r = validateClauseDocument({
      root: [mkNode('art1', 'article', [], { title: 99 })],
    });
    check('校验：节点 title 非字符串拒绝', !r.ok && r.errors.some((e) => e.includes('title')));
  }

  // —— 包形态：document / doc 均可识别 ——
  check('校验：ExportBundle 形态（document）', validateImportBundle({
    app: 'clause-reference-validator',
    version: 1,
    document: { id: 'd', title: 't', root: [] },
    confirmed: {},
  }).validation.ok);
  check('校验：PersistedState 形态（doc）', validateImportBundle({
    doc: { id: 'd', title: 't', root: [] },
    confirmed: {},
  }).validation.ok);
  check('校验：非对象内容拒绝', !validateImportBundle(null).validation.ok);
  check('校验：无 document/doc 拒绝', !validateImportBundle({ foo: 1 }).validation.ok);
  check(
    '校验：持久化状态守卫——confirmed 非对象拒绝',
    isValidPersistedState({ doc: { id: 'd', title: 't', root: [] } }) === false &&
      isValidPersistedState({ doc: { id: 'd', title: 't', root: [] }, confirmed: [] }) === false,
  );
  check(
    '校验：持久化状态守卫——坏树拒绝',
    isValidPersistedState({ doc: { title: 't', root: [{ id: 'a' }] }, confirmed: {} }) === false,
  );
  check(
    '校验：持久化状态守卫——合法通过',
    isValidPersistedState({ doc: { id: 'd', title: 't', root: [] }, confirmed: {} }) === true,
  );
}

// ---- importJson：失败时正文/留痕/撤销历史原样保留；成功时保留节点 ID 与附属记录 ----
{
  const impTextA = `导入法甲

第一条
参见第三条。

第二条
参见第三条。`;
  const impTextB = `导入法乙

第一条【总则】
普通条文。`;
  const mkDocA = () => parseDocument(impTextA).doc;

  const base = new AppStore({ doc: mkDocA(), confirmed: {}, annotations: [] });
  const beforeTitle = base.getSnapshot().doc.title;
  const beforeArtId = base.getSnapshot().doc.root[0].id;
  base.signArticle(beforeArtId, '失败前签人');
  const snapshotCountBefore = 0;

  // 非法包：重复 ID
  const badBundle = {
    document: {
      id: 'dBad',
      title: '坏文档',
      root: [
        { id: 'dup', kind: 'article', ordinal: 1, text: '', children: [] },
        {
          id: 'art2',
          kind: 'article',
          ordinal: 2,
          text: '',
          children: [{ id: 'dup', kind: 'paragraph', ordinal: 1, text: '', children: [] }],
        },
      ],
    },
    confirmed: {},
  };
  const res = base.importJson(badBundle);
  check('导入：非法包返回失败与原因', res.ok === false && res.errors.some((e) => e.includes('重复')));
  check('导入：失败后正文保持原状', base.getSnapshot().doc.title === beforeTitle &&
    base.getSnapshot().doc.root[0].id === beforeArtId);
  check('导入：失败后审签留痕保持原状', base.getSnapshot().signoffView.counts.valid === 1);
  check('导入：失败后撤销历史不新增（undo 无效）', base.getSnapshot().canUndo === false);
  check('导入：失败不产生新世界（仍在原世界）', base.getSnapshot().snapshots.length === snapshotCountBefore);

  // 非法包：缺 children（旧实现会抛错）
  let threw = false;
  let res2;
  try {
    res2 = base.importJson({
      document: {
        id: 'dBad2',
        title: '坏文档2',
        root: [{ id: 'a1', kind: 'article', ordinal: 1, text: '', children: [
          { id: 'p1', kind: 'paragraph', ordinal: 1, text: '' },
        ] }],
      },
      confirmed: {},
    });
  } catch {
    threw = true;
  }
  check('导入：缺 children 不抛错且返回原因', !threw && res2 && res2.ok === false &&
    res2.errors.some((e) => e.includes('children')));
  check('导入：第二次失败后正文仍原状', base.getSnapshot().doc.root[0].id === beforeArtId);

  // 合法包：空 root 可导入，为一步可撤销事务
  const emptyRes = base.importJson({
    document: { id: 'dEmpty', title: '空文档', root: [] },
    confirmed: {},
  });
  check('导入：空 root 合法导入', emptyRes.ok === true &&
    base.getSnapshot().doc.title === '空文档' && base.getSnapshot().doc.root.length === 0);
  base.undo();
  check('导入：空 root 导入可撤销回原状', base.getSnapshot().doc.root[0].id === beforeArtId &&
    base.getSnapshot().signoffView.counts.valid === 1);
  base.redo();

  // 合法包：保留节点 ID 与附属记录，引用 / 审签仍关联原节点
  const goodDoc = parseDocument(impTextA).doc;
  const artAId = goodDoc.root[0].id;
  const good = new AppStore({ doc: goodDoc, confirmed: {}, annotations: [] });
  // 对第一条签署后导出（走真实导出形态，含冻结快照）
  check('导入：签署成功', good.signArticle(artAId, '原签人').ok === true);
  const exported = good.exportJson();

  const target = new AppStore({ doc: parseDocument(impTextB).doc, confirmed: {}, annotations: [] });
  const okRes = target.importJson(exported);
  check('导入：合法导出包导入成功', okRes.ok === true);
  {
    const s = target.getSnapshot();
    check('导入：节点 ID 原样保留', s.doc.root[0].id === artAId, s.doc.root[0].id);
    check('导入：审签按原节点 ID 关联且有效', s.signoffView.counts.valid === 1 &&
      s.signoffView.entries[0].articleId === artAId);
    // 引用仍解析到原节点
    const art2 = s.doc.root[1];
    const occ = s.analysis.byNode[art2.children[0]?.id ?? art2.id] ?? [];
    check('导入：分析索引以原 ID 建表无覆盖', Object.keys(s.analysis.nodes).length ===
      countImportedNodes(s.doc.root));
    void occ;
  }

  // 冻结对象（导出包内快照）往返导入不报错，且入参树不被就地改写
  const frozenBundle = good.exportJson();
  const frozenRoot = frozenBundle.document.root;
  const reimp = new AppStore({ doc: parseDocument(impTextB).doc, confirmed: {}, annotations: [] });
  let frozenThrew = false;
  try {
    reimp.importJson(frozenBundle);
  } catch {
    frozenThrew = true;
  }
  check('导入：冻结导出包导入不抛错', frozenThrew === false);
  check('导入：入参树 ordinal 未被就地改写', frozenRoot[0].ordinal === good.getSnapshot().doc.root[0].ordinal);
}

function countImportedNodes(nodes: { children?: unknown[] }[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (Array.isArray(node.children)) n += countImportedNodes(node.children as { children?: unknown[] }[]);
  }
  return n;
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);