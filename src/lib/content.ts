import { getCollection, type CollectionEntry } from 'astro:content';

export function readingTime(body: string): number {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

export async function getPublishedPosts() {
  const posts = await getCollection('posts', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export async function getPublishedSeries() {
  const all = await getCollection('series', ({ data }) => !data.draft);
  return all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function seriesSlug(entry: CollectionEntry<'series'>) {
  return entry.id.split('/')[0];
}

export async function getChaptersForSeries(slug: string) {
  const all = await getCollection(
    'chapters',
    ({ id, data }) => id.startsWith(`${slug}/`) && !data.draft
  );
  return all.sort((a, b) => a.data.order - b.data.order);
}

export function chapterSlug(entry: CollectionEntry<'chapters'>) {
  return entry.id.split('/')[1];
}

/** Unified, sortable feed item for the homepage + blog index. */
export type FeedItem = {
  title: string;
  excerpt: string;
  date: Date;
  href: string;
  kind: 'post' | 'series';
  tags: string[];
  minutes: number;
  chapterCount?: number;
};

export async function getFeed(): Promise<FeedItem[]> {
  const [posts, series] = await Promise.all([getPublishedPosts(), getPublishedSeries()]);

  const postItems: FeedItem[] = posts.map((p) => ({
    title: p.data.title,
    excerpt: p.data.excerpt,
    date: p.data.date,
    href: `/blog/posts/${p.id}`,
    kind: 'post',
    tags: p.data.tags,
    minutes: readingTime(p.body ?? ''),
  }));

  const seriesItems: FeedItem[] = await Promise.all(
    series.map(async (s) => {
      const slug = seriesSlug(s);
      const chapters = await getChaptersForSeries(slug);
      return {
        title: s.data.title,
        excerpt: s.data.excerpt,
        date: s.data.date,
        href: `/blog/series/${slug}`,
        kind: 'series' as const,
        tags: s.data.tags,
        minutes: chapters.reduce((sum, c) => sum + readingTime(c.body ?? ''), 0),
        chapterCount: chapters.length,
      };
    })
  );

  return [...postItems, ...seriesItems].sort((a, b) => b.date.valueOf() - a.date.valueOf());
}
