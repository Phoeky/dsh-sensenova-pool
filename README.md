<div align="center">

# dsh-sensenova-pool

**商汤日日新（SenseNova）多 Key 轮换池 · DeepSeek Harness 插件**

在一个地方填入多把商汤 API Key，即可在 DSH 对话窗口里直接使用日日新的各种模型 —— 遇 429 限流自动切换到下一把 Key，全程无感。

[![npm](https://img.shields.io/npm/v/dsh-sensenova-pool?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-sensenova-pool)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5)](https://github.com/deepseek-ai/deepseek-harness)

中文 | [English](#english)

</div>

---

> **想要一个独立运行、不依赖 DSH 的网关服务？** 请移步 **[Phoeky/st-rotator](https://github.com/Phoeky/st-rotator)**。
> 本插件是它在 DeepSeek Harness 里的内嵌版：不装 DSH、或者需要给整个局域网提供服务时，用那个项目更合适。

---

## 功能

### 🔑 多 Key 轮换池

填入任意多把商汤 Key，请求在多把 Key 之间自动轮转，把每把 Key 的额度摊开使用。

![Key 管理卡片](https://raw.githubusercontent.com/Phoeky/dsh-sensenova-pool/main/docs/shots/01-keys.png)

- **一次粘贴多把**：换行、逗号、分号、空格分隔都可以
- **自动清洗**：识别并去除 `Bearer ` 前缀、首尾引号、重复项、明显无效的短串
- **只看得到脱敏值**：界面只显示 `sk-example...0001` 这样的掩码，明文 Key 不会出现在任何界面上
- **单把可测**：每把 Key 都能单独「测试」探活，看到真实的可用状态与延迟
- **单独删除**：任意一把失效随时移除，不影响其他 Key

### 🛡 429 限流自动切换

这是本插件的核心能力。商汤的 Key 有较低的 RPM 上限（实测现有 Key 约 3 RPM），单靠重试无法解决。本插件的做法：

- 遇 429 **立即切换到下一把 Key** 重试，用户看不到任何报错
- 每把 Key 独立冷却，按指数退避 + 随机抖动错开解冻时间
- 本地 RPM 预限流主动排队，**从源头避开**限流，而不是挨打后再退避
- 池子真的耗尽时，回报 `503 + Retry-After`（而不是 429），交由 DSH 自行退避重试
- 429 计数与冷却状态在卡片上实时可见

截图里的 `2/3 成功，1 次限流` 是真实发生的记录：这把 Key 触发过 1 次 429，被池子内部消化掉，上层没有收到过任何 429。

### 🧠 一次接入全部模型

装好插件后，模型选择器里自动出现「商汤日日新（Key 轮换池）」分组，包含以下模型：

| 模型 | 上下文 | 最大输出 | 图片输入 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1,048,576 | 65,536 | – |
| `deepseek-v4-flash` | 1,048,576 | 65,536 | – |
| `deepseek-v4-pro` | 1,048,576 | 65,536 | – |
| `deepseek-flash` | 1,048,576 | 65,536 | – |
| `glm-5.2` | 1,048,576 | 131,072 | – |
| `kimi-k3` | 1,048,576 | 65,536 | – |
| `sensenova-6.8-flash-lite` | 262,144 | 65,536 | ✓ |

启动时内置一份保守目录（无需网络即可用），拿到有效 Key 后自动通过 `/v1/models` 刷新，**商汤日后上线新模型无需升级插件**。

思考等级同样支持，可选 `none / low / medium / high / xhigh`。

### ⚙️ 零配置

Key 存在 DSH 的凭据库里，不写进任何配置文件。填入即生效，无需重启 DSH、无需改 YAML。

### 🧩 在 DSH 设置里管理

设置侧栏新增 `dsh-sensenova-pool` 分区，Key 池、对外接口、模型可见性都在这一页。插件页里的卡片同样可以打开。

### 🔌 提供对外的 OpenAI 兼容接口

插件在 127.0.0.1 上起一个 OpenAI 兼容服务。设置页显示接口地址和 API Key，复制后填进其他 Agent 或客户端即可使用；请求共用同一个 Key 池，遇到限流同样自动换 Key。

```bash
curl http://127.0.0.1:51234/v1/chat/completions \
  -H "Authorization: Bearer sk-dsh-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"ping"}]}'
```

- API Key 存在凭据库里，重启后不变
- 端口由系统在启动时分配，设置页显示当前值

### 🎛 管理可选择模型

设置页列出目录里的全部模型。取消勾选的模型不再注册给 provider，也就不会出现在模型选择器里，这个选择重启后保留。套餐里不含某些模型时，可以在这里把它们关掉。

![模型可见性](https://raw.githubusercontent.com/Phoeky/dsh-sensenova-pool/main/docs/shots/02-models.png)

---

## 安装

### 方式一：npm（推荐）

```bash
npm install dsh-sensenova-pool
```

或使用 pnpm：

```bash
pnpm add dsh-sensenova-pool
```

安装后，把 `dsh-sensenova-pool` 加入 profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-sensenova-pool"
      ]
    }
  }
}
```

### 方式二：本地开发

```bash
git clone https://github.com/Phoeky/dsh-sensenova-pool.git
cd dsh-sensenova-pool
npm install
npm run build

# 链接到你的 profile
pnpm --dir "$DSH_PROFILE_DIR" add "link:$PWD"
```

同样需要把 `dsh-sensenova-pool` 加进 `dsh.profile.bundles`。

### 重启 DSH

改完 `package.json` 后**重启 DeepSeek Harness**。确认安装成功：插件页的「已安装」列表里会出现本插件。

![插件页](https://raw.githubusercontent.com/Phoeky/dsh-sensenova-pool/main/docs/shots/03-installed.png)

---

## 使用

### 1. 填入 Key

打开 **设置 → dsh-sensenova-pool**（或插件页里本插件的卡片），在弹出的卡片里粘贴一把或多把商汤 Key：

```
sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
sk-cccccccccccccccccccccccccccccc
```

点「**添加 Key**」。支持多种分隔方式，重复和无效项会被自动过滤。

### 2. 选择模型

新建会话，在模型选择器里选「**商汤日日新（Key 轮换池）**」下的任意模型，然后正常对话即可。

### 3. 需要时调整

| 按钮 | 作用 |
|---|---|
| **测试** | 对单把 Key 发一次极小请求，立刻看到是否可用与延迟 |
| **删除** | 移除单把 Key |
| **清空全部** | 移除所有 Key |
| **刷新模型列表** | 主动从商汤 `/v1/models` 拉取最新模型目录 |
| **复制**（接口区） | 复制接口地址 / 对外 API Key |
| **模型勾选框** | 决定该模型是否出现在模型选择器里 |

### 4. 接入其他服务

设置页「本地接口」区给出两样东西：

| 字段 | 示例 | 说明 |
|---|---|---|
| 接口地址 | `http://127.0.0.1:51234/v1` | OpenAI 兼容，`/chat/completions`、`/models` 都支持，流式/非流式都行 |
| API Key | `sk-dsh-…` | 填进 `Authorization: Bearer` 即可 |

任何 OpenAI 客户端都可以直接用它，例如：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:51234/v1", api_key="sk-dsh-…")
print(client.chat.completions.create(
    model="glm-5.2",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

这个 Key 只被本地 shim 校验，**不会发给商汤**；真实的商汤 Key 始终只存在于插件内部。

---

## 配置项（可选）

绝大多数情况无需改动。如需微调，在 profile 的 `cordis.patch.yml` 里加入：

```yaml
- id: llm-sensenova-pool
  name: dsh-sensenova-pool
  config:
    rpmLimit: 2          # 每把 Key 的本地 RPM 预限流上限；0 = 关闭
    maxAttempts: 6       # 单个请求最多尝试几把 Key
    maxConcurrency: 1    # 每把 Key 的并发上限；1 = 串行（推荐）
    acquireTimeoutMs: 180000
    requestTimeoutMs: 60000
    baseUrl: https://token.sensenova.cn/v1
```

`rpmLimit: 2` 是默认值，基于实测（真实上限约 3 RPM）。**调大它不会提高吞吐，只会更容易被限流** —— 想提高吞吐应该增加 Key，而不是加压。

---

## 常见问题

**模型选择器里没有「商汤日日新」分组？**

确认 `dsh.profile.bundles` 里有 `dsh-sensenova-pool`，然后**重启 DSH**。如果分组在但某个模型不见了，去设置页看看是不是被自己勾掉了。

**管理卡片在哪？**

两个入口都在：**设置 → dsh-sensenova-pool**（推荐），以及插件页里本插件的详情卡片。旧版 DSH 若没有设置分区，会退回只显示插件页卡片。

**一直失败怎么办？**

在卡片上点某把 Key 的「测试」看真实原因。`403 model is not available in the current token plan` 表示该模型不在这个 Key 的套餐里 —— 换模型，而不是换 Key。

**DSH 弹「The application could not start or stopped unexpectedly」，完全起不来？**

先看崩溃日志里的失败插件名。如果 `Failed plugins` 指向 `credentials`，且错误是
`record "dsh-sensenova-pool/keys" ... has unknown field "payload"`，说明凭据库里那条记录
的标签写错了 —— DSH 的凭据库对记录做白名单校验，`api-key` 只认 `kind`/`key`/`env`，
`grant` 只认 `kind`/`payload`，**一条记录不合规就会让 `credentials` 插件激活失败，进而
中止整个应用启动**（0.1.1 及更早版本存在这个写入 bug，已修复）。

手工修复：编辑 `$DSH_HOME/.credentials.yaml`，把该记录的 `kind: api-key` 改成
`kind: grant`（`payload.keys` 里的 Key 原样保留），然后重启 DSH。

```yaml
records:
  dsh-sensenova-pool/keys:
    kind: grant          # ← 必须是 grant；api-key 不接受 payload
    payload:
      keys:
        - sk-…
```

崩溃日志位置：Windows 下为 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`。

**重启电脑后 Key 池空了（「忘记 Key」）？**

0.1.2 及更早版本存在一个**启动竞态**：插件启动时只读一次凭据库，而 DSH 的凭据快照
是异步读盘填充的，冷启动磁盘慢时就会读到空快照，于是池子变成 0 把 —— 且此后没有任何
补载机制，只能重新填 Key。**0.1.3 已修复**（改为等凭据服务真正就绪后再装载）。

如果你还在旧版本上遇到，升级即可，不需要重新填 Key（Key 一直好好地在
`$DSH_HOME/.credentials.yaml` 里）。临时办法是在插件卡片上点一次「刷新/重载」。

**Key 会泄漏吗？**

不会。界面只显示掩码；明文只存在 DSH 凭据库（`$DSH_HOME/.credentials.yaml`）中，不会写入任何配置文件，也不会出现在日志里。

**设置页里的 API Key 和我的商汤 Key 是一回事吗？**

不是。设置页「本地接口」区显示的 `sk-dsh-…` 是**本地回环服务自己的**校验密钥，只用于让别的本地程序访问 `127.0.0.1` 上的 shim；它不会被转发给商汤，和你的商汤 Key 没有任何关系。真正的商汤 Key 仍然只以掩码形式出现在列表里。

**别的机器能连这个接口吗？**

不能，也不需要。shim 只绑定 `127.0.0.1`，这是刻意的：它背后是你的额度。要在多台机器/整个局域网共享，请用 [Phoeky/st-rotator](https://github.com/Phoeky/st-rotator) 这类独立网关。

---

## 环境要求

- DeepSeek Harness `0.2.0-rc.2` 或更高
- Node.js `^22.19.0 || >=24.0.0`

---

## 致谢

本插件在设计与实现上参考了以下开源项目，特此致谢：

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** —— 将第三方模型接入 DSH 的插件范式。本插件的 provider 注册方式与浏览器卡片结构参考了该项目。
- **[Phoeky/st-rotator](https://github.com/Phoeky/st-rotator)** —— 商汤 Key 轮换网关。本插件的轮换调度、冷却退避与本地预限流策略参考了该项目。

---

## 许可

[MIT](./LICENSE)

---

<a id="english"></a>

## English

> **Looking for a standalone gateway that runs without DSH?** See **[Phoeky/st-rotator](https://github.com/Phoeky/st-rotator)** — this plugin is its in-harness edition. Use that project if you don't run DeepSeek Harness or need to serve a whole LAN.

**A multi-key rotation pool for SenseNova (商汤日日新) as a DeepSeek Harness plugin.**

Paste one or more SenseNova API keys in one place and use every SenseNova model directly in the DSH chat window — rate-limited keys (HTTP 429) are switched out automatically and transparently.

### Features

- **Managed in DSH Settings** — a settings section named `dsh-sensenova-pool` holds the key pool, the local endpoint and the model list
- **An OpenAI-compatible endpoint** — the settings page shows the base URL, port and an API key to copy into another agent or client; requests share the same pool and the same 429 handling
- **Choose which models appear** — uncheck a model and it stops being registered with the provider; the choice survives restarts
- **Multi-key pool** — paste any number of keys at once (newline / comma / semicolon separated); prefixes, quotes, duplicates and junk are cleaned automatically
- **Automatic 429 failover** — on rate limiting the pool immediately retries with the next key; each key cools down independently with exponential backoff and jitter, plus local RPM pre-throttling to avoid 429s in the first place
- **Never leaks a 429 upward** — when every key is exhausted the plugin reports `503 + Retry-After` so DSH backs off on its own
- **All models, zero config** — a built-in catalogue works offline and refreshes from `/v1/models` once a valid key is present, so new models need no plugin upgrade
- **Keys are masked** — only `sk-example...0001` style masks are ever displayed

### Install

```bash
npm install dsh-sensenova-pool
```

Add `"dsh-sensenova-pool"` to `dsh.profile.bundles` in your profile `package.json`, then restart DeepSeek Harness.

### Usage

Open **Settings → dsh-sensenova-pool** (or the plugin card on the Plugins page), paste your keys, click **Add keys**, then pick any model under the "商汤日日新（Key 轮换池）" group in the model picker. The same page shows the local endpoint (base URL, port, API key) and lets you hide models from the picker.

### Troubleshooting

**The key pool is empty after rebooting the machine ("it forgot my keys")?**

Versions 0.1.2 and earlier had a startup race: the plugin read the credential store once at startup, while DSH fills that store from disk asynchronously. On a slow cold boot the plugin read an empty snapshot, so the pool came up with zero keys — and nothing ever re-loaded it, forcing you to re-enter them. **Fixed in 0.1.3** (the plugin now waits until the credentials service is genuinely ready before loading).

Upgrade and your keys will be picked up again; they were never lost (they live in `$DSH_HOME/.credentials.yaml`). On an older version, clicking reload on the plugin card recovers them for the session.

### Acknowledgements

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) — the plugin pattern for bringing third-party models into DSH
- [Phoeky/st-rotator](https://github.com/Phoeky/st-rotator) — the SenseNova key-rotation gateway this plugin's rotation strategy derives from

### License

[MIT](./LICENSE)
