# Platform colors in both themes

This visual slice replaces the final dark-only styling block with one same-origin theme stylesheet. It changes the light and dark palettes together, without changing permissions, records or workflows.

## Design
- Purple and blue primary actions, violet/teal/blue/amber metric accents, tinted cards and table headers, stronger selected navigation, and small shadows.
- A purple-to-blue hero and the existing original lime book illustration in both themes. No copied artwork or new third-party assets.
- Green still means present/success; red means absent/error; amber means late/warning; blue means excused/information. Teacher attendance summary cards use their actual named status, not their position.
- KPI colors now use theme-aware tokens. Text and number contrast is checked against both neutral and tinted backgrounds.
- Visible keyboard focus, hover states, reduced-motion support and forced-color borders. Existing RTL layout, breakpoints and saved theme choice are preserved.
- The dashboard currently uses metrics and tables, not a real chart component. This change does not add fake charts or data.

## Implementation
`assets/platform-theme.css` loads after the base layout styles. A fixed GET route serves this file as CSS before authentication, including on the login page. No arbitrary asset path or file lookup endpoint was introduced.

The old dark-theme test file now checks both final theme palettes, CSS delivery, filled controls, semantic labels, metric text and accessibility hooks. The old light-unchanged constraint no longer applies to this slice.

## Checks
- Build and 526 tests passed locally.
- Before/after screenshots: real login, owner dashboard and teacher attendance page in both themes, using a fresh disposable seeded database.
- Both themes checked at 1440px desktop and 390px mobile. No page errors, unexpected HTTP errors or horizontal overflow.
- Computed solid-surface text checks on the captured pages were at least 5.05:1. These are targeted checks, not a claim of full WCAG conformance. Gradient endpoint colors and button fills are checked separately in tests.
- Theme toggle and persistence, visible 3px keyboard focus, and reduced-motion behavior checked in a real browser.
- Existing unauthenticated auth checks and teacher finance API denials remain expected, not visual errors.

No database schema, dependency or business-logic change. The only attendance markup change is a named data attribute for status-aware styling.
