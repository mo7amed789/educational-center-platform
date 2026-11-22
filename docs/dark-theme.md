# Dark theme

Dark mode takes its graphite surfaces and blue action accents from the TalimSAT case study supplied for visual inspiration:
https://www.behance.net/gallery/258099183/TalimSAT-Digital-SAT-Prep-Platform-UXUI-Case-Study

No images, logos, illustrations or other assets were copied. The existing platform illustration remains its own asset.

## Scope

- Dark mode only: base `#171717`, cards `#272727`, raised surfaces `#303030`, blue actions `#205cdf`.
- White and muted gray Arabic text, IBM Plex Sans Arabic from the existing font link, restrained rounded corners and neutral borders.
- Separate light-blue text/focus color from solid blue buttons to keep text readable on dark surfaces.
- Existing RTL layout, behavior, light mode and four filled attendance status colors stay unchanged.
- No schema, package or deployment configuration changes.

## Checks

The CSS is appended in one dark-scoped block. Removing that block reproduces the original HTML byte for byte, including all scripts and light-mode rules.

`tests/darkTheme.test.ts` checks dark-only scope, the chosen palette and 4.5:1 text contrast on neutral, semantic and filled-action surfaces. Existing attendance badge tests cover the four unchanged status colors.

A disposable seeded database was used for actual desktop dashboard, mobile guardian report, desktop exam form and desktop/mobile login checks. Before/after dashboard and guardian screenshots were inspected. The light-mode computed-style comparison remained unchanged, with no page errors or horizontal overflow in the captured views.

These checks cover the changed theme. They are not a broader accessibility or production-readiness audit.
