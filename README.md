# DaidaiBird Monitor - SillyTavern 插件

当你使用的上游 API 地址包含 `daidaibird` 时，自动在模型选择列表中显示每个模型的实时报错率。

## 功能

- 自动检测 Custom URL 是否包含 `daidaibird`
- 从 `https://user.daidaibird.top/api/monitors/status` 获取各模型报错率
- 在模型下拉列表中显示报错率（如 `claude-sonnet-4-6 [报错: 5.3%]`）
- **传给上游 API 的模型名保持原样不变**
- 每 5 分钟自动刷新报错率数据
- 切换到非 daidaibird URL 时自动停止监控并还原显示

## 报错率颜色说明

| 报错率 | 含义 |
|--------|------|
| 0-2%   | 低（正常） |
| 2-10%  | 中等（需注意） |
| >10%   | 高（建议避免） |

## 安装

### 方法一：通过 SillyTavern UI 安装

1. 打开 SillyTavern
2. 点击 **Extensions** > **Install Extension**
3. 粘贴本仓库的 GitHub URL
4. 点击安装

### 方法二：手动安装

将本文件夹复制到：

```
SillyTavern/public/scripts/extensions/third-party/SillyTavern-DaidaiBird-Monitor/
```

重启 SillyTavern 即可。

## 使用

无需额外配置。只要你的 Custom API URL 包含 `daidaibird`，插件会自动启用并在模型列表中追加报错率信息。
