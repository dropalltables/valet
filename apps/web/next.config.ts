import type { NextConfig } from 'next'
import path from 'node:path'

/**
 * Built with webpack (`next build --webpack`), not Turbopack: `@valet/shared` is
 * consumed as TypeScript source and uses NodeNext-style `./x.js` specifiers,
 * which Turbopack only maps to `.ts` when the app's own tsconfig is NodeNext.
 * webpack does it through `extensionAlias`.
 */
const config: NextConfig = {
  output: 'standalone',
  agentRules: false,
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  transpilePackages: ['@valet/shared'],
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
}

export default config
