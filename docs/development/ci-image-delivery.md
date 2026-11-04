# CI scope and immutable image delivery

GitHub owns required checks, release image evidence and source history. Production consumes a
tested `linux/amd64` image by registry digest. The existing full-SHA local image aliases remain
the interface for Compose, rollback and image retention. A Docker image ID identifies its config;
it is distinct from the registry manifest digest. Both identities are recorded and compared.

## Accumulated main coverage

`scripts/ci/impact.mjs plan` freezes the scope and its evidence once. For a trusted main push it
searches bounded first-parent history for a successful main CI and CodeQL pair with a compatible
`main-green.json` certificate. Changes from that ancestor to the selected SHA determine scope.
A failed runtime change followed by a documentation change therefore retains runtime checks.

The policy fingerprint includes workflow and scope-selection inputs. The first run of a new
policy, missing or expired certificates, incomplete history, exhausted pagination and unavailable
GitHub evidence select a full run. A historical green check without the new certificate cannot
bootstrap a scoped run. PR scope stays bound to the event's recorded base; manual and scheduled
runs retain full coverage.

`Required` validates the frozen context, policy, cited workflow/run/attempt/job/check identities
and certificate, then independently recomputes the selected scope. It never chooses a newer base
while verifying skips. It rejects partial reruns that retain the impact plan of an older attempt;
rerun all jobs in that case. A successful trusted main run saves its certificate under
`ci-main-green-SHA-RUNID-ATTEMPT`. A later run can use it only after the exact CodeQL gate also
succeeds. Concurrent runs can finish in any order without changing a plan already in progress.

Ordinary CodeQL runs continue analysis, SARIF upload and the high-severity alert gate. Database
upload runs on the weekly schedule. Compare durations on equivalent runs before claiming a
measured improvement.

## Image publication and verification

PR code has no registry or signing permissions. The Docker job builds and runs image smokes with
read-only repository access. For trusted main pushes and manual preparation on main it exports
the tested image and a bounded identity record. Their artifact name includes SHA, run and attempt.

A separate GitHub-hosted registry job consumes that exact artifact after Docker succeeds. It:

1. Loads the checksummed archive and compares source labels, platform, config ID and image size.
2. Reads full package metadata for `ghcr.io/gameclubpro/major-maksimov-private-v1-COMPONENT` using
   the publication workflow's package credential. Before any Docker tag or push, it requires the
   exact container package name, private visibility and source repository ID/name binding.
   Missing packages, HTTP 403/404, empty or malformed metadata and unavailable evidence block
   publication. A verified public package produces a separate refusal. It checks privacy and
   binding again after push, then pulls the returned digest to compare it with the tested config ID.
3. Generates an SPDX SBOM from the same local image and attests both provenance and SBOM for
   the exact registry digest through GitHub OIDC.
4. Verifies signatures and signed certificate claims for repository identity, source SHA/ref,
   workflow path/digest, allowed runner and the exact run invocation/attempt. The pinned actions
   emit exact predicate types `https://slsa.dev/provenance/v1` and
   `https://spdx.dev/Document/v2.3`; the verifier checks those full identifiers without prefix
   matching or substituting invocation fields from the predicate body.
5. Uploads only `registry-record-COMPONENT.json` in the bounded receipt artifact
   `maxim-registry-COMPONENT-SHA-RUNID-ATTEMPT`. The SBOM is attached through its attestation.

Registry writes, OIDC and attestation permissions belong only to that publication job. Temporary
registry authentication files are private and removed after use. The pinned attestation actions
read `os.homedir()/.docker/config.json` and ignore `DOCKER_CONFIG`. Immediately before those
actions, `scripts/ci/registry-attestation-auth.mjs prepare` exposes only the job's inline GHCR
credential at that standard path. It keeps a private restoration journal in the isolated source
config directory, rejects unsafe filesystem entries and preserves any prior config bytes and mode.
The `always()` cleanup restores the standard config before deleting the source credentials; a
failed restoration fails the job and preserves the journal. This bridge is limited to disposable
GitHub-hosted publication jobs; it does not change `HOME` or relax image verification.
Verification uses the reviewed
Linux amd64 GitHub CLI pinned in `scripts/ci/github-cli.mjs`; both its release archive and binary
have fixed SHA-256 checksums. It does not replace the user's installed CLI. Download or checksum
failure stops verification.

