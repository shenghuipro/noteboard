const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')

const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
const VIDEO_PARTITION = 'persist:noteboard-videos'
const EMBED_APP_ORIGIN = 'https://noteboard.local'
const COOKIE_DOMAINS = {
  bilibili: ['.bilibili.com'],
  youtube: ['.youtube.com', '.google.com']
}

let localAppServer = null
let localAppOrigin = ''

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

function startLocalAppServer() {
  if (localAppServer && localAppOrigin) return Promise.resolve(localAppOrigin)

  const rootDir = path.resolve(__dirname)
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        let pathname = decodeURIComponent(url.pathname)
        if (pathname === '/youtube-player.html') {
          const videoId = url.searchParams.get('id') || ''
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Bad YouTube video id')
            return
          }
          const host = url.searchParams.get('host') === 'nocookie' ? 'www.youtube-nocookie.com' : 'www.youtube.com'
          const embedParams = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', enablejsapi: '1' })
          if (localAppOrigin) embedParams.set('origin', localAppOrigin)
          const start = url.searchParams.get('start')
          if (/^\d+$/.test(start || '')) embedParams.set('start', start)
          const embedUrl = `https://${host}/embed/${videoId}?${embedParams.toString()}`
          const escapedEmbedUrl = embedUrl.replace(/&/g, '&amp;')
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          })
          res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin"><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:#000}</style></head><body><iframe id="player" src="${escapedEmbedUrl}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe><script>window.addEventListener('message',function(event){var frame=document.getElementById('player');if(frame&&frame.contentWindow)frame.contentWindow.postMessage(event.data,'*');});</script></body></html>`)
          return
        }
        if (pathname === '/') pathname = '/gemeni.html'
        const filePath = path.resolve(rootDir, `.${pathname}`)
        if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Forbidden')
          return
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
          })
          res.end(data)
        })
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Bad request')
      }
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      localAppServer = server
      localAppOrigin = `http://127.0.0.1:${server.address().port}`
      resolve(localAppOrigin)
    })
  })
}

function openExternalUrl(url) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return false
  shell.openExternal(target)
  return true
}

function isBilibiliUrl(url) {
  try {
    const host = new URL(url).hostname
    return /(\.|^)bilibili\.com$/i.test(host)
  } catch {
    return false
  }
}

function isBilibiliMediaHost(host) {
  return /(\.|^)(bilibili|bilivideo|hdslb)\.(com|cn)$/i.test(host)
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=')
      if (eq <= 0) return null
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() }
    })
    .filter(Boolean)
}

function getCookieUrl(cookie) {
  const host = (cookie.domain || '').replace(/^\./, '')
  const protocol = cookie.secure ? 'https://' : 'http://'
  return `${protocol}${host || 'bilibili.com'}${cookie.path || '/'}`
}

function normalizeSameSite(value) {
  return ['unspecified', 'no_restriction', 'lax', 'strict'].includes(value) ? value : undefined
}

