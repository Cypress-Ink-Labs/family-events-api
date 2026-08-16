# family-events-api

Extracted API for the Family Events platform (Lafayette / Baton Rouge). This
repo is the destination for the U20–U33 extraction that currently lives on
`HexSleeves/hm-dotfiles` PR #8.

## Current state

The org repo exists and is empty except for this bootstrap. The transfer
branch on `HexSleeves/hm-dotfiles` is **private**. A Cloud Agent minted
against this repo cannot read that branch, even unauthenticated — GitHub
returns 404 for a scoped token and for anonymous access.

`Cypress-Ink-Labs/family-events-app` is also missing from GitHub. Org
repos that do resolve:

- [family-events-backend](https://github.com/Cypress-Ink-Labs/family-events-backend)
- [family-events-web](https://github.com/Cypress-Ink-Labs/family-events-web)
- [family-events-mobile](https://github.com/Cypress-Ink-Labs/family-events-mobile)

U23+ against a freshly invented scaffold would be a third copy of the
extraction. Import the transfer tree first.

## Import the transfer branch

Once `hm-dotfiles` is readable by this environment (public, or listed in
`.cursor/environment.json` `repositoryDependencies` on a **new** agent
run):

```bash
./scripts/import-transfer-branch.sh
```

That copies `family-events/family-events-api/` from PR #8 (or
`TRANSFER_REF`) onto this repo root.

## What the transfer already has

Six commits on that branch, gates green (68 unit tests, 9 integration
tests against real Postgres):

- reconstructed U20–U33 plan
- U20 scaffold
- U22 identity seam
- U27 topology + kill-switch / run-history parity
- U28 / U30 pure-logic ports

U23 (data-access layer) is the next unit after import. U21 / U24–U26
need `family-events-app` on GitHub to reconcile against the real server
functions.

## Related

Backend production-readiness work that already landed on
`family-events-backend` (`c47b534`): U1–U3, U6b, U19
(`clerk_user_mapping` for the app identity seam).
