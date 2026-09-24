# Component review

Automated review of pull requests that add or change KiCad footprints (`lib_fp/`), symbols
(`lib_sch/`) or 3D models (`lib_3d/`). For each changed component it:

- renders before/after images (plus a red/green diff overlay for modified parts), per-layer SVGs
  and 3D previews;
- runs deterministic checks (pad counts, KLC-style rules, properties, 3D-model paths) and, if an
  Anthropic API key is configured, an AI review against the datasheet;
- publishes an interactive viewer at `https://<owner>.github.io/<repo>/pr/<N>/`;
- posts **one** PR comment (updated in place on every push) with a summary table, embedded
  before/after images and findings, plus inline review comments on the `.kicad_mod` /
  `.kicad_sym` lines with errors or warnings, and a **Component review** check.

AI findings are advisory. By default the check never blocks a merge.

## Layout

| Dir        | What                                                                        |
|------------|-----------------------------------------------------------------------------|
| `render/`  | `cr_render.py`: diffs base..head and renders every changed item into `OUT/` (`manifest.json`, `items/<slug>/…`) |
| `ai/`      | `cr_ai_review.py`: writes `OUT/review.json`. Use `--no-llm` for the deterministic checks only |
| `viewer/`  | a static web app; `build_site.py --out OUT` copies it into `OUT/`          |
| `ci/`      | GitHub glue: artifact sanitizing, gh-pages deploy, PR comment/review/check  |
| `../../.github/workflows/component-review*.yml` | the three workflows below         |

The data formats are specified in `CONTRACT.md` (kept next to the project, not in this repo).

## Architecture

PRs usually come from forks, and a fork's workflow run gets no secrets and only a read-only
token. So the work is split in two stages: an unprivileged stage runs the PR's code, and a
privileged stage never runs PR code.

```
 PR opened / pushed (fork or branch)
        │  pull_request  (paths: lib_fp/**, lib_sch/**, lib_3d/**, tools/component-review/**)
        ▼
┌──────────────────────── component-review.yml ─────────────────────────┐
│ UNPRIVILEGED: contents: read, no secrets, runs the PR's code           │
│ container kicad/kicad:10.0 (optional)                                  │
│  checkout PR head (full history) → merge-base with base branch         │
│  render/cr_render.py  --base <merge-base> --head <head> --out cr-out   │
│  ai/cr_ai_review.py   --out cr-out --no-llm      (deterministic checks)│
│  viewer/build_site.py --out cr-out                                     │
│  upload artifacts: component-review (= cr-out, downloadable fallback)  │
│                    pr-meta (pr.json: PR number, head/base sha)         │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ workflow_run: completed + success
                                ▼
┌───────────────────── component-review-publish.yml ────────────────────┐
│ PRIVILEGED: contents/pull-requests/checks: write, ANTHROPIC_API_KEY    │
│ Code comes from the DEFAULT BRANCH checkout only. Artifact = data.     │
│  ci/resolve_pr.py     PR number from pr-meta, accepted only if the API │
│                       says PR N is open and its head == run head_sha   │
│  ci/sanitize_site.py  allow-listed data files only; no HTML/JS; SVGs   │
│                       with scripts/handlers/external refs dropped;     │
│                       size caps; untrusted review.json discarded       │
│  ci/fetch_datasheets.py  private AI work copy + strict https datasheet │
│                       fetch (never published)                          │
│  ci/fetch_klc_utils.sh  kicad-library-utils at the pinned commit       │
│  ai/cr_ai_review.py   LLM review on the work copy, --no-download       │
│                       (or --no-llm if no key / on error)               │
│  viewer/build_site.py trusted viewer copied over the data              │
│  ci/deploy_pages.py   commit to gh-pages under pr/<N>/ (other PRs kept,│
│                       retries on push races)                           │
│  ci/post_review.py    inline review (COMMENT, deduped) + sticky comment│
│                       (<!-- component-review -->) + check run          │
└───────────────────────────────┬────────────────────────────────────────┘
                                ▼
         gh-pages ──(GitHub Pages)──► https://<owner>.github.io/<repo>/pr/<N>/#<slug>

 PR closed / merged ── pull_request_target ──► component-review-cleanup.yml
        deletes pr/<N>/ from gh-pages and notes it on the sticky comment (no PR code checkout)
```

