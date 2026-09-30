# MFY PT Tracker Shadowrocket 模块 v5.0.2（暂时回滚版）

在设备上抓国服 PJSK 的活动 / 排名响应，上传到自建 tracker（`POST /api/raw2`）。

## ⏸️ v5.0.2：暂时回滚到纯 Base64（identity 全停用）

v5.0.1 已把 `identity` 限制在 ≤64KB 单片包，但用户设备又中了一次：`live` **97,024 B（2 片）**
→ `decrypt_failed: 无效 padding：0`，该局的周回/成绩没能入库。

`identity` 只在大包上收益明显，而大包正是"成绩 / 排位"这类**丢了补不回来**的数据 —— 因此暂时**全部回滚到 Base64**：

| | Base64（当前） | identity（已停用） |
|---|---|---|
| 上行体积 | +33%（90,880 B → 121,176 B） | 原始大小 |
| 设备 CPU | 多约 31ms/包（Base64 编码） | 无 |
| 可靠性 | 实测 **313/313 ≈ 100%** | 多片包内容会被改写（小火箭 typed array 子视图 bug） |

代码里保留 `identity` 分支（`IDENTITY_MAX_BYTES = 0` 即停用），等有**内容级验证**之后再把上限调回去。

## ⚠️ v5.0.1（历史，治标）：>64KB 的多片包回退 Base64

**症状**：v5.0.0 用原始字节（`identity`）上传。实测某台设备（iPad16,5 / Shadowrocket 2701）两局数据 `state=rejected`：

- `multi-live` 328,112 B → 「解密失败: 无效 padding：195」
- `challenge-live/solo` 367,280 B → 「解密失败: padding 校验失败」

**这两局的成绩 / PT 没有入库**（同一设备 64 B 的小包 `completed` 正常）。

**根因**：AES-CBC 的 padding 校验只看最后一组，报 padding 错 = **尾部 16 字节被改写**。设备 PacketTunnel 日志显示脚本拿到了完整的 `body:Uint8Array:328112`、`chunks=6`，6 片全部发出，服务端收到的**总长度也一字不差**。再看统计：

| 证据 | 结论 |
|---|---|
| 所有 Shadowrocket `identity` **成功**案例都是**单片**（≤13KB） | 单片正常 |
| 所有 ≥100KB 的 `identity` 成功案例都来自雅典娜（Go 直发原始字节，非小火箭） | 服务端与分片契约没问题 |
| Base64 通道的多片包 7/7 正常 | 小火箭的 Base64 通道没问题 |

⇒ **Shadowrocket 对 typed array 的「子视图」会送错字节**：第 2 片起 `subarray` 的 `byteOffset != 0` 被忽略、从头取字节。

> 教训：验证"字节保真"必须用**可解密的密文**做内容级校验。v5.0.0 的探针只验了**长度**（90,880/2 片），而随机数据无法暴露内容被改写。

**修法**：`IDENTITY_MAX_BYTES` 从 512KB 降到 **64KB** —— 只有**单片**包走 `identity`，>64KB（必然多片）一律回退 Base64。
小包（收菜类，按条数占多数）仍省 25%；大包（成绩类，按字节占多数）走久经考验的 Base64。**宁可少省，不能丢成绩。**

## v5.0.0：原始字节上传（⚠️ 已被 v5.0.1 取代，>64KB 大包会丢数据）

v4.1.5 及以前走 Base64：90,880 B 的响应体要发 121,176 B（+33%）。v5.0.0 改成直接发原始字节（`X-Body-Encoding: identity`），真机探针六种组合：

| 变体 | body 类型 | 服务端实收 | 结论 |
|---|---|---|---|
| 小包 identity **字符串** | string | 48 B（期望 32） | JS 字符串出网被按 UTF-8 改写 ❌ |
| 小包 identity **Uint8Array** | string | 32 B | ✅ |
| 小包 base64（对照） | string | 32 B | ✅ |
| 大包 identity 字符串 | string | 136,250 B（期望 90,880） | ❌ |
| 大包 base64（对照） | string | 90,880 B | ✅ |
| 大包 identity Uint8Array（90,880 B / 2 片） | typed array | 90,880 B | ⚠️ 只验了长度，内容未验（见上）|

回退逻辑（v5.0.1 调整后）：

1. 包体 **> 64KB**（必然多片）或 `$response` 给不出 typed array（老版小火箭）→ 走 Base64；
2. `$httpClient.post` 对 typed array **抛异常** → 整包改用 Base64 重发（换新 `upload_id`，不会让同一单混两种编码）。

## 客户端

| 文件 | 说明 |
|---|---|
| `mfy.sgmodule` | 模块配置，6 条 PJSK Response 规则，脚本指向线上 `mfy-upload-v502.js?v=a9aaafc1`（**单一事实源**：改脚本只动服务端，不用改仓库） |
| `mfy-upload-v502.js` | **当前脚本**（`UPLOAD_VERSION = "v5.0.2-base64-rollback"`，sha256 `a9aaafc152fa22d7…`）—— 全部走 Base64 |
| `mfy-upload-v501.js` | v5.0.1：`identity` 仅 ≤64KB 单片（治标版）（`UPLOAD_VERSION = "v5.0.1-identity-1chunk"`，sha256 `0c033143a62c09dd…`）—— 与线上同名字节一致，仓库内留档 |
| `mfy-upload-v4.js` | 历史脚本（v5.0.0 · `v4.3-uint8array-identity`）—— **有多片丢内容的 bug，别再用** |
| `mfy-upload-v3.js` | 历史脚本（v4.1.5 · Base64），更早的版本 |

