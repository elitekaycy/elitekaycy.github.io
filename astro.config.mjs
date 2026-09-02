// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeCallouts from './src/lib/rehype-callouts.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://elitekaycy.github.io',

  vite: {
    plugins: [tailwindcss()],
  },

  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: false,
    },
    rehypePlugins: [
      rehypeSlug,
      rehypeCallouts,
      [
        rehypeAutolinkHeadings,
        {
          behavior: 'append',
          properties: {
            className: ['heading-anchor'],
            ariaLabel: 'Link to this section',
          },
          content: { type: 'text', value: '#' },
        },
      ],
    ],
  },

  integrations: [sitemap()],
});
