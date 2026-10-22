# 网站拦截器 · 专注守护

一个 Tampermonkey 油猴脚本。把指定网站整页拦下来，想放行得等倒计时、写一句理由，并记进日志。分组可以设成「全程拦 / 只在指定时段拦 / 强制不放行」。

## 安装

1. 浏览器装好 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）
2. 点这个链接安装脚本：`https://raw.githubusercontent.com/KhalilYe050113/focus-blocker/main/blocker.user.js`
3. 装好后打开任意网站，油猴菜单里能看到「拦截当前网站」就算成功

手动安装：新建脚本 → 粘贴 `blocker.user.js` 全文 → Ctrl+S。

## 它做什么

- 命中黑名单的页面在开始加载时就被整页替换，不闪原网站，`window.stop()` 会中止后续资源
- 普通规则：等 10 秒 + 写理由 → 放行 5 分钟，覆盖命中规则的范围（域名规则含所有子域，路径规则只放该路径），跨标签页共享，到期自动刷新回拦截页
- 强制分组：拦截页没有放行入口，白名单、放行凭证、暂停都绕不过去
- 名单支持域名、子域、通配、路径、正则，白名单优先放行
- 分组可按组折叠、筛选、整组启停，统计页能看每组拦了多少次
- 数据全部存在 Tampermonkey 本地存储，不联网、不上传

## 规则怎么写

| 写法 | 含义 |
| --- | --- |
| `bilibili.com` | 拦这个域名和所有子域 |
| `*.douyin.com` | 通配写法，效果同上 |
| `youtube.com/shorts` | 只拦这个路径 |
| `/^(www\.)?weibo\.com\/a\//` | 正则，匹配「域名 + 路径」 |

## 分组策略

在「设置 → 分组规则」里，每组三选一：

- **全程**：任何时间都拦
- **时段**：只在你设的时间段内拦，支持多个区间、跨天、按星期选；之外正常访问，也不计拦截次数
- **强制**：没有放行入口，白名单和暂停都绕不过去。任何分组都能选，从强制切回来要输入确认词

从强制切回其他模式要输入确认词，避免手滑关掉。

每组还能单独覆盖等待秒数、单次放行时长、是否必须写理由、每日放行次数上限。

脚本本身不带任何预置网站，装完是空名单，全部由你自己加。

## 边界

- 它是提高摩擦的工具，不是家长控制：你随时能在 Tampermonkey 里停用它
- 服务器仍会收到一次首请求，要彻底封死需要浏览器扩展
- PIN 只防手滑，不是加密

## 更新

脚本从安装地址检查更新。想让更新更稳，可以在脚本头部的 `==UserScript==` 里加两行：

```
// @updateURL    https://raw.githubusercontent.com/KhalilYe050113/focus-blocker/main/blocker.user.js
// @downloadURL  https://raw.githubusercontent.com/KhalilYe050113/focus-blocker/main/blocker.user.js
```

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
