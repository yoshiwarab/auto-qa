# Decisions

Settled questions and why. Reopen one only with new evidence.

## Standalone, no pstack

auto-qa must work in any repo on its own. It does not depend on pstack or any
other agent framework; the qa skill is the only integration.

## macOS and Linux

Process discovery uses `ps`, not `/proc`. A Linux-only `/proc` version was
rejected because the user works on both, and CI runs `pnpm check` on Ubuntu and
macOS.

## Two ways to use it

- **Work repos**: nothing installed and nothing committed. Run it with
  `npx auto-qa` and throwaway `--scratch` specs.
- **Personal repos**: installed as a dev dependency, building a real e2e suite
  in `e2e/`.

Both must keep working; a change that helps one at the cost of the other needs
a strong reason.

## Bundled @playwright/test

Most work repos have no Playwright, so scratch mode needs its own. That pinned
copy is the only runtime dependency.

## A strict guard

Healing may change how a test finds things, never what it checks. `guard`
fails on any changed or removed line inside an assertion, including every line
of a wrapped `expect(...)`, so the locator it checks counts too. The only
override is a human setting `AUTO_QA_ALLOW_ASSERTION_CHANGES=1`.

A looser rule that only looked at matcher lines was rejected: it let an agent
quietly weaken `getByText("Order confirmed")` while the `.toBeVisible()` line
stayed the same.

## No LLM calls

auto-qa never calls a model. `triage` writes a bundle of facts (attempts,
errors, evidence, commits, app diff), and the qa skill tells the agent how to
call each failure a regression, drift or flaky. That keeps the tool
deterministic, free to run, and independent of any provider.

## A 450-line budget

`src/` stays at or under 450 lines, enforced by `pnpm check`. New code needs
offsetting cuts. The budget forces using Playwright's own config, flags,
reporters and fixtures instead of custom plumbing.

## Use it before building more

The agreed direction is to use auto-qa on real projects and fix what that
turns up, rather than adding features on speculation.
