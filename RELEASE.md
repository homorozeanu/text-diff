# Releasing

A release is created by pushing a version tag (`vX.Y.Z`). The
[Release workflow](.github/workflows/release.yml) then type-checks, runs the
tests, builds `dist/index.html` and publishes a GitHub release with
`index.html` and `index.html.gz` attached.

## Bump the version before tagging

The version in `package.json` must match the tag, and the tag must point to
the commit that contains that version. Always bump and commit **first**, then
tag that commit. Tagging first and bumping afterwards leaves the release built
from a commit with the old version.

`npm version` does both steps in the right order: it updates `package.json`
and `package-lock.json`, commits them, and tags that commit.

```sh
git switch main
git pull
npm version patch      # 0.0.1 -> 0.0.2; use minor or major as needed
git push origin main --follow-tags
```

`npm version` refuses to run if the working tree has uncommitted changes.

### Doing it by hand

```sh
npm version 0.0.2 --no-git-tag-version   # updates package.json and the lock file
git commit -am "Release v0.0.2"
git tag v0.0.2
git push origin main v0.0.2
```

## Which number to bump

- **patch** (`0.0.1 → 0.0.2`): bug fixes only.
- **minor** (`0.0.2 → 0.1.0`): new features, nothing removed or changed in a
  way users would notice as breaking.
- **major** (`0.1.0 → 1.0.0`): changes that break existing behaviour.

## Re-running a release

If the workflow failed for a tag that already exists, start it again from the
Actions tab: *Release* → *Run workflow*, and enter the tag. If a release for
that tag was already created, delete it on GitHub first, since the workflow
cannot create a second release for the same tag.

## Known exception

`v0.0.1` was tagged before `package.json` was changed from `1.0.0` to `0.0.1`,
so that release was built from a commit whose `package.json` still says
`1.0.0`. The built page does not show the version, so the release itself is
not affected.
