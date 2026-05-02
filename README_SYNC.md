# Noteboard 手机同步部署

这个项目现在支持两种入口：

- 桌面端：继续用 `npm start` 启动 Electron。
- 手机端：用 GitHub Pages 部署网页/PWA，然后输入同步码同步同一块白板。

同步后端使用 Supabase。同步码相当于访问密码，拿到同步码的人可以读取和覆盖这块白板。

## 1. 创建 Supabase 项目

1. 打开 Supabase，创建一个新项目。
2. 进入 `SQL Editor`。
3. 粘贴并执行 [supabase/schema.sql](supabase/schema.sql) 的全部内容。
   如果之前执行不完整，或遇到 schema cache / function not found / table not found，可以直接执行 [supabase/repair-schema-cache.sql](supabase/repair-schema-cache.sql)。
4. 进入 `Project Settings` -> `API`，复制：
   - `Project URL`
   - `anon public key`

## 2. 配置本地桌面端同步

编辑 [sync-config.js](sync-config.js)：

```js
window.NOTEBOARD_SYNC_CONFIG = {
  supabaseUrl: 'https://vxazdgkjqmjrartucdfg.supabase.co',
  supabaseAnonKey: 'sb_publishable_W8N1STmOj6PpjErEoY6ing_6WFEiTMy'
}
```

然后重新 `npm start`。

在应用右上角 `选项` -> `同步码`：

1. 点击 `创建同步码`。
2. 复制同步码。
3. 桌面端会继续本地保存，同时自动上传快照到 Supabase。

## 3. 配置 GitHub Pages 手机端

把代码推到 GitHub 后，在仓库里做这几步：

1. 进入 `Settings` -> `Pages`。
2. Source 选择 `GitHub Actions`。
3. 进入 `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`。
4. 添加两个 Repository variables：
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
5. 推送到 `main` 分支，GitHub Actions 会自动部署。

部署完成后，手机打开 Pages 地址，例如：

```text
https://你的用户名.github.io/noteboard/
```

进入 `选项` -> `同步码`，输入桌面端创建的同步码，点击 `加入同步码`。

## 4. 手动构建网页版本

如果你想先本地看生成结果：

```bash
npm run build:pages
```

生成目录是 `_site/`。GitHub Pages workflow 也会用同一个命令。

## 5. 当前同步规则

- 本地仍然保存到浏览器/Electron 的 `localStorage`。
- 云端保存整份白板 JSON 快照。
- 自动保存后会延迟约 1.2 秒上传。
- 每 30 秒检查一次云端是否有更新。
- 如果云端和本地同时改动，默认会提示冲突；你可以选择先拉取，或点击 `上传覆盖`。

## 6. 手机端限制

手机浏览器可以使用白板、笔记、卡片、同步和基础编辑。

受浏览器限制，以下能力和桌面 Electron 不完全一样：

- YouTube/Bilibili 的登录 Cookie 注入。
- 本地文件系统能力。
- 某些拖拽手势在手机上会比桌面弱。
