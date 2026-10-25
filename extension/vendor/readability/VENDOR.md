# Vendored: `@mozilla/readability` 0.6.0

Upstream: `https://github.com/mozilla/readability` (Apache-2.0; license text in `LICENSE.md`).

Files vendored byte-as-is from the published npm tarball:

| File | Upstream | shasum (sha1) |
|---|---|---|
| `Readability.js` | `package/Readability.js` | `fca442835dee3f158c9facc0431773e4f22fe4d5` |
| `Readability-readerable.js` | `package/Readability-readerable.js` | `d4c91ef981cacf82a3dac4e00b633d353e3b6faf` |
| `LICENSE.md` | `package/LICENSE.md` | (Apache-2.0 text) |

Pin:

- npm package: `@mozilla/readability@0.6.0`
- published tarball: `https://registry.npmjs.org/@mozilla/readability/-/readability-0.6.0.tgz`
- published tarball shasum: `134e3ce3ff1676716e550de0b8de957bcc59208b` (verified with `shasum -c` at vendor time)
- gitHead recorded in the plan: `4d5dd0b` (the tarball's `package.json` carries no `gitHead` field; the value is the plan's pin)
- fetch date: 2026-10-25

Both code files are classic-script globals (their `module.exports` is guarded), so they load
via the manifest's `<all_urls>` content-script entry — no build step. They replace v1's stale
8-file `content/readability-*.js` snapshot (superseded, per the rework doc's 2026-10-22
decision: vendor current upstream, not the snapshot).

**These files are never edited by hand.** Drift is a version bump + re-pin (re-download the
tarball, re-verify the shasum, swap atomically with the manifest paths — a manifest entry
referencing missing files fails extension load), not a local patch.
