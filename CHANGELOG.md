# 更新日志

本文件记录本插件的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-11-19

### 新增

- **端点选择：中国站 / 国际站**。设置卡片顶部新增「上游端点」区，一键在
  `https://token.sensenova.cn/v1`（中国站，默认）与 `https://token.sensenova.ai/v1`（国际站）之间切换，
  无需重启 DSH。所选端点随 key 一起存进凭据库，重启后仍然记得（[#5](https://github.com/Phoeky/dsh-sensenova-pool/issues/5)）。
- **国际站模型目录**：国际站的内置基线覆盖上游 `/v1/models` 列出的全部 5 个模型，
  包括两个生图模型（`sensenova-u1-fast`、`sensenova-u1.5-lite`）。
- **按端点的限流额度**：本地 RPM 预限流按站分开计算（默认中国站 2、国际站 3），
  配置项 `rpmLimit` 新增 `-1` 表示「按端点取默认值」（即现在的默认行为）。
- 新增配置项 `endpoint`（`cn` / `intl`），只决定**默认**端点；卡片里的选择优先。
- 设置卡片显示当前实际上游地址，并提示 baseUrl 是否被配置文件固定。

### 变更

- 切换端点会连带重置模型目录、RPM 额度与 key 的冷却/失效标记。两个站的 key 互不通用，
  带着旧站的「已失效/冷却」标记切过去，会让刚切换的几分钟内一把 key 都用不了。
- **模型目录不再按输出模态过滤**：上游 `/v1/models` 列什么就收什么（此前会静默剔除生图模型）。
  不想要的模型可在设置页取消勾选，可见性会持久化。
- 单把 key 探活的默认模型改为取自当前端点的目录（此前写死 `deepseek-v4-flash`，
  在国际站上必然 404）。
- `baseUrl` 配置项默认值改为空（表示「用所选端点的官方地址」）；仍可显式填写以走自建网关，
  此时切端点只换目录与额度，不改请求地址。

### 修复

- 端点切换后模型选择器不再残留另一个站独有的模型（例如国际站上出现 `deepseek-v4-flash`）。

### 兼容性

- 未切换过端点的老用户**行为完全不变**：默认端点仍是中国站，地址与限流额度不变。
- 凭据记录只新增了一个可选字段 `endpoint`，旧记录照常读取。

## [1.0.0]

商汤日日新多 Key 轮换池的稳定版：遇 429 自动切换 key、本地 RPM 预限流、
OpenAI 兼容本地接口、模型可见性与窗口自定义。

## [0.2.2]

- 思考档位改为**按模型维护实测词表**（[#3](https://github.com/Phoeky/dsh-sensenova-pool/issues/3)）：
  `glm-5.3` 只认 `low / high / max`，单一映射表无论怎么调都会踩到某一头。
  模型选择器里只显示该模型真实支持的档位。

## [0.2.1]

- 请求体清洗层：把「Agent 合法、商汤网关不认」的写法语义等价地规范化
  （`developer`→`system`、`content: null`→`""`、`arguments` 对象→JSON 字符串、
  `off`→`none`、摘掉 `logprobs` / `metadata` 等），修复 [issue #2](https://github.com/Phoeky/dsh-sensenova-pool/issues/2) 的 400。
- 新增 `debugRequestOn400`，400 时把实际发出的请求体写进日志。

## [0.2.0]

- 支持逐模型自定义上下文窗口与最大输出（[#4](https://github.com/Phoeky/dsh-sensenova-pool/issues/4)）。
- 用实测值覆盖上游把 `sensenova-6.8-flash` 报小 4 倍的 `context_length`。

## [0.1.3]

- 修复**启动期凭据竞态**：改为等凭据服务真正就绪后再装载，不再出现
  「重启电脑后 Key 池为空」（[#1](https://github.com/Phoeky/dsh-sensenova-pool/issues/1)）。

## [0.1.1]

- 修复凭据记录写成 `api-key` + `payload` 导致整机 DSH 无法启动的问题（必须用 `grant`）。

## [0.1.0]

首个可用版本：多 Key 轮换池、429 自动切换、设置页管理 key。
