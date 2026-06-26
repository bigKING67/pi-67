---
description: Frontend workflow, design authority, UX quality, browser validation, and frontend performance.
triggers: frontend, UI, page, component, CSS, responsive, accessibility, chart, visual design
---

# Frontend Rule

Use this rule for pages, components, styling, interaction, accessibility, charts, visual redesign, and browser-facing behavior.

## Startup

1. Find the real frontend entrypoints, routes, style system, package scripts, and existing components.
2. If `DESIGN.md` exists, treat it as style authority unless the user overrides it.
3. Determine tier:
   - L0: copy, spacing, color, or tiny style change.
   - L1-F: functional component/page/interaction.
   - L1-V: visual improvement with meaningful UX impact.
   - L2: new page, redesign, design-system shift, or cross-module UI change.
4. Use the minimum useful skill chain; do not stack visual skills mechanically.

## Design quality

- Prioritize hierarchy, spacing rhythm, typography, contrast, and clear states.
- Avoid generic AI-card layouts, arbitrary gradients, inconsistent shadows, and cramped dense UI.
- Include loading, empty, error, long-content, and disabled states when the component can reach them.
- Preserve accessibility: keyboard flow, semantic labels, contrast, focus states, and reduced-motion concerns.

## Implementation

- Reuse existing tokens, layout primitives, components, and data hooks where appropriate.
- Keep presentational code separate from data loading and business rules.
- Avoid excessive global CSS leakage.
- Memoize expensive derived data and chart transforms with correct dependencies.
- Avoid layout thrash and unnecessary re-renders in lists, tables, dashboards, and charts.

## Validation

- Run the closest relevant command: lint, type-check, unit test, build, or project-specific frontend gate.
- For visible UI changes, use browser validation where possible, especially for protected routes, login state, responsive behavior, downloads, uploads, and interactions.
- Delivery should state tier, style authority, rules/skills used, validation commands, browser/visual result, performance impact, and uncovered cases.
