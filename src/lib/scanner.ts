import type { RefSpan, NumStyle, ArticleRefMember } from '../../shared/model';
import { parseOrdinal } from './numeral';

const NUM = '0-9０-９零一二三四五六七八九十百千万两〇'; // 〇(U+3007) 放在末尾，避免被当作字符范围端点
const N = `[${NUM}]`;
const G = '[\\s　]*';

/** 项的两种写法拆成两个独立可选组：第M项 / （M），避免二选一组导致回溯失效 */
function itemAbs(p: string): string {
  return (
    `(?:${G}第(?<${p}Item>${N}+)${G}项)?` +
    `(?:${G}(?<${p}ItemP>第?（(?<${p}ItemPn>${N}+)）项?))?`
  );
}

/** 组合/区间末尾不得紧跟款、项编号（如“第三条、第五条第二款”不成组合，各自回退为绝对引用） */
const NOT_PAR_ITEM = `(?!${G}第${N}+${G}款)(?!${G}第${N}+${G}项)(?!${G}（${N}+）)`;

/**
 * 总正则按优先级排列：
 * 条级组合 → 条级闭区间 → 绝对引用 → 本条链 → 前/后条链 → 前款 → 前项/本项/本款 → 裸（X）
 */
const REF_SOURCE =
  // 0a) 条级组合：第X条[之Y]（、/及/和/与 第X条[之Y]）一次以上；暂不解析组合中的款、项
  `(?<alist>第${N}+${G}条(?:${G}之${G}${N}+)?` +
  `(?:${G}[、及和与]${G}第${N}+${G}条(?:${G}之${G}${N}+)?)+)` +
  NOT_PAR_ITEM +
  `(?!${G}至${G}第)` + // “第三条、第五条至第七条”保持区间完整，不成组合
  `|` +
  // 0b) 条级闭区间：第X条[之Y]至第Y条[之Z]
  `第(?<rStart>${N}+)${G}条` +
  `(?:${G}之${G}(?<rStartSuf>${N}+))?` +
  `${G}至${G}第(?<rEnd>${N}+)${G}条` +
  `(?:${G}之${G}(?<rEndSuf>${N}+))?` +
  NOT_PAR_ITEM +
  `|` +
  // 1) 第X条[之Y][【条名】][第N款][第M项/（M）]
  `第(?<aNum>${N}+)${G}条` +
  `(?:${G}之${G}(?<aSuf>${N}+))?` +
  `(?:${G}[【\\[](?<aName>[^】\\]]+)[】\\]])?` +
  `(?:${G}第(?<aPar>${N}+)${G}款)?` +
  itemAbs('a') +
  `|` +
  // 2) 本条[第N款][第M项/（M）]
  `本条(?:${G}第(?<tPar>${N}+)${G}款)?` +
  itemAbs('t') +
  `|` +
  // 3) 前条/上条/后条/下条（可叠用，如“后后条”）
  `(?<chain>(?:前|上|后|下)条|(?:[前上后下]){2,}?条)` +
  `(?:${G}第(?<cPar>${N}+)${G}款)?` +
  itemAbs('c') +
  `|` +
  // 4) 前款[第M项/（M）]
  `前款` +
  itemAbs('pp') +
  `|` +
  // 5) 前项 / 本项 / 本款[第M项]
  `前项|本项|本款(?:${G}第(?<tpItem>${N}+)${G}项)?` +
  `|` +
  // 6) 裸（X）
  `（(?<bItem>${N}+)）`;

interface Pn {
  value: number;
  style: NumStyle;
}

