import type { ClauseDocument, ClauseNode, NodeKind } from '../../shared/model';
import { uid } from './uid';

/** 深拷贝节点（重新生成 id 仅在显式复制时使用） */
export function cloneTree(nodes: ClauseNode[]): ClauseNode[] {
  return nodes.map((n) => ({
    ...n,
    title: n.title,
    suffix: n.suffix,
    text: n.text,
    children: cloneTree(n.children),
  }));
}

export function findNode(
  root: ClauseNode[],
  id: string,
): { node: ClauseNode; parent: ClauseNode[]; index: number } | null {
  for (let i = 0; i < root.length; i++) {
    if (root[i].id === id) return { node: root[i], parent: root, index: i };
    const inner = findInNode(root[i], id);
    if (inner) return inner;
  }
  return null;
}

function findInNode(
  parent: ClauseNode,
  id: string,
): { node: ClauseNode; parent: ClauseNode[]; index: number } | null {
  for (let i = 0; i < parent.children.length; i++) {
    if (parent.children[i].id === id) {
      return { node: parent.children[i], parent: parent.children, index: i };
    }
    const deeper = findInNode(parent.children[i], id);
    if (deeper) return deeper;
  }
  return null;
}

export function findArticleOf(root: ClauseNode[], id: string): ClauseNode | null {
  for (const a of root) {
    if (a.id === id) return a;
    if (findNode(a.children, id)) return a;
  }
  return null;
}

export function renumberAll(root: ClauseNode[]): void {
  root.forEach((article, ai) => {
    article.ordinal = ai + 1;
    article.children.forEach((paragraph, pi) => {
      paragraph.ordinal = pi + 1;
      paragraph.children.forEach((item, ii) => {
        item.ordinal = ii + 1;
      });
    });
  });
}

export function newArticle(text = '', title?: string): ClauseNode {
  return { id: uid('art'), kind: 'article', ordinal: 0, ...(title ? { title } : {}), text, children: [] };
}

export function newParagraph(text = ''): ClauseNode {
  return { id: uid('par'), kind: 'paragraph', ordinal: 0, text, children: [] };
}

export function newItem(text = ''): ClauseNode {
  return { id: uid('itm'), kind: 'item', ordinal: 0, text, children: [] };
}

export function nodeKindOf(node: ClauseNode): NodeKind {
  return node.kind;
}

export function touch(doc: ClauseDocument): ClauseDocument {
  return { ...doc, updatedAt: Date.now() };
}
