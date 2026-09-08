import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Bundle the workspace package (TypeScript source, not runnable as-is); keep npm deps external.
const external = Object.keys(pkg.dependencies).filter((name) => name !== '@valet/shared')

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external,
  sourcemap: true,
  logLevel: 'info',
})