Images in the PR comment point at `raw.githubusercontent.com/<repo>/<gh-pages commit>/pr/<N>/…`,
pinned to the gh-pages commit of that run. They show up straight away (Pages takes a minute
or so to redeploy), older comments never show newer images, and they keep working after the
cleanup, because the old commit still has them.

### Security notes

- `component-review.yml` runs untrusted code but has only `contents: read` and no secrets.
- The publish and cleanup workflows run from the default branch. A PR that edits them, or
  edits `tools/component-review/**`, changes nothing until it's merged. Review changes to
  these files carefully.
- Everything from the artifact is untrusted. The PR number is checked against the API.
  File names and types are allow-listed. Every string that goes into a comment is escaped
  (no raw HTML, `@mentions` or remote images). Image URLs are only built for files that
  exist in the sanitized site. Nothing from the artifact is executed.
- The LLM reads PR-controlled text (footprint/symbol sources and datasheet PDFs linked from
  them), so a PR could try prompt injection. That can only change the wording of the advisory
  review. The model has no tools, and its output is escaped like everything else.
- Datasheet URLs named in the PR are fetched by `ci/fetch_datasheets.py`, not by the ai
  tool, which runs with `--no-download`. Limits: https only (an `http://` URL is tried as
  `https://` first and refused only if that fails; redirects must stay https; default port),
  hosts must resolve to public IPs (connections are pinned to the checked IP), 20 MB and
  20 s wall-clock per file, 20 files and 120 s per run. The body must be a PDF; for
  distributor landing pages, one same-site PDF link is followed. These can be tuned with
  `CR_DS_MAX_BYTES`, `CR_DS_TIMEOUT_S`, `CR_DS_MAX_DOWNLOADS` and `CR_DS_BUDGET_S`. The PDFs
  only go into a private work copy for the AI and are never published on Pages.
- Size caps in `sanitize_site.py`: 25 MB per STEP/WRL/GLB file, 30 MB per PDF, 10 MB for
  anything else, and 300 MB per PR site (`CR_MAX_SITE_MB`). When the site cap is hit, the
  bulky files (PDF, GLB, STEP) are dropped first. Manifest references to dropped files are
  set to `null`, with a warning on the item, so the viewer shows "missing".
  `.step`/`.stp` files must start with the STEP header.

## Repository setup (admin, one-time)

1. **Merge to the default branch.** `workflow_run` and `pull_request_target` workflows only
   run from the default branch (`main`), so nothing gets published until this is merged.
2. **GitHub Pages**: *Settings → Pages → Build and deployment → Source: Deploy from a
   branch*, branch **`gh-pages`**, folder **`/ (root)`**. The first publish run creates the
   `gh-pages` branch. If it doesn't exist yet when you open this page, come back after the
   first run, or push an empty `gh-pages` branch first.
3. **Actions permissions**: *Settings → Actions → General → Workflow permissions*: select
   **Read and write permissions**. Each workflow narrows its own token. Keep *"Allow GitHub
   Actions to create and approve pull requests"* off; we don't need it.
4. **Secret** (optional): *Settings → Secrets and variables → Actions → New repository
   secret* `ANTHROPIC_API_KEY`. Without it, only the deterministic checks run and the
   comment says so.
5. **Fork PRs**: with the default *"Require approval for first-time contributors"*, a
   maintainer has to click *Approve and run* on a new contributor's first PR. After that,
   everything is automatic.
6. If `gh-pages` has branch protection, let `github-actions[bot]` push to it.

Optional repository **variables** (*Settings → Secrets and variables → Actions → Variables*):

