#!/bin/sh
# 微信读书专用 Chrome 实例（weread-mp-fetcher 的数据通道）。
#   - 独立 profile：~/.weread-mp-fetcher/chrome-profile，只登录微信读书，
#     与日常浏览器完全隔离（日常 Chrome 里的会话与它互不可见）。
#   - 调试端口 9333 只听 127.0.0.1。不用 9222：它是事实默认端口，极易被占，
#     且端口冲突不报错（静默退到 IPv6）。
# 用法: screen -dmS wereadchrome sh /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher/start-chrome.sh
# 同一 profile 同时只能有一个 Chrome 进程；重跑前确认旧实例已退出，
# 否则新参数会被静默忽略。（dsh-wx-daily 插件在采集时也会自动拉起本脚本，
# 因此 DISPLAY 缺省兜底 :0，让 SSH 会话里跑也能开窗口。）
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
export DISPLAY="${DISPLAY:-:0}"
exec /opt/google/chrome/chrome \
  --ozone-platform=x11 \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.weread-mp-fetcher/chrome-profile" \
  --no-first-run --no-default-browser-check \
  about:blank
