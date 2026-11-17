# IPTV 管理台

安装 Node.js 22 或更新版本。在项目目录执行：

```sh
npm ci
npm start
```

Windows PowerShell 可以使用 `npm.cmd ci` 和 `npm.cmd start`。
本机访问 http://localhost:8787，局域网内使用运行服务的设备地址和端口。

- **频道与线路**可以编辑分组、台标、组播地址和线路 FCC。多条线路要使用不同标签。
- **设置**可以管理多个 XMLTV 源（`.xml` 或 `.xml.gz`），手动刷新单个或全部源，并设置默认 FCC。EPG 每天北京时间 00:15、08:15、16:15 自动刷新，服务重启后会继续使用上次成功的缓存。
- **频道编辑**可以按节目单频道名或 ID 搜索，从对应来源选择映射。

## 接口

- `/playlist.m3u` 用作 rtp2httpd 的 `external-m3u`。加 `?download=1` 可下载文件。
- `/epg.xml` 提供已关联频道的合并节目单，由 M3U 自动引用。仅配置一个源且首次刷新尚未成功时，M3U 暂时引用该源的原始地址。

播放列表基于请求所用的主机地址生成 EPG 和上传台标链接。给其他设备下载或订阅时，请通过局域网可访问的地址打开管理台。反向代理部署可设置 `PUBLIC_BASE_URL` 为对外访问的 HTTP(S) 地址。

## 迁移到 FNOS

复制项目文件及 `data/` 到 NAS，在 NAS 的项目目录重新运行 `npm ci`、`npm start`。频道配置在 `data/settings.json`，EPG 缓存在 `data/epg/`。把 rtp2httpd 的外部列表地址改为 NAS 地址加 `/playlist.m3u`。

可通过 `PORT` 设置监听端口，默认 8787。可通过 `DATA_DIR` 指定数据目录。

## FNOS 安装包与发布

从 [GitHub Releases](https://github.com/shwhy1998/IPTV/releases) 下载 `IPTV-<版本>-fnOS.fpk`，在飞牛应用中心选择「手动安装」。安装包会使用 NAS 上已安装的 Node.js v22 或更新版本。请从飞牛应用中心安装一个符合要求的版本。IPTV 提供桌面入口及启停管理，默认端口为 8787。把 rtp2httpd 的外部 M3U 地址指向 `http://NAS地址:8787/playlist.m3u`。

安装包首次启动会创建自己的数据目录。迁移电脑上的频道配置时，先停止 NAS 上的应用，把本地 `data/` 内容复制到 FNOS 为应用提供的 `TRIM_PKGVAR/data/`，保留应用用户的读写权限，再启动。升级时应用继续使用该数据目录。

合入 `main` 的应用源码、依赖和打包配置变更会触发 GitHub Actions。首版为 `1.0.0`，之后按工作流运行编号递增补丁版本，构建失败可能跳号。仅修改 `logo/` 或文档不触发打包。
