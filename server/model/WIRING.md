# Wiring the SEPIA-0 weights export

`server/model/export.ts` is complete and tested (`npx tsx server/model/_test.ts`), but nothing calls it yet. These are the only edits needed to serve:

- `GET|HEAD /api/model/weights.safetensors`: the newest saved checkpoint as safetensors. Sent as an attachment, `ETag` is the sha256, `Cache-Control: public, max-age=600`, and `If-None-Match` returns 304.
- `GET|HEAD /api/model/manifest.json`: `{ name, params, arch, vocab, ctx, version, step, loss, val, sha256, bytes, updatedAt, license, … }`, which describes exactly the file above.

Both routes read `<LUSCA_DATA>/sepia.ckpt` from disk, at most once every 10 minutes. The trainer is not touched. The anchors below are code text, not line numbers, because other work is editing these files.

## server/http.ts (4 edits)

1. Import. Add it under `import type { Auth } from './auth/auth.ts'`:

   ```ts
   import { handleModelRoute, type WeightsExporter } from './model/export.ts'
   ```

2. `interface Modules`. Add it after `chain?: HubChain`:

   ```ts
     /** SEPIA-0 weights export (server/model). Without it /api/model/* answers 503. */
     model?: WeightsExporter
   ```

3. Limiter. Add it after `const readLimit = createLimiter(…)`:

   ```ts
     const modelLimit = createLimiter(60_000, 30) // /api/model/* per address (responses are cacheable for 10 min)
   ```

4. Route. In `handleApi`, add it directly before the final `throw new HttpError(404, 'not found')` (the one after the chain block):

   ```ts
       // ── SEPIA-0 weights export: newest checkpoint as safetensors + manifest (server/model/export.ts) ──
       if (p.startsWith('/api/model/')) {
         const m = requireModules()
         if (!m.model) throw new HttpError(503, 'the weights export is not available on this server')
         if (await handleModelRoute(p, req, res, { exporter: m.model, take: (r) => modelLimit.take(clientIp(r)) })) return
       }
   ```

   `handleModelRoute` handles methods itself: GET and HEAD, anything else gets 405 with `Allow: GET, HEAD`. It also writes its own 429 and 503 replies, so this block needs no `allow([...])` call. For any other `/api/model/*` path it returns `false` and the request falls through to the 404.

## server/index.ts (3 edits)

1. Import. Add it under `import { createChainAgents } from './chain/index.ts'`:

   ```ts
   import { createWeightsExporter } from './model/export.ts'
   ```

2. Exporter. Add it directly before `const modules = { crawler, trainer, … }`:

   ```ts
     // SEPIA-0 public weights (GET /api/model/weights.safetensors, /api/model/manifest.json), rebuilt from
     // <LUSCA_DATA>/sepia.ckpt at most every 10 min. LUSCA_WEIGHTS_LICENSE sets the license field (default MIT).
     const modelExport = createWeightsExporter({
       ckptPath: path.join(DATA_DIR, 'sepia.ckpt'),
       license: process.env.LUSCA_WEIGHTS_LICENSE?.trim() || 'MIT',
       log: (level, msg) => log[level]('model', msg),
     })
   ```

3. Modules. Add `model: modelExport`:

   ```ts
     const modules = { crawler, trainer, coordinator, auth, payouts, code: codeIndex, chain: chainAgents, model: modelExport }
   ```

## Optional

- `package.json` `test` script: append `&& tsx server/model/_test.ts && tsx scripts/hf/_test.mjs`. The first test also runs the real trainer for about 10 s to check its checkpoint format. Pass `--no-trainer` to skip that part.
- `render.yaml`: `LUSCA_WEIGHTS_LICENSE` is needed only if the weights license changes from MIT.
- README API table: add the two routes.

## Check after wiring

```bash
curl -sI http://127.0.0.1:8787/api/model/weights.safetensors   # 200, ETag "<sha256>", attachment; filename="sepia-0-step-<N>.safetensors"
curl -s  http://127.0.0.1:8787/api/model/manifest.json         # sha256 equals the ETag above
curl -s  -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "<sha256>"' http://127.0.0.1:8787/api/model/weights.safetensors   # 304
```

A server that has never saved a checkpoint answers 503 with `Retry-After: 60`. The trainer saves every 90 s.

## Hugging Face release flow (uses the routes once deployed)

Target: the user account `LUSCAINK`, repo https://huggingface.co/LUSCAINK/SEPIA-0 (the default of both scripts). Each upload is tagged `step-<N>`, with N the optimizer step in the folder's `config.json`.

```bash
OUT="$(mktemp -d)/SEPIA-0"
# 1. build from the LIVE export: the README numbers, sample and config come from this manifest
node scripts/hf/build-release.mjs \
  --manifest-url https://lusca.ink/api/model/manifest.json \
  --weights-url  https://lusca.ink/api/model/weights.safetensors \
  --repo LUSCAINK/SEPIA-0 --out "$OUT"
# 2. numerical check: inference.py and sample.mjs logits vs shared/sepia/model.mjs (≤ 1e-5), encode, seeded generation
node scripts/hf/verify-release.mjs --dir "$OUT"
# 3. the exact request plan (no token needed); user namespace → create body has no "organization"
STEP=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).step" "$OUT/config.json")
node scripts/hf/upload.mjs --dir "$OUT" --user LUSCAINK --tag "step-$STEP" --dry-run
# 4. upload with a write token for LUSCAINK (read from the environment only, never printed)
HF_TOKEN=hf_… node scripts/hf/upload.mjs --dir "$OUT" --user LUSCAINK --tag "step-$STEP"
```

`--tag auto` is the same as `--tag step-$STEP`. A tag that does not match `config.json` is refused. If the server switches to a newer checkpoint between the manifest and weights requests, `build-release` fetches both again (3 attempts), so a folder never mixes two steps. `--from https://lusca.ink` is shorthand for the two URLs. On Node < 22.18, prefix the build and verify commands with `npx tsx`.

Before deploying, `--ckpt <path to sepia.ckpt>` builds the same folder from a checkpoint file. The weights are byte-identical to what the route serves for that checkpoint. A folder built this way is a preview only. Publish from the live manifest.
