# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal portfolio/blog website built with Astro 5.x, a modern static site generator. Styled with Tailwind CSS. TypeScript strict mode enabled.

## Common Commands

```bash
npm run dev      # Start local dev server at localhost:3000
npm run build    # Build production site to ./dist/
npm run preview  # Preview production build locally
```

To generate Exercism portfolio pages from local Exercism solutions:
```bash
python3 ./generate.py
```

## Architecture

- **src/pages/** - File-based routing; each `.astro` file becomes a route
- **src/layouts/** - `Layout.astro` (base with nav), `BlogPost.astro` (blog template)
- **src/components/** - Reusable Astro components (`Card.astro`, `BlogCard.astro`)
- **src/content/blog/** - Markdown blog posts with Zod-validated frontmatter (title, description, date, tags, draft)
- **src/content/config.ts** - Content collection schema definitions
- **public/** - Static assets served at root; includes Prism.js for syntax highlighting

## Key Details

- Prism.js is used for code syntax highlighting instead of Astro's built-in (configured in `astro.config.mjs`)
- Blog post frontmatter schema is defined in `src/content/config.ts`
- `generate.py` creates Exercism portfolio pages dynamically from local Exercism solutions directory
- Build output goes to `dist/` (gitignored)