async function setCookieObject(targetSession, cookie) {
  if (!cookie?.name) return false
  const details = {
    url: getCookieUrl(cookie),
    name: cookie.name,
    value: cookie.value || '',
    path: cookie.path || '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly
  }
  if (cookie.domain) details.domain = cookie.domain
  if (Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate
  const sameSite = normalizeSameSite(cookie.sameSite)
  if (/bilibili\.com|youtube\.com|google\.com/i.test(cookie.domain || '') && details.secure) {
    details.sameSite = 'no_restriction'
  } else if (sameSite) {
    details.sameSite = sameSite
  }
  await targetSession.cookies.set(details)
  return true
}

async function mirrorCookieObjects(cookies, targetSessions) {
  let copied = 0
  for (const cookie of cookies || []) {
    for (const targetSession of targetSessions) {
      await setCookieObject(targetSession, cookie).then(ok => { if (ok) copied += 1 }).catch(() => {})
    }
  }
  return copied
}

async function setCookiesForSite(site, cookieHeader) {
  const domains = COOKIE_DOMAINS[site] || []
  const cookies = parseCookieHeader(cookieHeader)
  const targetSessions = [session.defaultSession, session.fromPartition(VIDEO_PARTITION)]
  for (const cookie of cookies) {
    for (const domain of domains) {
      for (const targetSession of targetSessions) {
        await targetSession.cookies.set({
          url: `https://${domain.replace(/^\./, '')}`,
          domain,
          name: cookie.name,
          value: cookie.value,
          path: '/',
          secure: true,
          sameSite: 'no_restriction'
        }).catch(() => {})
      }
    }
  }
  return cookies.length
}

async function clearCookiesForSite(site) {
  const domains = COOKIE_DOMAINS[site] || []
  const targetSessions = [session.defaultSession, session.fromPartition(VIDEO_PARTITION)]
  let removed = 0
  for (const domain of domains) {
    for (const targetSession of targetSessions) {
      const list = await targetSession.cookies.get({ domain }).catch(() => [])
      for (const cookie of list) {
        const protocol = cookie.secure ? 'https://' : 'http://'
        const host = (cookie.domain || '').replace(/^\./, '')
        await targetSession.cookies.remove(`${protocol}${host}${cookie.path || '/'}`, cookie.name).then(() => { removed += 1 }).catch(() => {})
      }
    }
  }
  if (site === 'youtube') {
    const origins = [
      'https://www.youtube.com',
      'https://youtube.com',
      'https://www.youtube-nocookie.com',
      'https://youtube-nocookie.com',
      'https://accounts.google.com'
    ]
    const storages = ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage']
    for (const targetSession of targetSessions) {
      for (const origin of origins) {
        await targetSession.clearStorageData({ origin, storages }).catch(() => {})
      }
    }
  }
  return removed
}

function setRequestHeader(headers, name, value) {
  const existing = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  headers[existing || name] = value
}

function getYouTubeEmbedReferer(requestUrl) {
  return `${EMBED_APP_ORIGIN}/`
}

function parseCookieHeaderNames(cookieHeader) {
  const names = new Set()
  String(cookieHeader || '').split(';').forEach(part => {
    const eq = part.indexOf('=')
    if (eq > 0) names.add(part.slice(0, eq).trim())
  })
  return names
}

function appendCookieHeader(existingHeader, cookies) {
  const existingNames = parseCookieHeaderNames(existingHeader)
  const merged = String(existingHeader || '').trim()
  const extra = []
  for (const cookie of cookies || []) {
    if (!cookie?.name || existingNames.has(cookie.name)) continue
    existingNames.add(cookie.name)
    extra.push(`${cookie.name}=${cookie.value || ''}`)
  }
  return [merged, extra.join('; ')].filter(Boolean).join('; ')
}

async function getBilibiliCookieHeader(targetSession, requestUrl) {
  const sessions = [targetSession, session.defaultSession, session.fromPartition(VIDEO_PARTITION)]
  const seenSessions = new Set()
  const cookiesByName = new Map()
  for (const sourceSession of sessions) {
    if (!sourceSession || seenSessions.has(sourceSession)) continue
    seenSessions.add(sourceSession)
    const matches = await sourceSession.cookies.get({ url: requestUrl }).catch(() => [])
    const fallback = await sourceSession.cookies.get({ domain: '.bilibili.com' }).catch(() => [])
    for (const cookie of matches.concat(fallback)) {
      if (cookie?.name && !cookiesByName.has(cookie.name)) cookiesByName.set(cookie.name, cookie)
    }
  }
  return Array.from(cookiesByName.values())
}

function installMediaRequestHeaders(targetSession) {
  targetSession.webRequest.onBeforeRequest({ urls: ['*://www.bilibili.com/video/*'] }, (details, callback) => {
    callback({ cancel: details.resourceType === 'subFrame' || details.resourceType === 'mainFrame' })
  })

  const filter = {
    urls: [
      '*://*.bilibili.com/*',
      '*://*.bilivideo.com/*',
      '*://*.bilivideo.cn/*',
      '*://*.hdslb.com/*',
      '*://*.youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://*.googlevideo.com/*'
    ]
  }
  let cachedBiliCookies = []
  let cachedBiliCookieAt = 0
  targetSession.webRequest.onBeforeSendHeaders(filter, async (details, callback) => {
    const headers = { ...details.requestHeaders }
    try {
      const requestUrl = new URL(details.url)
      const host = requestUrl.hostname
      const currentRefererKey = Object.keys(headers).find(key => key.toLowerCase() === 'referer')
      const currentReferer = currentRefererKey ? String(headers[currentRefererKey] || '') : ''
      if (isBilibiliMediaHost(host)) {
        if (!currentReferer || currentReferer.startsWith('file://')) {
          setRequestHeader(headers, 'Referer', 'https://www.bilibili.com/')
        }
        if (/(\.|^)bilibili\.com$/i.test(host) && Date.now() - cachedBiliCookieAt > 2000) {
          cachedBiliCookies = await getBilibiliCookieHeader(targetSession, details.url)
          cachedBiliCookieAt = Date.now()
        }
        if (/(\.|^)bilibili\.com$/i.test(host)) {
          const cookieKey = Object.keys(headers).find(key => key.toLowerCase() === 'cookie') || 'Cookie'
          const cookieHeader = appendCookieHeader(headers[cookieKey], cachedBiliCookies)
          if (cookieHeader) headers[cookieKey] = cookieHeader
        }
      } else if (/(\.|^)(youtube|youtube-nocookie)\.com$/i.test(host) || /(\.|^)googlevideo\.com$/i.test(host)) {
        setRequestHeader(headers, 'User-Agent', DESKTOP_USER_AGENT)
        if (!currentReferer || currentReferer.startsWith('file://') || /^http:\/\/127\.0\.0\.1:/i.test(currentReferer)) {
          setRequestHeader(headers, 'Referer', getYouTubeEmbedReferer(requestUrl))
        }
      }
    } catch {}
    callback({ requestHeaders: headers })
  })
}

async function fetchBilibiliJson(url) {
  const cookies = await getBilibiliCookieHeader(session.defaultSession, url)
  const cookieHeader = appendCookieHeader('', cookies)
  const res = await fetch(url, {
    headers: {
      'User-Agent': DESKTOP_USER_AGENT,
      Referer: 'https://www.bilibili.com/',
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }
  })
  if (!res.ok) throw new Error(`Bilibili playurl HTTP ${res.status}`)
  return res.json()
}

async function getBilibiliDirectPlayUrl({ bvid, aid, cid, qn = 80 }) {
  if (!cid) throw new Error('缺少 B站 cid')
  const params = new URLSearchParams({
    cid: String(cid),
    qn: String(qn),
    otype: 'json',
    platform: 'html5',
    high_quality: '1',
    fourk: '1',
    fnval: '0'
  })
  if (bvid) params.set('bvid', String(bvid))
  else if (aid) params.set('avid', String(aid))
  else throw new Error('缺少 B站 bvid/aid')

  const apiUrl = `https://api.bilibili.com/x/player/playurl?${params.toString()}`
  const json = await fetchBilibiliJson(apiUrl)
  const data = json.data || json.result || {}
  const durl = Array.isArray(data.durl) ? data.durl : []
  const stream = durl.find(item => item.url) || null
  if (!stream) throw new Error(json.message || 'B站没有返回可直连 MP4 流')
  return {
    url: stream.url,
    backupUrls: stream.backup_url || stream.backupUrl || [],
    quality: data.quality || qn,
    acceptQuality: data.accept_quality || [],
    acceptDescription: data.accept_description || [],
    format: data.format || ''
  }
}

function createWindow () {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    icon: path.join(__dirname, 'logo.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false
    }
  })

  win.webContents.setUserAgent(DESKTOP_USER_AGENT)
  win.loadFile('gemeni.html')
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isBilibiliUrl(url)) return { action: 'deny' }
    openExternalUrl(url)
    return { action: 'deny' }
  })
}

