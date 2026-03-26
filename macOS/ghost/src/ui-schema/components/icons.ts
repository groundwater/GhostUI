/**
 * Resolve an icon name from the CRDT to a CSS class string.
 * Returns { class, type } where type is 'codicon', 'seti', or 'placeholder'.
 *
 * Convention: icon names map to codicons by default.
 * File-type icons (used in TreeItem, Tab) map to seti.
 */

// Names that map to seti file-type icons
const SETI_TYPES = new Set([
  'ts', 'typescript',
  'js', 'javascript',
  'json',
  'html',
  'css',
  'md', 'markdown',
  'py', 'python',
  'go',
  'rs', 'rust',
  'svg',
  'png', 'jpg', 'image',
  'folder',
  'git',
  'makefile',
  'config', 'yaml', 'toml',
])

// Map short names to seti class names
const SETI_MAP: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  png: 'image',
  jpg: 'image',
  yaml: 'config',
  toml: 'config',
}

// Map short names to codicon class names
const CODICON_MAP: Record<string, string> = {
  'files': 'files',
  'search': 'search',
  'git': 'source-control',
  'git-branch': 'git-branch',
  'debug': 'debug-alt-small',
  'extensions': 'extensions',
  'account': 'account',
  'gear': 'gear',
  'settings': 'settings-gear',
  'close': 'close',
  'plus': 'plus',
  'split': 'split-horizontal',
  'trash': 'trash',
  'maximize': 'chevron-up',
  'minimize': 'chevron-down',
  'bell': 'bell',
  'sync': 'sync',
  'error': 'error',
  'warning': 'warning',
  'feedback': 'feedback',
  'remote': 'remote',
  'refresh': 'refresh',
  'collapse-all': 'collapse-all',
  'ellipsis': 'ellipsis',
  'new-file': 'new-file',
  'new-folder': 'new-folder',
  'chevron-up': 'chevron-up',
  'chevron-down': 'chevron-down',
  'chevron-right': 'chevron-right',
  'chevron-left': 'chevron-left',
  // Outline symbols
  'constant': 'symbol-constant',
  'variable': 'symbol-variable',
  'function': 'symbol-method',
  // Settings sidebar icons
  'radio-tower': 'radio-tower',
  'plug': 'plug',
  'globe': 'globe',
  'unmute': 'unmute',
  'eye': 'eye',
  'person': 'person',
  'paintcan': 'paintcan',
  'layout': 'layout',
  'device-desktop': 'device-desktop',
  'screen-full': 'screen-full',
  'zap': 'zap',
  'hubot': 'hubot',
  'lock': 'lock',
  'shield': 'shield',
  'organization': 'organization',
  'watch': 'watch',
  'dashboard': 'dashboard',
  'mirror': 'mirror',
  'key': 'key',
  'mail': 'mail',
  'game': 'game',
  'lightbulb': 'lightbulb',
  'record': 'record',
  'info': 'info',
  'cloud-download': 'cloud-download',
  'archive': 'archive',
  'symbol-keyword': 'symbol-keyword',
  'calendar': 'calendar',
  'symbol-string': 'symbol-string',
  'broadcast': 'broadcast',
  'server': 'server',
  'history': 'history',
  'package': 'package',
  'arrow-swap': 'arrow-swap',
  'tools': 'tools',
  'pass-filled': 'pass-filled',
  'terminal': 'terminal',
  'terminal-bash': 'terminal-bash',
  'terminal-powershell': 'terminal-powershell',
}

/**
 * Returns the CSS class string for an icon name.
 * Usage: <span class=${iconClass(name)}></span>
 */
export function iconClass(name: string): string {
  if (!name) return 'icon-placeholder'

  // Check seti first (file types)
  if (SETI_TYPES.has(name)) {
    const setiName = SETI_MAP[name] || name
    return 'seti seti-' + setiName
  }

  // Check codicon map
  const codiconName = CODICON_MAP[name]
  if (codiconName) {
    return 'codicon codicon-' + codiconName
  }

  // Try as a raw codicon name (pass-through)
  return 'codicon codicon-' + name
}
