import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

// One entry per series, e.g. src/content/series/qkt-architecture/index.md
const series = defineCollection({
  loader: glob({ pattern: '*/index.md', base: './src/content/series' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    parts: z.array(
      z.object({
        title: z.string(),
        chapters: z.array(z.string()), // chapter slugs, in reading order
      })
    ),
  }),
});

// Every chapter across every series, e.g. src/content/series/qkt-architecture/chapter-01-*.md
const chapters = defineCollection({
  loader: glob({ pattern: '*/!(index).md', base: './src/content/series' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    date: z.coerce.date(),
    order: z.number(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts, series, chapters };
