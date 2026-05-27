# Noteboard / 视觉白板

**English** | [中文](#chinese)

A visual whiteboard for notes, links, video transcripts, and collaborative ideas.
一款集笔记、链接、视频转录与协作于一体的视觉白板。

---

## <a id="chinese"></a>中文

### 功能

- **丰富的卡片类型** — 笔记、链接、待办、标题、看板、列、表格、评论、字幕、音频、地图、视频
- **手绘** — 基于 perfect-freehand 的自然笔触
- **视频嵌入** — YouTube & Bilibili，支持 Cookie 注入登录回放
- **树形视图** — 以层级树浏览和管理卡片
- **多端同步** — 基于 Supabase 的跨设备同步（桌面 ↔ 手机网页）
- **PWA** — 可作为手机应用安装，支持离线缓存

### 桌面端启动

```bash
npm install
npm start
```

### 网页部署 (GitHub Pages)

搭配 Supabase 同步部署：

1. 创建 Supabase 项目，执行 [supabase/schema.sql](supabase/schema.sql)
2. 在 GitHub → Settings → Secrets and variables → Actions 中设置仓库变量 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`
3. 推送到 `master` 分支，GitHub Actions 自动构建并部署

### 技术栈

- Electron（桌面端）
- 原生 JS + CSS（无框架）
- Supabase（同步后端）
- perfect-freehand（手绘）
- GitHub Actions + Pages（CI/CD）

---

## English

### Features

- **Rich card types** — Note, Link, To-do, Title, Board, Column, Table, Comment, Caption, Audio, Map, Video
- **Freehand drawing** — Sketch with natural strokes via perfect-freehand
- **Video embedding** — YouTube & Bilibili with cookie injection for logged-in playback
- **Tree view** — Navigate and organize cards hierarchically
- **Sync** — Cross-device sync via Supabase (desktop ↔ mobile web)
- **PWA** — Installable as a mobile web app with offline cache

### Desktop

```bash
npm install
npm start
```

### Web Deployment (GitHub Pages)

Deploy with Supabase sync:

1. Create a Supabase project and run [supabase/schema.sql](supabase/schema.sql)
2. Set repository variables `SUPABASE_URL` and `SUPABASE_ANON_KEY` in GitHub → Settings → Secrets and variables → Actions
3. Push to `master` — GitHub Actions builds and deploys automatically

### Tech Stack

- Electron (desktop)
- Vanilla JS + CSS
- Supabase (sync backend)
- perfect-freehand (drawing)
- GitHub Actions + Pages (CI/CD)

---

## License / 许可证

ISC
