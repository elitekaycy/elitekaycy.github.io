# elitekaycy.com

Personal site — about, blog, and a home for long-form series (multi-chapter
write-ups with a floating table of contents and next/prev navigation).

Built with [Astro](https://astro.build) + Tailwind CSS. Zero client-side JS
except a theme toggle, search box, and the chapter scroll-spy — everything
else ships as static HTML.

## Content

- `src/content/posts/*.md` — standalone blog posts.
- `src/content/series/<slug>/index.md` — a series' metadata + locked table
  of contents (parts and chapter order).
- `src/content/series/<slug>/chapter-NN-*.md` — individual chapters.

Add a file, push, done — no CMS, no build step beyond `npm run build`.

## Commands

```sh
npm run dev       # local dev server
npm run build     # static build to ./dist
npm run preview   # preview the production build locally
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes to GitHub Pages. In the repo's **Settings → Pages**, set the
source to **GitHub Actions** (one-time setup).
