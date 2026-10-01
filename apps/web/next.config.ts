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
  experimental: {
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    // Idle timeout on proxied responses; the default 30 s cuts off long polling and
    // quiet SSE streams behind services. The schema rejects null, so use the largest
    // value Node's socket timeout accepts.
    proxyTimeout: 2 ** 31 - 1,
    // Next buffers request bodies that pass through proxy.ts and truncates them at
    // this size (default 10 MB), which breaks uploads to service apps.
    proxyClientMaxBodySize: '256mb',
  },
}

export default config
