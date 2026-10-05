# Motion animations

Add animations across the app with the [`motion`](https://motion.dev) library (v14, React 18/19 peer) so overlays, lists and data viz feel fluid. Chosen over CSS only for three things CSS can't do cleanly: exit animations on conditionally rendered overlays, layout animation (rows gliding when the list changes) and drag (swipe to dismiss).

Preview of the intended feel, built for the CSS vs motion comparison: https://claude.ai/artifact/Qxju7rq8ny9Fdj1DmMH78L

## Goals / acceptance criteria

- Drawer, BottomSheet and Toast animate in **and out**. Today they unmount instantly on close.
- BottomSheet can be dismissed by dragging it down (past 70px or a fast flick). A short drag springs back.
- Rows removed from the Categorize queue and the Rules list animate out, and the rows below glide up. Undo brings the row back with the same motion in reverse.
- Budget rings, the dashboard hero ring and budget progress bars fill on mount with a spring, and the spent amount counts up.
- Dashboard summary cards, budget cards and account cards fade up in a short stagger on first render.
- Active state in the bottom nav, sidebar nav and Settings pill groups slides between options instead of swapping instantly.
- Users with `prefers-reduced-motion: reduce` get no movement: transforms are skipped, opacity changes stay instant. This matches the existing global rule in `app/globals.css`.
- No visible layout shift or flash of hidden content on first paint. Server-rendered content is visible even if JS hasn't loaded yet.
- First-load JS for any page grows by no more than ~6 KB gzipped. The animation feature bundle (~25 KB) loads async after hydration.

## Non-goals

- Route/page transitions. Pages keep the existing CSS `fade-up` on mount. React's `<ViewTransition>` can be evaluated separately.
- `Modal` (native `<dialog>`). It keeps the CSS `dialog-in` animation. Moving it to motion would mean giving up the native top layer and focus handling for little gain.
- Animating whole-list swaps: pagination, filter or period changes on Transactions. Only single-row add/remove animates.
- Animated charts beyond rings and bars (pie slices, trends stacked bar). Can follow later if the base setup works well.
- Gestures other than swipe to dismiss (no swipe-to-delete rows).

## Open questions

Defaults below are what this plan assumes. Confirm or change before implementation starts.

1. **Swipe to dismiss on the mobile Drawer too?** Below `lg` the Drawer is full screen (Log a transaction, transaction detail). Default: **no**, only BottomSheet, since a full-screen form with scrolling content fights a vertical drag.
2. **Transactions list row animation.** Rows change after delete from the detail Drawer via `router.refresh()`. Default: **animate single-row removal only**, and skip whenever more than 3 rows change at once (pagination, filters).
3. **Playwright reduced motion.** Default: set `reducedMotion: 'reduce'` globally in `playwright.config.ts` so existing specs stay deterministic, and opt in to motion only in the new `animations.spec.ts`.

## Design

### Bundle strategy

Use `LazyMotion` with the `m` component everywhere, never the full `motion` component. ESLint enforces this (see checklist).

- `lib/motion/features.ts`: `export default domMax` (needed for layout and drag).
- `components/motion/motion-provider.tsx` (`'use client'`):

```tsx
export const MotionProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => (
  <LazyMotion features={loadFeatures} strict>
    <MotionConfig reducedMotion="user">{children}</MotionConfig>
  </LazyMotion>
);
```

`loadFeatures = () => import('@/lib/motion/features').then((m) => m.default)`. Mounted once in `app/layout.tsx` around `{children}`. Server components can still render inside it.

### Shared motion tokens (`lib/motion/tokens.ts`)

One place for every spring and duration, so the app feels consistent:

```ts
export const spring = {
  snappy: { type: 'spring', stiffness: 420, damping: 32 }, // overlays, layout, nav indicator
  bouncy: { type: 'spring', stiffness: 320, damping: 21 }, // cards, bars, toast enter
  smooth: { type: 'spring', stiffness: 140, damping: 26 }, // ring fill, count-up (no overshoot on money)
} as const satisfies Record<string, Transition>;

export const exit = { duration: 0.2, ease: [0.4, 0, 1, 1] } as const; // exits are quick, not springy
export const STAGGER = 0.06; // seconds between list items
export const SWIPE_DISMISS = { offset: 70, velocity: 500 } as const;
```

### Pure helpers (`lib/motion/list.ts`, unit tested)

- `isSmallListChange(prevIds: string[], nextIds: string[], max = 3): boolean`: true when added + removed ids are at most `max`. Lists use this to decide whether to render `AnimatePresence` exits and `layout`, or to swap instantly.
- `shouldDismissSheet(offsetY: number, velocityY: number): boolean`: the swipe threshold check, pulled out so it's testable without a DOM.

### Overlays

| Component                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ui/drawer.tsx`   | Panel becomes `m.div` inside `AnimatePresence`. At `lg+` it slides in from the right (`x: '100%'` to `0`). Below `lg` it slides up (`y: 24`, `opacity: 0`). Exit reverses with `exit` timing. Return `<AnimatePresence>{open && …}</AnimatePresence>` instead of `return null`. Focus trap and scroll lock effects stay as they are; they already key off `open`, not mount.                                                    |
| `components/ui/bottom-sheet.tsx` | Backdrop fades (`opacity`), sheet slides from `y: '100%'`. Add `drag="y"`, `dragConstraints={{ top: 0, bottom: 0 }}`, `dragElastic={{ top: 0.05, bottom: 0.6 }}`, `dragListener={false}` plus a visible grab handle that starts the drag via `useDragControls`, so scrolling the sheet's content doesn't drag it. `onDragEnd` calls `onClose` when `shouldDismissSheet` passes. Backdrop opacity follows drag via `useTransform`. |
| `components/ui/toast.tsx`    | Root becomes `m.div` with `initial={{ opacity: 0, y: 20, scale: 0.96 }}`, `bouncy` enter and `exit` out. Both call sites in `categorize-view.tsx` wrap `{toast && <Toast …/>}` in `AnimatePresence`. Auto-dismiss timer unchanged.                                                                                                                                                                                         |

Note: `transactions-view.tsx` remounts the detail Drawer with `key={drawer-${drawerKey}}` on **open**, so the exit animation on close still plays. No change needed there.

### Lists

| Where                                                   | Change                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/categorize/categorize-view.tsx` (row lists) | Rows become `m.div layout` with `exit={{ opacity: 0, x: -48 }}` inside `AnimatePresence initial={false}`. Payee group cards get the same treatment. This is the main win: accepted rows leave smoothly. |
| `components/rules/rules-view.tsx` (rules list)          | Same pattern for delete.                                                                                                                                                                               |
| `components/transactions/transactions-view.tsx`         | Rows get `layout` and exit only when `isSmallListChange` is true (open question 2).                                                                                                                    |

`layout` stays off the day-group headers to avoid header text stretching during the animation (use `layout="position"` if headers need to move).

### Data viz and cards

- `components/ui/ring.tsx`: add `'use client'`. The value circle becomes `m.circle` and animates `strokeDasharray` from `0 C` to the target with `smooth`. Ring is used by server pages (`dashboard/page.tsx`, auth pages) but only takes serializable props plus `children`, so the client boundary is safe. Login/signup decorative rings keep the animation (cheap, adds polish).
- `components/ui/animated-money.tsx` (new, client): `useSpring` + `useTransform` count-up that formats through the existing `Money` formatting so currency output is identical. Used for the dashboard hero amount and budget card spent amounts.
- Budget progress bars in `components/budgets/budgets-view.tsx` and `components/trends/category-breakdown-bar.tsx`: width animates from 0 with `bouncy`, staggered by index.
- `components/motion/stagger.tsx` (new, client): `<Stagger>` / `<StaggerItem>` pair using variants and `STAGGER`, so server pages can wrap card grids without becoming client components themselves. Applied to the dashboard summary cards, budget cards and account cards.

### Nav and pills

- `components/nav/bottom-nav.tsx` and `components/nav/sidebar-nav.tsx`: render an `m.span layoutId="nav-active"` (bottom nav) / `layoutId="sidebar-active"` (sidebar) behind the active item. Since BottomNav lives in the protected layout, it survives route changes and the indicator slides between tabs.
- Settings pill groups (`components/settings/pills.ts` consumers): active background becomes a `layoutId` pill scoped per group with `LayoutGroup id={…}` so palette and appearance pills don't share an indicator.
- Buttons: `components/ui/button.tsx` keeps the CSS `active:scale-[0.97]` (cheaper than a motion wrapper on every button, and looks the same).

### Reduced motion

`MotionConfig reducedMotion="user"` disables transform and layout animations for users who ask for reduced motion. The CSS rule in `globals.css` stays for the remaining CSS animations. Count-up jumps straight to the final value when `useReducedMotion()` is true.

## Test plan

### Unit (`tests/unit/lib/motion/`)

`list.test.ts`

- `isSmallListChange`: identical lists → true; one removed → true; one added → true; 3 changed → true; 4 changed → false; full swap (new page) → false; empty to empty → true; custom `max` respected.
- `shouldDismissSheet`: offset 71 / velocity 0 → true; offset 69 / velocity 0 → false; offset 10 / velocity 600 → true; negative offset (dragged up) with high upward velocity → false; exactly at thresholds → document and assert the chosen boundary.

### E2E (`tests/e2e/animations.spec.ts`, `test.use({ reducedMotion: 'no-preference' })`)

- Drawer: open Log a transaction, close it; the panel is still in the DOM right after close, then detached (proves the exit runs and completes). Escape and focus return still work.
- BottomSheet (mobile viewport, period picker on dashboard): drag the handle down 120px → sheet closes; drag 30px → sheet stays open. Backdrop click still closes.
- Categorize: accept a suggestion → row is removed and toast appears; Undo → row returns. Final DOM state matches today's spec expectations.
- Reduced motion (`test.use({ reducedMotion: 'reduce' })`): Drawer closes and detaches with no lingering panel; ring renders at its final value immediately.
- Existing specs keep passing with the global `reducedMotion: 'reduce'` default (open question 3).

### Manual checks

- Lighthouse / `next build` output: first-load JS per route within the +6 KB budget.
- Mobile Safari: sheet drag doesn't trigger page pull-to-refresh, safe-area padding intact while dragging.
- Dark mode and all three palettes: nav indicator and pill backgrounds use tokens, no hard-coded colors.

## Checklist

- [ ] Resolve open questions 1 to 3
- [ ] `npm install motion` and confirm the version in `package.json`
- [ ] `lib/motion/features.ts`, `lib/motion/tokens.ts`, `lib/motion/list.ts`
- [ ] Unit tests for `lib/motion/list.ts`
- [ ] `components/motion/motion-provider.tsx`, mounted in `app/layout.tsx`
- [ ] ESLint `no-restricted-imports` rule: disallow importing `motion` from `motion/react` (use `m`)
- [ ] Drawer enter/exit
- [ ] BottomSheet enter/exit + drag to dismiss
- [ ] Toast enter/exit + `AnimatePresence` at categorize call sites
- [ ] Categorize rows and payee groups layout + exit
- [ ] Rules list layout + exit
- [ ] Transactions rows (small changes only)
- [ ] Ring fill animation
- [ ] `AnimatedMoney` count-up on dashboard hero and budget cards
- [ ] Budget and trends bars grow
- [ ] `Stagger` for dashboard, budgets and accounts card grids
- [ ] Bottom nav and sidebar active indicator
- [ ] Settings pill group indicator
- [ ] `playwright.config.ts` global `reducedMotion: 'reduce'`
- [ ] `tests/e2e/animations.spec.ts`
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
- [ ] Bundle size check against the +6 KB budget
