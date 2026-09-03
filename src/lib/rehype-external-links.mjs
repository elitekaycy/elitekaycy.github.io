/**
 * Opens external links from markdown content in a new tab, matching how the
 * rest of the site already treats them (see the project links on the home
 * page).
 *
 * The reading case is the reason: a reference link two thousand words into a
 * chapter should not cost the reader their place, and browser back is a poor
 * substitute for still being where you were.
 *
 * Internal links, anchors and mailto: are left alone.
 */
import { visit } from 'unist-util-visit';

export default function rehypeExternalLinks() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a') return;

      const href = node.properties?.href;
      if (typeof href !== 'string') return;
      if (!/^https?:\/\//i.test(href)) return;
      // Same-site absolute links are not external in the sense that matters.
      if (href.startsWith('https://elitekaycy.com')) return;

      node.properties.target = '_blank';
      node.properties.rel = 'noopener noreferrer';
    });
  };
}