若想改成从本仓库 raw 加载脚本，把 `script-path` 换成
`https://raw.githubusercontent.com/RakastanChenia/mfy-PT-Tracker-shadowrocket/main/mfy-upload-v502.js?v=a9aaafc1` 即可。

重新导入模块后，设备日志（`[mfy-upload]`）里会打：

```text
[mfy-upload] version=v5.0.2-base64-rollback, upload_id=xxxxx, mode=base64, source=bodyBytes:Uint8Array:12928, bytes=17240, chunks=1
[mfy-upload] DISPATCH_ALL mode=base64 chunks=1 -> release response
[mfy-upload] version=v5.0.2-base64-rollback, upload_id=yyyyy, mode=base64, source=bodyBytes:Uint8Array:328112, bytes=437484, chunks=7
[mfy-upload] DISPATCH_ALL mode=base64 chunks=7 -> release response
```

**判断设备实际跑的是哪一版，只看这两处**：设备日志的 `version=` / `mode=`，服务端日志的 `ver=` / `encoding=`。
模块里的 `?v=` 只是"期望的脚本指纹"——客户端缓存可能仍在用旧脚本；服务端若看到 `ver=v4.1.5-dispatch-only` 或 `ver=v4.3-uint8array-identity`，就说明这台设备还没换到 v5.0.1。

**不会再出现**旧版的 `chunk 1/2 ok …` / `ALL_CHUNKS_DONE …` —— 回调已经不存在了，这是预期，不是坏了。

## v4.1.4 / v4.1.5 改了什么：先派发、再放行

旧版把响应体扣在脚本里，等所有分片传完才 `$done()` —— 游戏要白等整段上传时间（实测 **810ms**）。

实测 iPad 的 PacketTunnel 日志，发现小火箭脚本的真实生命周期：

```
14:33:09.326  [mfy-upload] PROBE_DISPATCH_AFTER_DONE      ← $done 之后同一轮发出的请求
14:33:09.327  script <61> context dealloc => …            ← 1 毫秒后上下文销毁
```

两条结论：

1. `$done()` 之后 JS 上下文立刻销毁，`$httpClient` 的**回调永远不会回来** —— "放行后再慢慢传、失败重试"物理上做不到；
2. 但**已经交给网络栈的请求不受影响** —— 上例那个探针请求是在 dealloc **之后**才建立连接的，照样到达服务端。

所以 v4.1.4 改成：**同一轮里先把所有分片交出去，最后才 `$done()`**。

```
响应体 → 分片（identity ≤64KB / 否则 Base64）→ 一次性全部 POST → $done() 放行 → 游戏继续
```

同一份 90,880 字节的响应实测：**游戏侧等待 810ms → 33ms**（其中 31ms 是 Base64 编码，派发只占 2ms；identity 小包更低）。

## 代价与取舍

- **没有应用层重试了**：回调不会回来，就收不到分片回执，也就不可能重试。单片失败这一次就丢，等下一次响应补上；服务端 `/api/raw2` 按 `upload_id` 幂等，重复 / 乱序到达都安全。
- 圣何塞链路上实测（120 次上传 / 325 个分片）**重试一次都没触发过**，所以这个取舍没有实测代价。
- v4.1.5 把那段"回调永远不会触发"的重试 / 超时 / 逐片日志代码**整段删掉**（260 → 199 行），脚本只剩「编码 → 派发 → 放行」三步。
- 分片大小实测（真实 90,880B 包、50 次配对压测）：**64KB（2 片）中位 765ms 略优**；128KB 及以上退化为 1 片、中位 875~884ms。**结论：维持 64KB。**

## 服务端

`/api/raw2` 已内置幂等处理，客户端直接用，无需替换服务端文件：分片落盘 → 收齐后后台拼装 → （`identity` 直接用原始字节 / `base64` 先解码）→ AES-CBC + MessagePack → PT / Ranking 入库。
状态文件定时清理；同一 `upload_id` 的 `total_chunks` / 原始 URL / `X-Body-Encoding` 不允许中途变化。

## 上传链路

```text
PJSK Response
    ↓
Shadowrocket MITM（binary-body-mode=1）
    ↓
Base64 编码（X-Body-Encoding: base64）        ← v5.0.2：identity 已停用
    ↓
max(64KB, len/8) 分片，一次性并行 POST        ← 1~2ms
    ↓
$done() 放行响应体，游戏继续
    ↓
（后台）圣何塞 VPS /api/raw2 → 收齐拼装 → AES-CBC + MessagePack → 入库
```

## 版本

- **v5.0.2**（当前）：暂时回滚 —— 停用 `identity`，全部走 Base64（100% 可解密；体积/CPU 回到 v4.1.5 水平）。
- v5.0.1：`identity` 仅用于 ≤64KB 单片包，>64KB 回退 Base64（治标，已弃用）。
- v5.0.0：（**有 bug，勿用**）原始字节上传；小包省 25%，但 >64KB 多片会送错字节导致解密失败。
- v4.1.5：Base64 通道 + 先派发再放行（游戏侧等待 810ms → 33ms）。