// 通用登录窗口工厂：打开登录页 → 用户登录 → 关闭 → 返回 cookies
function openLoginWindow(url, cookieDomains, title, partition = null) {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1024,
      height: 720,
      title: title,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(partition ? { partition } : {})
      }
    })

    loginWin.webContents.setUserAgent(DESKTOP_USER_AGENT)
    loginWin.loadURL(url)
    loginWin.setMenuBarVisibility(false)

    loginWin.on('closed', async () => {
      try {
        let allCookies = []
        for (const domain of cookieDomains) {
          const cookieSession = partition ? session.fromPartition(partition) : session.defaultSession
          const list = await cookieSession.cookies.get({ domain })
          allCookies = allCookies.concat(list)
        }
        if (partition) {
          await mirrorCookieObjects(allCookies, [session.defaultSession, session.fromPartition(partition)])
        }
        resolve(allCookies)
      } catch (e) {
        resolve([])
      }
    })
  })
}

// B站登录
ipcMain.handle('bilibili-login', () => {
  return openLoginWindow(
    'https://passport.bilibili.com/login',
    COOKIE_DOMAINS.bilibili,
    'B站登录 — 扫码或输入账号密码',
    VIDEO_PARTITION
  )
})

// YouTube 登录
ipcMain.handle('youtube-login', () => {
  openExternalUrl('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F')
  return { external: true }
})

ipcMain.handle('open-external-url', (_event, url) => {
  return openExternalUrl(url)
})

ipcMain.handle('get-local-player-origin', () => {
  return localAppOrigin
})

ipcMain.handle('set-site-cookies', (_event, site, cookieHeader) => {
  return setCookiesForSite(site, cookieHeader)
})

ipcMain.handle('clear-site-cookies', (_event, site) => {
  return clearCookiesForSite(site)
})

ipcMain.handle('bilibili-play-url', (_event, payload) => {
  return getBilibiliDirectPlayUrl(payload || {})
})

app.whenReady().then(async () => {
  await startLocalAppServer()
  app.userAgentFallback = DESKTOP_USER_AGENT
  session.defaultSession.setUserAgent(DESKTOP_USER_AGENT)
  session.fromPartition(VIDEO_PARTITION).setUserAgent(DESKTOP_USER_AGENT)
  installMediaRequestHeaders(session.defaultSession)
  installMediaRequestHeaders(session.fromPartition(VIDEO_PARTITION))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (localAppServer) localAppServer.close()
})
