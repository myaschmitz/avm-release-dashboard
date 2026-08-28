# AVM Terraform release status

A static dashboard showing where each Azure Verified Modules Terraform repository sits relative to its newest published version.

For every `Azure/terraform-azurerm-avm-*` repository it reports the newest version tag, how many commits sit on the default branch beyond that tag, how many of those a person wrote, and how long the oldest one has waited.

## Why it exists

A module can be fixed on `main` and still be unavailable to anyone using the Terraform registry, because the registry publishes from git tags. This page shows which repositories are in that state, and how long they have been there.

## States

| State | Meaning |
| --- | --- |
| Unreleased work | A person's commits sit beyond the newest version tag. Registry consumers do not have them. |
| No version tag | No semver tag exists, so the registry has nothing to publish. Most are proposed modules that were never developed. |
| Bot commits only | The branch is ahead, but only by automation such as `chore: run avm pre-commit`. |
| Fully released | The newest tag sits on the tip of the default branch. |

## How it updates

`.github/workflows/publish-dashboard.yml` runs daily at 13:17 UTC, on manual dispatch, and on any push that touches `site/` or `scripts/`. It runs the collector, stages `site/` as `_site/`, and deploys straight to GitHub Pages. The generated JSON is never committed back.

Pages must be enabled once before the first run, because `GITHUB_TOKEN` is not allowed to create a Pages site. A repository admin runs this:

```pwsh
gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
```

The copy of `site/data/release-status.json` in this repository is a fixture for local development only. It goes stale, and the published site never uses it.

## Running it locally

```pwsh
pwsh -File scripts/Get-AvmReleaseStatus.ps1 -OutputPath site/data/release-status.json
node site/serve.js
```

The sweep takes about seven minutes for 188 repositories. Use `-MaxRepos 10` for a fast pass while working on the page itself.
