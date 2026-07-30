# QA Lab Target Application

## Purpose

QA Lab is Auto-QA's test-only Target Application. It provides a realistic,
deterministic frontend for browser and acceptance tests without depending on an
external service or a production application.

QA Lab is not part of the Auto-QA product. It is a private pnpm workspace
package at `apps/qa-lab`, is never a runtime dependency of Auto-QA, and is not
included in the packed CLI.

## Product concept

QA Lab presents a small account-management product rather than an explicit
gallery of test controls. Its pages should look and behave like ordinary
application surfaces so Auto-QA is exercised against realistic navigation,
content, forms, and failure states.

The visual direction is a restrained internal web application:

- a persistent QA Lab application header and navigation;
- clear page titles, cards, status badges, forms, and tables;
- semantic landmarks and accessible names;
- a stable responsive layout without decorative animation;
- deterministic content that does not depend on the current time, randomness,
  or an external network.

The application does not need to solve a useful business problem. Each page
exists to supply a natural browser-verification surface.

## Application stack

QA Lab uses strict TypeScript, React, Vite, and React Router. React Router is a
deliberate test surface: navigation and route rendering should happen through
the same client-side mechanisms used by ordinary React applications.

QA Lab owns its application code and dependencies. It does not import Auto-QA
modules or share Auto-QA's runtime services. Effect should be introduced into
QA Lab only if a later test behavior genuinely benefits from it.

## Initial tracer bullet

The first implementation supplies only the surface required by the existing
passing-Scenario browser path:

- `/` routes to the Account page through React Router;
- the Account page has an accessible `Account` heading;
- the application shell and Account page contain deterministic, read-only
  profile, plan, and account-status content;
- an unknown route renders an accessible not-found page;
- direct navigation and browser refresh work for application routes.

Additional product behavior is not part of this tracer bullet.

## Growth model

Add a page or state only alongside the first browser Scenario that consumes it.
Expected later surfaces include profile editing, team membership, sign-in,
loading and timeout states, request failures, console failures, and visually
distinct states for screenshot evidence.

These behaviors should remain plausible parts of the account-management
product. Do not expose UI controls named after test mechanisms such as
`Trigger timeout` or `Emit console error`. When a test needs deterministic
configuration that would not belong in the product UI, the harness may provide
it at process startup or through isolated test state.

Each test starts a fresh QA Lab process, so in-memory state is sufficient until
a Scenario specifically requires another persistence boundary.

## Process and Base URL contract

The browser-test harness owns the QA Lab process:

1. The harness starts QA Lab as a separate process using a harness-selected
   ephemeral address.
2. The harness waits until the application is reachable.
3. The harness supplies the resulting Base URL when it starts an Auto-QA Run.
4. Auto-QA completes without stopping or reconfiguring QA Lab.
5. The harness verifies that QA Lab is still reachable, then stops it during
   test cleanup.

QA Lab must not assume a fixed host, port, or Base URL. Auto-QA must not import,
launch, configure, or stop QA Lab.

## Test invariants

- Browser Scenarios locate elements through accessible roles and names rather
  than QA-Lab-specific implementation details.
- A test receives a fresh application process and isolated state.
- Route content and seeded data are deterministic.
- The app makes no unrequested external network calls.
- The ordinary fast test suite does not start QA Lab or Chromium.
- The dedicated browser gate builds and starts QA Lab, exercises the packed
  Auto-QA CLI, and owns all resulting cleanup.