function pickNum(g: RegExpNamedGroups, ...keys: string[]): Pn | null {
  for (const k of keys) {
    const raw = g[k];
    if (raw !== undefined) {
      const parsed = parseOrdinal(raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

type RegExpNamedGroups = Record<string, string | undefined>;

const SUFFIX_WORDS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function suffixWord(value: number): string {
  return SUFFIX_WORDS[value - 1] ?? String(value);
}

/** 从组合引用原文中逐个提取条级成员（书写顺序；命名组无法重复捕获，故二次解析） */
const LIST_MEMBER_RE = new RegExp(`第(${N}+)${G}条(?:${G}之${G}(${N}+))?`, 'gu');

function parseListMembers(raw: string): ArticleRefMember[] {
  const members: ArticleRefMember[] = [];
  LIST_MEMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIST_MEMBER_RE.exec(raw)) !== null) {
    const num = parseOrdinal(m[1]);
    if (!num) continue;
    const suf = m[2] !== undefined ? parseOrdinal(m[2]) : null;
    members.push({
      num: num.value,
      style: num.style,
      ...(suf ? { suffix: suffixWord(suf.value) } : {}),
    });
  }
  return members;
}

/** 扫描一段正文中的全部交叉引用 span（按起始位置升序、互不嵌套） */
export function scanReferences(text: string): RefSpan[] {
  const re = new RegExp(REF_SOURCE, 'gu');
  const spans: RefSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) continue;
    const g: RegExpNamedGroups = m.groups ?? {};
    const head = m[0];
    let span: RefSpan | null = null;

    if (g['alist'] !== undefined) {
      const members = parseListMembers(g['alist']!);
      if (members.length < 2) continue;
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'articleList',
        members,
        // 兼容字段：首成员的条号与风格
        articleNum: members[0].num,
        articleStyle: members[0].style,
        ...(members[0].suffix ? { articleSuffix: members[0].suffix } : {}),
      };
    } else if (g['rStart'] !== undefined) {
      const s = parseOrdinal(g['rStart']!);
      const e = parseOrdinal(g['rEnd']!);
      if (!s || !e) continue;
      const sSuf = g['rStartSuf'] !== undefined ? parseOrdinal(g['rStartSuf']!) : null;
      const eSuf = g['rEndSuf'] !== undefined ? parseOrdinal(g['rEndSuf']!) : null;
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'articleRange',
        articleNum: s.value,
        articleStyle: s.style,
        ...(sSuf ? { articleSuffix: suffixWord(sSuf.value) } : {}),
        rangeEndNum: e.value,
        rangeEndStyle: e.style,
        ...(eSuf ? { rangeEndSuffix: suffixWord(eSuf.value) } : {}),
      };
    } else if (g['aNum'] !== undefined) {
      const a = parseOrdinal(g['aNum']!);
      if (!a) continue;
      const suf = g['aSuf'] !== undefined ? parseOrdinal(g['aSuf']!) : null;
      const p = pickNum(g, 'aPar');
      const it = pickNum(g, 'aItem', 'aItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'absolute',
        articleNum: a.value,
        articleStyle: a.style,
        ...(suf ? { articleSuffix: suffixWord(suf.value) } : {}),
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['aItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('本条')) {
      const p = pickNum(g, 'tPar');
      const it = pickNum(g, 'tItem', 'tItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'this',
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['tItemP'] !== undefined } : {}),
      };
    } else if (g['chain'] !== undefined) {
      const chain = g['chain']!;
      const first = chain[0];
      const dir = first === '前' || first === '上' ? -1 : 1;
      const p = pickNum(g, 'cPar');
      const it = pickNum(g, 'cItem', 'cItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: dir === -1 ? 'prevArticle' : 'nextArticle',
        articleNum: chain.length - 1,
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['cItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('前款')) {
      const it = pickNum(g, 'ppItem', 'ppItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'prevParagraph',
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['ppItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('前项')) {
      span = { start: m.index, end: m.index + head.length, raw: head, kind: 'prevItem' };
    } else if (head.startsWith('本项')) {
      span = { start: m.index, end: m.index + head.length, raw: head, kind: 'thisItem' };
    } else if (head.startsWith('本款')) {
      const it = pickNum(g, 'tpItem');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'thisParagraph',
        ...(it ? { itemNum: it.value, itemStyle: it.style } : {}),
      };
    } else if (g['bItem'] !== undefined) {
      const it = parseOrdinal(g['bItem']!);
      if (it) {
        span = {
          start: m.index,
          end: m.index + head.length,
          raw: head,
          kind: 'bareItem',
          itemNum: it.value,
          itemStyle: it.style,
          itemParenForm: true,
        };
      }
    }

    if (span) {
      const covered = spans.some((s) => span!.start >= s.start && span!.end <= s.end);
      if (!covered) spans.push(span);
    }
  }
  return spans;
}
