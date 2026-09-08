import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'

const THEMES = { light: 'github-light', dark: 'github-dark' } as const
export type HighlightTheme = keyof typeof THEMES

const EXT_LANG: Record<string, BundledLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  mdx: 'mdx',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'fish',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  proto: 'proto',
  zig: 'zig',
  lua: 'lua',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  scala: 'scala',
  dart: 'dart',
  r: 'r',
  tf: 'terraform',
  xml: 'xml',
  svg: 'xml',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  nix: 'nix',
  prisma: 'prisma',
}

const NAME_LANG: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.gitignore': 'ini',
  '.env': 'dotenv',
}

export function languageFor(path: string): BundledLanguage | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (NAME_LANG[name]) return NAME_LANG[name]
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_LANG[name.slice(dot + 1)] ?? null
}

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return core
}

/** Highlighted HTML for `code`, or null when the language is unknown. Grammars load on first use. */
export async function highlight(code: string, path: string, theme: HighlightTheme): Promise<string | null> {
  const lang = languageFor(path)
  if (!lang) return null
  const h = await highlighter()
  if (!loaded.has(lang)) {
    const loader = bundledLanguages[lang]
    if (!loader) return null
    await h.loadLanguage(loader)
    loaded.add(lang)
  }
  return h.codeToHtml(code, { lang, theme: THEMES[theme] })
}