| Variable             | Default             | Meaning |
|----------------------|---------------------|---------|
| `CR_KICAD_IMAGE`     | `kicad/kicad:10.0`  | Container for the render job. Set to `none` to run on the plain runner (no `kicad-cli`) |
| `CR_FETCH_STOCK_MODELS` | on             | Set to `false` to stop the render job downloading KiCad stock 3D models (`${KICAD10_3DMODEL_DIR}/…`) from the official kicad-packages3D repo at the tag pinned in `render/stock_models_tag.txt`. Downloads are cached with actions/cache, keyed on that file |
| `CR_FAIL_CONCLUSION` | `neutral`           | Check-run conclusion when the AI verdict is `fail`: `neutral` (default, never blocks), `failure` (lets you require the check in branch protection), or `success` |
| `CR_MODEL`           | ai tool's default   | Claude model for the AI review |
| `CR_EFFORT`          | ai tool's default   | Effort level for the AI review |
| `CR_KLC`             | on                  | Set to `false` to skip the official KLC checker (kicad-library-utils, pinned in `ci/klc_utils.ref`). It runs in both the unprivileged `--no-llm` job (cached) and the trusted LLM job (fetched fresh, ~1 s) |
| `CR_PAGES_URL`       | `https://<owner>.github.io/<repo>/` | Viewer base URL, e.g. with a custom Pages domain |

Verdict → check conclusion: `pass` → success, `warn` → neutral, `fail` → `CR_FAIL_CONCLUSION`,
no review → neutral.

## Running locally

Needs Python 3.11+. Run from the repo root:

```sh
pip install -r tools/component-review/render/requirements.txt   # if present
base=$(git merge-base origin/main HEAD)
python3 tools/component-review/render/cr_render.py --repo . --base "$base" --head HEAD --out cr-out
python3 tools/component-review/ai/cr_ai_review.py --out cr-out --no-llm   # or with ANTHROPIC_API_KEY set
python3 tools/component-review/viewer/build_site.py --out cr-out
python3 -m http.server -d cr-out 8000                                     # open http://localhost:8000/
```

Preview what CI would post, without writing anything to GitHub. `--dry-run` only makes GET
requests. It reads the PR's file list and existing comments through `GITHUB_TOKEN` or your
`gh auth login`. Add `--files-json FILE` to run fully offline:

```sh
python3 tools/component-review/ci/sanitize_site.py --src cr-out --dst /tmp/cr-site
python3 tools/component-review/ci/post_review.py --site /tmp/cr-site \
    --repo PantsForBirds/kicad-libs --pr 8 --head-sha "$(git rev-parse HEAD)" --dry-run
# prints the sticky comment markdown, the review payload (inline comments) and the check run
python3 tools/component-review/ci/make_comment.py --site /tmp/cr-site \
    --repo PantsForBirds/kicad-libs --pr 8 --head-sha "$(git rev-parse HEAD)" > comment.md
```

`deploy_pages.py --site DIR --repo o/r --pr N --remote /path/to/bare.git --push` deploys to
any git remote, for trying it out. Leave out `--push` to only build the commit.

Tests (stdlib only, they use generated mock data):

```sh
python3 -m unittest discover -s tools/component-review/ci/tests -v
python3 tools/component-review/ci/tests/make_mock.py /tmp/mock    # mock site + PR file list
```

Lint the workflows with [actionlint](https://github.com/rhysd/actionlint) (plus shellcheck
if you have it): `actionlint .github/workflows/component-review*.yml`.

## Cost and limits

- **Stock 3D model cache**: each run saves a new cache entry and restores the newest one
  for the same `stock_models_tag.txt`. Caches from PR runs are only visible to that PR, so
  each PR starts its own. Old entries are evicted by GitHub's 10 GB per-repo cache limit.
- **Actions minutes**: free for public repos. A render run takes a few minutes (most of it is
  pulling the KiCad image). The publish and cleanup jobs take about a minute.
- **LLM**: the only paid part. The AI review runs once per push to a PR that touches library
  files, with one request per changed component (datasheet PDF included), and re-reviews
  every changed component on each push. The ai tool logs the token usage and estimated cost
  of each run (see `ai/`). To limit spend, pick a cheaper `CR_MODEL`, or leave the
  `ANTHROPIC_API_KEY` secret out and use only the free deterministic checks.
- **Storage**: artifacts are kept for 30 days. Every publish adds a commit of images to
  `gh-pages`, and the cleanup removes the files but not the history. If the branch gets big,
  it can be reset to a single squashed commit: old comment images then stop loading, but
  live previews are unaffected.
- **Comment size**: GitHub caps comments at 65,536 characters. For very large PRs the
  comment leaves out the lowest-severity items' details and points to the viewer.
  At most 40 inline comments per run. The rest are in the sticky comment.
