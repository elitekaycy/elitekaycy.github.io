/**
 * Marks defined domain vocabulary so it stops competing with emphasis.
 *
 * The series bolds two different things: a term being introduced for the
 * first time (`**drawdown**`, `**tick size**`, `**Sharpe**`) and a clause
 * being emphasised (`**it refuses to start.**`). They read identically, which
 * means a reader scanning for the vocabulary of a new domain cannot find it,
 * and a reader scanning for the argument keeps stopping on nouns.
 *
 * Bold is the author's existing signal for "this word matters here"; this
 * plugin only decides which of the two jobs a given bold is doing, by
 * matching against the book's actual glossary. Anything not on the list stays
 * ordinary emphasis.
 *
 * Deliberately not a colour: at up to fifteen terms in a chapter, a hue would
 * be too dense to signal anything, and the semantic palette is reserved for
 * callouts where it carries real meaning.
 */
import { visit } from 'unist-util-visit';

// The book's teaching vocabulary — trading concepts and engine concepts that
// get defined at first use. Matched case-insensitively against the whole bold.
const TERMS = new Set(
  [
    // markets and instruments
    'a tick', 'tick', 'tick size', 'volume step', 'spread', 'ticket', 'market',
    'limit', 'stop', 'a signal', 'a strategy', 'a trade', 'an order', 'a position',
    'a broker', 'duration', 'streams', 'per symbol', 'basket', 'portfolio',
    // positions and money
    'net', 'hedge', 'locked position', 'high-water mark', 'drawdown',
    'max drawdown', 'equity', 'p&l', 'commission', 'venue costs',
    'financing accrual', 'primary', 'stack', 'independent', 'intent',
    'trailing', 'static', 'realized-only',
    // statistics and reporting
    'return', 'variance', 'standard deviation', 'annualized', 'sharpe',
    'sortino', 'calmar', 'curve-fitting', 'in-sample', 'out-of-sample',
    'is', 'oos', 'capital-blind', 'frozen', 'step',
    // arithmetic
    'fixed-point', 'significant-digit',
    // engine
    'event bus', 'publish/subscribe', 'determinism', 'deterministic',
    'presence', 'coverage', 'session-anchored', 'lexer', 'parser',
    'order journal', 'audit journal', 'feed thread', 'regime gate',
    'operator stop', 'language server protocol', 'design spec', 'changelog',
    // order states
    'created', 'submitted', 'working', 'pending', 'filled', 'cancelled',
    'rejected',
    // latency stages
    'tick processing', 'submission to fill',
  ].map((t) => t.toLowerCase())
);

export default function rehypeTerms() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'strong') return;
      if (node.children.length !== 1 || node.children[0].type !== 'text') return;

      const raw = node.children[0].value.trim().replace(/[.,;:]$/, '');
      if (!TERMS.has(raw.toLowerCase())) return;

      node.properties = { ...(node.properties ?? {}), className: ['term'] };
    });
  };
}
