import rss from '@astrojs/rss';
import { getFeed } from '../lib/content';

export async function GET(context) {
  const feed = await getFeed();
  return rss({
    title: 'Dickson Anyaele',
    description: 'Writing on trading systems, backend engineering, and AI tooling.',
    site: context.site,
    items: feed.map((item) => ({
      title: item.title,
      description: item.excerpt,
      pubDate: item.date,
      link: item.href,
      categories: item.tags,
    })),
  });
}
