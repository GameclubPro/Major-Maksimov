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
2. Publishes to the private `ghcr.io/gameclubpro/major-maksimov-COMPONENT` package and pulls the
   returned digest to compare it with the tested config ID. An existing public package fails closed.
3. Generates an SPDX SBOM from the same local image and attests both provenance and SBOM for
   the exact registry digest through GitHub OIDC.
4. Verifies signatures and signed certificate claims for repository identity, source SHA/ref,
   workflow path/digest, allowed runner and the exact run invocation/attempt.
5. Uploads only `registry-record-COMPONENT.json` in the bounded receipt artifact
   `maxim-registry-COMPONENT-SHA-RUNID-ATTEMPT`. The SBOM is attached through its attestation.

Registry writes, OIDC and attestation permissions belong only to that publication job. Temporary
registry authentication files are private and removed after use. Verification uses the reviewed
Linux amd64 GitHub CLI pinned in `scripts/ci/github-cli.mjs`; both its release archive and binary
have fixed SHA-256 checksums. It does not replace the user's installed CLI. Download or checksum
failure stops verification.

The operator's `verify-proof` command checks both attestations without a local Docker daemon.
It also requires successful trusted main-push `Required` and `Analyze JavaScript and TypeScript`
for the exact SHA, plus the successful current attempt of the image's publication run. A failed
rerun cannot reuse an earlier attempt's image. Manual preparation cannot substitute for main-push
checks.

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

These mechanisms do not enable automatic deployment. Independent backup readback and isolated
restore, durable server operations, candidate revalidation and explicit automatic-release
activation remain separate requirements. A merged change or local fixture test alone does not
establish registry publication, installed credentials or production acceptance.

## Regression evidence

- `scripts/ci/main-baseline.test.mjs` and `green-workflow-proof.test.mjs`: accumulated scope,
  unavailable evidence, workflow identities, reruns and frozen baseline evidence.
- `scripts/ci/impact.test.mjs` and `assert-green.test.mjs`: selected lanes and exact operational gates.
- `scripts/ci/registry-images.test.mjs`: source/runner/invocation/subject rejection, private package,
  separate config/digest identities, SBOM proof, archive layout and permission boundaries.
- `infra/scripts/registry-preload.test.mjs` and `registry-preload-host.test.mjs`: operator preparation
  and production admission. Native stores and production acceptance are recorded separately.
