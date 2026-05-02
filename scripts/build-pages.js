const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, '_site')

const files = [
  'gemeni.html',
  'renderer.js',
  'style.css',
  'sync-config.js',
  'manifest.webmanifest',
  'sw.js',
  'logo.ico',
  'logo1.png',
  'logo111.png'
]

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyFile(relativePath, targetName = relativePath) {
  const from = path.join(root, relativePath)
  const to = path.join(outDir, targetName)
  if (!fs.existsSync(from)) return
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
}

function copyDir(relativePath) {
  const from = path.join(root, relativePath)
  const to = path.join(outDir, relativePath)
  if (!fs.existsSync(from)) return
  fs.cpSync(from, to, { recursive: true })
}

function writeEnvConfig() {
  const supabaseUrl = process.env.SUPABASE_URL || ''
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || ''
  if (!supabaseUrl || !supabaseAnonKey) return false

  const content = `window.NOTEBOARD_SYNC_CONFIG = ${JSON.stringify({
    supabaseUrl,
    supabaseAnonKey
  }, null, 2)}\n`
  fs.writeFileSync(path.join(outDir, 'sync-config.js'), content)
  return true
}

rmDir(outDir)
ensureDir(outDir)
files.forEach(file => copyFile(file))
copyFile('gemeni.html', 'index.html')
copyDir('vendor')
writeEnvConfig()

console.log(`GitHub Pages site built at ${outDir}`)
