# Server upgrade fixture producer

The upgrade gate generates this fixture at test time; the durable tree is intentionally not checked in because it contains generated Git object IDs and ephemeral transfer IDs.

- **Producer:** `aaad5ad25945ba68c51a9286e2113b59b7ff33d9`
- **Deployment provenance:** infra history shows this was the OBTS server producer deployed immediately before `ec774a72f1d620317913cd04075695f233aa1b8f`; the `0.4.36` tag is not used as a producer claim.
- **Generator:** `scripts/generate-upgrade-fixture.mjs`
- **Gate command:** `npm run test:upgrade-compat`

The generator starts the built server only to create a valid canonical metadata/Git baseline, then emits the prior writer's durable transition:

1. Two active vaults and devices are written into canonical metadata, each with a valid Git root.
2. The legacy vault receives a valid one-chunk transfer session and repository.
3. The ownership marker is removed because the producer did not write `owner.json`.
4. `stored_bytes` is set to the prior writer's complete directory-byte result: transfer material plus the pre-chunk `session.json` size. The current writer's state-file exclusion therefore has to repair it.
5. `phase1.json.4242.1700000000000.tmp` is added as interrupted legacy metadata residue.
6. A deterministic descendant commit and thin Git pack are generated for the healthy device's later upload.

The generated output contains `descriptor.json`, `checksums.sha256`, `data/`, and `upload.pack`. The descriptor records the producer SHA, durable artifact paths, synthetic device tokens, roots, transfer ID, and expected repaired byte count. Tokens and generated state exist only in the temporary test directory and are never logged or checked in.

For a direct generator run after `npm run build`:

```sh
node scripts/generate-upgrade-fixture.mjs /tmp/obts-upgrade-fixture
```
