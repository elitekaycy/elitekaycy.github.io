/**
 * Turns GitHub-style alert blockquotes into callouts.
 *
 *   > [!WARNING]
 *   > Spread-aware rules never fire on bar data.
 *
 * becomes a labelled `.callout.callout--warning` block. Four kinds only —
 * note, tip, warning, danger — because past four or five readers stop
 * distinguishing them and the label loses its job. A blockquote without a
 * marker is left alone: a quotation and an editorial aside are different
 * things and must not share styling.
 */
import { visit } from 'unist-util-visit';

const KINDS = new Set(['note', 'tip', 'warning', 'danger']);
const MARKER = /^\[!(note|tip|warning|danger)\]\s*/i;

export default function rehypeCallouts() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'blockquote') return;

      // The marker lives in the first text node of the first paragraph.
      const firstPara = node.children.find(
        (c) => c.type === 'element' && c.tagName === 'p'
      );
      if (!firstPara) return;

      const firstText = firstPara.children.find((c) => c.type === 'text');
      if (!firstText) return;

      const match = MARKER.exec(firstText.value);
      if (!match) return;

      const kind = match[1].toLowerCase();
      if (!KINDS.has(kind)) return;

      // Strip the marker itself, plus the newline markdown leaves behind.
      firstText.value = firstText.value.replace(MARKER, '').replace(/^\n/, '');
      if (firstText.value === '') {
        firstPara.children = firstPara.children.filter((c) => c !== firstText);
      }

      node.tagName = 'div';
      node.properties = { className: ['callout', `callout--${kind}`] };
      node.children.unshift({
        type: 'element',
        tagName: 'span',
        properties: { className: ['callout__label'] },
        children: [{ type: 'text', value: kind }],
      });
    });
  };
}
