---
title: "Hello, world"
excerpt: "The first post on this site — and a quick note on how the blog itself is put together."
date: 2026-09-02
tags: ["meta"]
draft: false
---

This is a standalone post — the kind of thing that lives on its own, not as
part of a longer series. Delete this file (`src/content/posts/hello-world.md`)
once you've got real writing to replace it with.

## How posts work here

Every post is just a markdown file with frontmatter:

```md
---
title: "Post title"
excerpt: "One or two sentences for the card on the blog index."
date: 2026-09-02
tags: ["tag-one", "tag-two"]
draft: false
---

Your writing, in markdown.
```

Drop a new file in `src/content/posts/`, push it, and it shows up on the
homepage and in the blog index automatically — sorted by date, searchable,
tagged.

## Series work differently

A multi-chapter piece (a "book," a documented build, anything with real
structure) lives under `src/content/series/<series-slug>/` instead: one
`index.md` holding the title, description, and the locked table of contents
(grouped into parts), and one file per chapter. Chapter pages get a floating
sidebar with the full table of contents, scroll tracking, and next/previous
navigation — see the **qkt — Architecture Notes** series on the blog index
for a real example.
