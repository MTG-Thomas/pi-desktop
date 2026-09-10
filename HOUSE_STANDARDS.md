# House standards (fork)

How this fork tracks MTG-Thomas TypeScript standards without making itself
unmergeable against upstream `FaqFirebase/pi-desktop` (alpha, fast-moving).

## Adopted

- **ESLint promise-safety** (`no-floating-promises`, `no-misused-promises`,
  type-aware via `projectService`) for `src/{main,preload,shared}/**/*.ts`
  except `*.test.ts`. Same two rules as house; same scoped-rollout rationale.
- **Prettier** (`.prettierrc`: single-quote, no-semi to match repo style;
  width 120, `endOfLine: auto` for the CRLF working tree). Governs
  fork-owned files only — see below.
- **CI on PR** (`.github/workflows/ci.yml`): lint, typecheck, `npm test`,
  format check, `npm audit --omit=dev`. Pinned action SHAs, Node 22,
  `npm ci --ignore-scripts` (native rebuild stays in `build.yml`).
- **`npm test`** (`tsx --test` with glob args, Node 22+) and
  `engines: node >= 22.16.0`, matching house toolchain.

## Scoped out (deliberate)

- **`noUncheckedIndexedAccess`** (house tsconfig standard): 423 errors across
  ~60 upstream files when enabled. Turning it on means rewriting upstream
  alpha code and forfeiting clean rebases. Revisit when upstream stabilises
  or the fork diverges permanently. New fork code should still be written as
  if the flag were on (narrow `| undefined` at boundaries; `!` only in tests).
- **Renderer promise rules**: 29 files of `useEffect`/handler patterns need
  restructuring, not mechanical fixes. Base + hooks rules stand.
- **Repo-wide prettier**: upstream style (union wrapping, etc.) is not
  prettier-shaped; reformatting = hundreds of cosmetic hunks. `format` /
  `format:check` cover fork-owned globs only
  (`src/**/bus-*.ts`, `pi-bus/**/*.ts` — extend the globs as new fork areas
  land, never reformat upstream files to satisfy them).

## Fork-maintenance rules

1. Keep the `upstream`-touching diff small and upstreamable (bus broker,
   promise fixes). Domain work lives in Pi packages (`pi-bus/`), not in main.
2. Never reformat a file you did not otherwise change.
3. `git fetch upstream` + rebase before release branches (`upstream/master`
   is still their default); resolve by keeping upstream's code and
   re-applying the standard on top.
