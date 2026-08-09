# Refactor Notes

Packaging targets for liminal-memory as a small library that works both in a bundler and from a
plain `<script>` tag.

## Do

- `"type": "module"`, ESM source shipped in `src/`.
- `exports` map with `types` / `import` / `default`, plus `"./package.json"`.
- Two bundles: `dist/liminal-memory.esm.js` (`--format=esm`) and `dist/liminal-memory.min.js`
  (`--format=iife --global-name=LiminalMemory`).
- `unpkg` / `jsdelivr` / `browser` → the IIFE bundle, so a CDN script tag works with no install.
- Generate `.d.ts` from the existing JSDoc (`tsc --declaration --emitDeclarationOnly --allowJs`).
  Hand-written declarations drift and nothing catches it.
- `prepublishOnly: npm test && npm run build`.
- `"publishConfig": {"access": "public"}`.
- Publish from CI with npm provenance.

## Don't

- No `window.LiminalMemory = ...` in `src/`. `--global-name` already does it for the IIFE build,
  and in source it ships to bundler users who never asked for it. It is also deletable under
  `"sideEffects": false`, so behavior varies by bundler.
- Don't commit `dist/` (currently committed in d5743ae). Gitignore it and build at publish time.