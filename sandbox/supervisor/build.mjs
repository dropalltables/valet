import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// ws is CommonJS and require()s Node builtins; ESM output has no `require` unless we make one.
const REQUIRE_SHIM = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

const common = {
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  // Native addon; shipped next to the bundle as node_modules/node-pty.
  external: ['node-pty'],
  banner: { js: REQUIRE_SHIM },
})

// The `valet` CLI, installed as /usr/local/bin/valet; the image's node, not whatever `env node` finds after an nvm install.
await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  banner: { js: `#!/usr/local/bin/node\n${REQUIRE_SHIM}` },
})
