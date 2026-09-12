# WeChat ClawBot $\leftrightarrow$ Antigravity Agent Bridge

把手机微信官方 **微信 ClawBot** 与本机 Linux 上的 **反重力 Agent（Antigravity CLI: agy）** 无缝连接。

## 功能特性

- **双向实时交互**：在手机微信聊天框里发消息，本机 Linux 上的反重力 Agent 自动执行并回传报告。
- **实时执行进度感知（零多余Token）**：采用 `stream-json` 底层事件流，关键动作（跑命令、改代码、读文件）与 15s 阶段心跳实时推送至微信，告别长任务盲等黑盒。
- **语音转写无缝支持**：支持微信语音消息转文字（`voice_item.text`）自动识别并执行。
- **共享技能与上下文**：复用反重力 IDE 中的所有自定义技能（Skills）、规则与模型配置。
- **安全白名单拦截**：仅允许扫码绑定的微信号下发指令，外人无法调用。
- **快捷指令与远程控制**：
  - `/status` 或发送 “进度”：空闲时查看系统资源与工作区；**任务运行时直接查看实时执行进度与当前动作快照**。
  - `/abort` 或发送 “终止”：**随时远程强制掐断正在运行中的 Agent 任务**。
  - `/cd <路径>`：手机直接切换电脑上的执行目录。
  - `/new`：清空会话上下文，开始全新任务。
  - `/help`：获取指令说明。

---

## 快速使用

### 1. 首次扫码绑定（仅需一次）

```bash
cd /path/to/wechat-agy-bridge
npm install
npm run login
```

终端会打印出二维码（并附带图片链接），使用手机微信扫码并点击【确认登录】即可。

### 2. 启动服务

```bash
npm start
```

---

## 后台常驻运行（推荐使用 Systemd 用户服务）

如果你希望这台电脑开机或登录后自动在后台常驻运行，可以配置为 systemd 用户服务：

```bash
mkdir -p ~/.config/systemd/user
cat << 'SERVICE' > ~/.config/systemd/user/wechat-agy-bridge.service
[Unit]
Description=WeChat Antigravity Agent Bridge
After=network.target

[Service]
Type=simple
# 注意：请将 WorkingDirectory 替换为你本机的项目实际绝对路径（%h 会自动展开为当前用户家目录）
WorkingDirectory=%h/wechat-agy-bridge
ExecStart=/usr/bin/node src/daemon.mjs
Restart=always
RestartSec=5
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
SERVICE

# 启用并立即启动服务
systemctl --user daemon-reload
systemctl --user enable --now wechat-agy-bridge.service

# 查看运行状态
systemctl --user status wechat-agy-bridge.service
```
