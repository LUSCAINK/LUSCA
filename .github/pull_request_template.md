## What changed

<!-- One topic per pull request. Link the issue it addresses, if any (e.g. "Closes #12"). -->

## Why

## How it was checked

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Checked in a browser at desktop and phone widths (for UI changes)
- [ ] Ran a neuron against a local server (for protocol, neuron or SEPIA changes)

## Checklist

- [ ] Wire protocol changes (`shared/protocol.ts`) are backward compatible (if any)
- [ ] Constants quoted in the manual are updated in `src/components/docs/facts.ts` (if any changed)
- [ ] No secrets, keypairs, `.env` files or `server/data/` contents are included
