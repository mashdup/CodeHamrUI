// Shared highlight.js instance: a curated language set registered once, used
// by both the file preview and the chat's markdown code blocks. The theme CSS
// is imported here so it lands in the bundle regardless of import order.
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/github-dark.css'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import markdownLang from 'highlight.js/lib/languages/markdown'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'

for (const [name, lang] of [
  ['javascript', javascript], ['typescript', typescript], ['json', json],
  ['python', python], ['go', go], ['rust', rust], ['java', java], ['c', c],
  ['cpp', cpp], ['csharp', csharp], ['bash', bash], ['yaml', yaml], ['ini', ini],
  ['xml', xml], ['css', css], ['scss', scss], ['sql', sql], ['ruby', ruby],
  ['php', php], ['markdown', markdownLang], ['dockerfile', dockerfile],
  ['kotlin', kotlin], ['swift', swift],
] as const) {
  hljs.registerLanguage(name, lang)
}

// File extension → highlight.js language id.
export const EXT_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
  py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', sql: 'sql', rb: 'ruby',
  php: 'php', md: 'markdown', markdown: 'markdown', dockerfile: 'dockerfile',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift',
}

/** Highlight code to an HTML string, or null when the language is unknown. */
export function highlight(code: string, lang: string | undefined): string | null {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value
    } catch {
      /* fall through */
    }
  }
  return null
}

export { hljs }