The operator's `verify-proof` command first rechecks current private package metadata and the
exact repository binding, then checks both attestations without a local Docker daemon. An image
whose package later becomes public cannot be accepted from historical signatures alone.
It also requires successful trusted main-push `Required` and `Analyze JavaScript and TypeScript`
for the exact SHA, plus the successful current attempt of the image's publication run. A failed
rerun cannot reuse an earlier attempt's image. Manual preparation cannot substitute for main-push
checks.

## Private package provisioning and workflow access

The publication namespace is `ghcr.io/gameclubpro/major-maksimov-private-v1-COMPONENT`, for
`api`, `miniapp`, `admin` and `eraser`. Local full-SHA Docker aliases and receipt artifact names
retain their existing formats. New release proofs accept only this publication namespace.
Historical manifest readers retain both exact former `major-maksimov-COMPONENT` and
`major-maksimov-release-COMPONENT` repositories for rollback; that compatibility never authorizes
new publication or preload from an old registry record. Provisioning does not delete old packages
or change their visibility, repository binding or access settings.

Do not create packages with `GITHUB_TOKEN` from this public repository. GitHub's
[workflow-specific default visibility rule](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows)
says that packages created by a workflow token inherit repository visibility. The general
[container guide's initial private default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)
is not sufficient evidence for that workflow path. An already-public package cannot be returned
to private through ordinary settings; see the
[visibility rules](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Provisioning and workflow access are separate operations:

1. Create a dedicated classic PAT for the personal namespace owner `GameclubPro`, with
   `read:packages` and `write:packages`, without `delete:packages` or broad `repo` scope.
   Follow the [GHCR authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).
   Store it outside Git in `~/.config/maxim-delivery/ghcr-bootstrap.json`, a private regular
   `0600` file containing only `username` and `token`. Its username must be `GameclubPro`.
   This credential is separate from GitHub control access and production's read-only credential.
2. Review a local preview for each component, for example:

   ```bash
   node scripts/ci/registry-bootstrap-local.mjs --component api \
     --credential-file "$HOME/.config/maxim-delivery/ghcr-bootstrap.json"
   ```

   Preview has no network, credential reads or registry effects. Add `--apply` for the explicit
   local operation. It refuses GitHub Actions and never falls back to environment/control tokens.
   It authenticates the namespace owner against the exact source repository ID, then reads
   current package metadata. Existing private, exactly bound packages need no seed. PUBLIC,
   denied or unknown metadata refuses writes. A bounded 404 authorizes only this explicitly
   requested inert seed attempt; it does not establish absence or authorize application bytes.

3. The seed uses a temporary isolated `FROM scratch` build context with no application files,
   commands or entrypoint. Its only tag is `bootstrap-private-v1`, never a source-SHA runtime
   alias. Docker receives the credential through login stdin in a temporary private config.
   After push, positive metadata must prove `private` visibility and the exact source repository
   binding. Failure at push or a later stage may follow a write; inspect retained evidence before
   another apply. The local credential and the general default do not themselves prove privacy.
4. For all four provisioned packages, run `.github/workflows/registry-bootstrap.yml` explicitly
   from trusted `main`. This workflow uses only `packages: read` and the temporary workflow
   credential to GET metadata. It has no Docker login/build/push path. Missing packages, PUBLIC,
   denied responses, malformed metadata or a wrong binding refuse access. If needed, configure
   package Actions access to `GameclubPro/Major-Maksimov` separately, then repeat the read-only
   verification. Repository ID must be `1168895008` with the exact full name.
5. A trusted main application run independently rechecks private metadata under its publication
   credential before any application image tag/push and again afterward. Install a separate
   production credential with only `read:packages` through the guarded procedure. Neither the
   bootstrap PAT nor GitHub control token travels to production.

Neither the seed nor workflow-access result is a release image receipt. Registry delivery is
accepted only after the trusted main run publishes and verifies the tested application images,
then all receipt/provenance gates pass. Before that, a merged implementation remains distinct
from working private image delivery.

Package credentials are opaque: their prefix, punctuation and length do not prove GitHub
authority. Bootstrap, publication/proof and local/server preload use the same transport check:
1–4096 printable ASCII characters with no whitespace or control characters, passed unchanged.
The local evidence JSON still has its independent 4096-byte file budget, and the server private
file budget remains 65536 bytes. Neither file budget is a provider token format. Trusted workflow
identity, authenticated access and private package metadata with the exact repository binding
remain the authority checks.

Release image inspection failures retain every config ID, platform, source/protection label and
size check. They report `IMAGE_INSPECTION_REFUSED` with a fixed `reason` identifying the first
failed comparison. Malformed Docker JSON and incorrect inspection cardinality have separate
fixed reasons. These diagnostics omit raw Docker output, expected/actual fields and original
parse errors. A reported mismatch blocks publication or preload; it never authorizes replacing
the tested identity. Registry manifest digest and Docker config ID remain separate.

Provisioning failures report only fixed `stage` and `code` fields, separating local credential/owner
admission, registry login, metadata reads and seed build/push. Workflow-access diagnostics retain
the separate context, credential, metadata and receipt stages. They never print the
credential, environment, dependency output or raw error. A local failure at `seed-push` or a
subsequent metadata/cleanup stage can follow a registry write; inspect the retained evidence
before another apply. The workflow's receipt failure follows only a metadata read.
A diagnostic classification does not authorize publication or establish that no seed was written.

## Local package evidence credential

Local GitHub control access for dispatch and workflow observation is separate from package
evidence access. A GitHub control token without `read:packages` cannot prove private package
metadata or read private attestation subjects. Configure a separate credential at
`~/.config/maxim-delivery/ghcr-read.json`, or select its exact path with
`MAXIM_GHCR_READ_CREDENTIAL_FILE`. The file contains only
`{"username":"PACKAGE_READER","token":"READ_PACKAGES_TOKEN"}` and must be a regular file owned
by root or the current user with mode `0600`, one hard link, no symlink and a bounded valid
configuration. Its token needs `read:packages` access to all four private release packages.
Keep the token out of chat, source control, logs and ordinary GitHub control configuration.

`registry-preload.mjs` passes this credential only to its local proof-verification child as
`GH_TOKEN` and uses its validated username as `GITHUB_ACTOR`. It leaves the caller's GitHub
control client unchanged. This local file is not forwarded to production; the production pull
credential retains its separate guarded installation and path.

If the conventional default file does not exist and no explicit path is configured, existing
GitHub authentication may supply package evidence. A configured missing file, an existing empty
template, invalid credentials or unsafe file permissions fail closed; they never fall back to the
control token. Fill the private template before package verification. Even a correctly formatted
file does not establish actual package access until the metadata and attestation gates succeed.

## Missing images and deployment boundary

Component selection compares the installed manifest with the requested source. This preserves
changes from skipped releases. If the selected SHA has no required component image, preparation
can request the full CI workflow on the current main branch. Its correlation ID is persisted
before dispatch and carried in the run name; an unknown dispatch result is resolved by identity
instead of submitting again. A moved main candidate requires a new decision before runtime.

The production pull uses a separately installed read-only package credential. The operator's
GitHub control token never travels to production. The shared deploy lock, clean controller,
capacity floors, digest/config/size/label checks and image receipt all precede runtime mutation.
Normal release paths require these verified preloads and do not rebuild an absent image on the
server. Source changes, migration rules, smoke checks, role topology, rollback reader floors and
the component manifest retain their own gates. See the
[production delivery procedure](production-operations-reference.md#deploy-and-rollback).

These mechanisms do not enable automatic deployment. Durable server operations, candidate
revalidation and explicit automatic-release
activation remain separate requirements. A merged change or local fixture test alone does not
establish registry publication, installed credentials or production acceptance.

## Regression evidence

- `scripts/ci/main-baseline.test.mjs` and `green-workflow-proof.test.mjs`: accumulated scope,
  unavailable evidence, workflow identities, reruns and frozen baseline evidence.
- `scripts/ci/impact.test.mjs` and `assert-green.test.mjs`: selected lanes and exact operational gates.
- `scripts/ci/registry-images.test.mjs`: source/runner/invocation/subject rejection, process-backed
  package API failures with zero tag/push calls, private repository binding before and after
  publication and at consumption, namespace rejection, separate config/digest identities, SBOM
  proof, archive layout and permission boundaries. The projected verified metadata in
  `scripts/ci/test/registry-verified-attestations.fixture.json` covers the pinned CLI's actual
  provenance and SPDX 2.3 output; it contains no predicate body or signature bundle and does not
  replace cryptographic verification.
- `scripts/ci/registry-attestation-auth.test.mjs` and `workflow-structure.test.mjs`: the pinned
  actions' standard Docker config path, private GHCR-only exposure, safe restoration and cleanup
  after preparation failures, with real disposable filesystem entries.
- `infra/scripts/registry-preload.test.mjs` and `registry-preload-host.test.mjs`: operator preparation
  and production admission, including rejection of former namespace records.
- `infra/scripts/release-manifest.test.mjs`: current namespace provenance and continued reading
  of historical namespace manifests for rollback. Native stores and production acceptance are
  recorded separately.
