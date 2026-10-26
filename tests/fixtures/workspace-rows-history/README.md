# Historical source-only fixtures

See [the reproducibility contract](../../../docs/engineering/workspace-rows-reproducible-validation.md).

- `<profile>.json`: exact path-to-SHA-256 closure, original entrypoints, package
  imports, provenance and embedded build identity. Not complete Git commits.
- `file-records.json`: deduplicated old byte length/Git blob/import edges; each
  profile hash-binds this catalog. `repository` means verify the old hash before
  reusing a current path; `blob` means use the immutable old text below.
- `blobs/*.txt`: 15 unique original implementation files, no compiled output.
- `composition.json`: original integration provenance plus exact original and
  accepted source hashes. Later changes require review, never an automatic bypass.

No repository LICENSE file was present in the historical source trees. These are
same-repository fixtures and make no new license grant. External dependencies
are not vendored and retain their own licensing. No production/runtime evidence,
private Git history, credentials or real user data is included.
