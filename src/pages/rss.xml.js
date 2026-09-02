import rss from '@astrojs/rss';
import { getRssItems } from '../lib/content';

export async function GET(context) {
  const items = await getRssItems();
  return rss({
    title: 'Dickson Anyaele',
    description:
      'Writing on trading systems, backend engineering, and AI tooling.',
    site: context.site,
    items,
  });
}
