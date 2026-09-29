import type { ClauseDocument, ClauseNode } from '../../shared/model';
import { parseOrdinal } from './numeral';
import { uid } from './uid';

const NUM = '0-9０-９零〇一二三四五六七八九十百千万两';

const ARTICLE_RE = new RegExp(
  `^[\\s　]*第[\\s　]*([${NUM}]+)[\\s　]*条` +
    `(?:[\\s　]*之[\\s　]*([${NUM}]+))?` +
    `(?:[\\s　]*[【\\[]([^】\\]]+)[】\\]])?` +
    `[\\s　]*(.*)$`,
  'u',
);

// （一） (一) 【一】 [一] 一、 1. １．
const ITEM_RE = new RegExp(
  `^[\\s　]*(?:` +
    `（([${NUM}]+)）|` +
    `\\(([${NUM}]+)\\)|` +
    `【([${NUM}]+)】|` +
    `\\[([${NUM}]+)\\]|` +
    `([${NUM}]+)[、.．]` +
    `)[\\s　]*(.*)$`,
  'u',
);

const TERMINATOR_RE = /[。！？；;…」』）)]\s*$/;

function newNode(
  kind: ClauseNode['kind'],
  text: string,
  title?: string,
  suffix?: string,
): ClauseNode {
  return {
    id: uid(kind === 'article' ? 'art' : kind === 'paragraph' ? 'par' : 'itm'),
    kind,
    ordinal: 0,
    ...(suffix ? { suffix } : {}),
    ...(title ? { title } : {}),
    text,
    children: [],
  };
}

export interface ParseResult {
  doc: ClauseDocument;
  ignoredLeadingLines: number;
}

/** 将粘贴的纯文本解析为 条 → 款 → 项 层级 */
export function parseDocument(raw: string, existingTitle = '未命名条款集'): ParseResult {
  const lines = raw.split(/\r?\n/);
  const root: ClauseNode[] = [];
  let title = '';
  let ignoredLeadingLines = 0;

  let article: ClauseNode | null = null;
  let paragraph: ClauseNode | null = null;
  let item: ClauseNode | null = null;
  let pendingBlank = false;
  let seenArticle = false;

  const ensureParagraph = (headText = ''): ClauseNode => {
    if (!paragraph) {
      paragraph = newNode('paragraph', headText);
      article!.children.push(paragraph);
    }
    return paragraph;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      pendingBlank = true;
      continue;
    }

    const am = line.match(ARTICLE_RE);
    if (am && parseOrdinal(am[1])) {
      seenArticle = true;
      const suffix = am[2] && parseOrdinal(am[2]) ? formatSuffix(am[2]) : undefined;
      article = newNode('article', '', am[3]?.trim() || undefined, suffix);
      // 保留原文中的显式条号（支持“之一”后缀与跳号）；位置规范化交由 renumber 在需要时处理
      article.ordinal = parseOrdinal(am[1])!.value;
      root.push(article);
      paragraph = null;
      item = null;
      pendingBlank = false;
      const rest = am[4].trim();
      if (rest) ensureParagraph(rest);
      continue;
    }

    if (!seenArticle) {
      if (!title) title = line;
      else ignoredLeadingLines += 1;
      continue;
    }

    const im = line.match(ITEM_RE);
    if (im) {
      const numStr = im[1] ?? im[2] ?? im[3] ?? im[4] ?? im[5];
      if (parseOrdinal(numStr)) {
        ensureParagraph();
        item = newNode('item', im[6].trim());
        paragraph!.children.push(item);
        pendingBlank = false;
        continue;
      }
    }

    // 普通行：尽量续接到尚未结束的句段，否则开启新的一款
    if (
      item &&
      !pendingBlank &&
      item.text.length > 0 &&
      !TERMINATOR_RE.test(item.text)
    ) {
      item.text += item.text.endsWith('\n') ? line : '\n' + line;
      continue;
    }
    if (
      paragraph &&
      !pendingBlank &&
      item === null &&
      paragraph.text.length > 0 &&
      !TERMINATOR_RE.test(paragraph.text)
    ) {
      paragraph.text += paragraph.text.endsWith('\n') ? line : '\n' + line;
      continue;
    }

    paragraph = newNode('paragraph', line);
    article!.children.push(paragraph);
    item = null;
    pendingBlank = false;
  }

  // 款、项始终按位置编号；条保留解析出的显式 ordinal（支持“之一”与跳号）
  root.forEach((article) => {
    article.children.forEach((paragraph, pi) => {
      paragraph.ordinal = pi + 1;
      paragraph.children.forEach((itemNode, ii) => {
        itemNode.ordinal = ii + 1;
      });
    });
  });

  return {
    doc: {
      id: uid('doc'),
      title: title || existingTitle,
      root,
      updatedAt: Date.now(),
    },
    ignoredLeadingLines,
  };
}

function formatSuffix(raw: string): string {
  const parsed = parseOrdinal(raw);
  return parsed ? ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][parsed.value - 1] ?? raw : raw;
}

/** 收集文档内全部节点（深度优先） */
export function walkNodes(
  root: ClauseNode[],
  cb: (node: ClauseNode, parents: { article?: ClauseNode; paragraph?: ClauseNode }) => void,
): void {
  for (const article of root) {
    if (article.text) cb(article, { article });
    for (const paragraph of article.children) {
      cb(paragraph, { article });
      for (const item of paragraph.children) {
        cb(item, { article, paragraph });
      }
    }
  }
}

export function countNodes(doc: ClauseDocument): {
  articles: number;
  paragraphs: number;
  items: number;
} {
  let paragraphs = 0;
  let items = 0;
  walkNodes(doc.root, (n) => {
    if (n.kind === 'paragraph') paragraphs += 1;
    if (n.kind === 'item') items += 1;
  });
  return { articles: doc.root.length, paragraphs, items };
}
