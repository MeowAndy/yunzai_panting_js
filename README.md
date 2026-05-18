# yunzai_panting_js 🎨

Yunzai Bot 画图插件 —— 支持预设画图、自定义提示词画图、次数管理、API 余额查询。

## ✨ 功能

- 🪄 预设画图（从云端拉取预设指令）
- 🎨 `#bnn <提示词>` 自定义画图（支持多图输入）
- 📊 次数管理（群次数 + 个人次数）
- 💰 API 余额查询（图片渲染看板）

## 📦 安装

将 `Painting.js` 放入 Yunzai 的 `plugins/example/` 目录。

## ⚙️ 配置

编辑 `Painting.js` 顶部配置项：

```javascript
const API_URL = 'https://your-api-url/v1/chat/completions';
const API_KEY = "your-api-key-here";
const MODEL_NAME = "gpt-5.5";
const BALANCE_BASE_URL = 'https://your-balance-api-url';
```

## 🎮 命令

| 命令 | 权限 | 说明 |
|------|------|------|
| `#<预设关键词>` | 所有人 | 使用预设画图 |
| `#bnn <提示词>` | 所有人 | 自定义提示词画图 |
| `#绘图帮助` | 所有人 | 查看帮助 |
| `#绘图查询次数` | 所有人 | 查看剩余次数 |
| `#绘图增加次数 <数量>` | 主人 | 增加次数 |
| `#查询额度` / `#查余额` | 主人 | 查询 API 余额 |
| `#更新焚决` | 主人 | 更新云端预设 |

## 📄 License

MIT
