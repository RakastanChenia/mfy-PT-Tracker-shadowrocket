# MFY PT Tracker Shadowrocket 模块 v5.0.0

在设备上抓国服 PJSK 的活动 / 排名响应，上传到自建 tracker（`POST /api/raw2`）。

## v5.0.0 改了什么：原始字节上传（上行 -25%）

v4.1.5 及以前走 Base64：90,880 B 的响应体要发 121,176 B（+33%）。

v5.0.0 直接发原始字节（`X-Body-Encoding: identity`）。先在真机（iPad17,1 / Shadowrocket 3445）用探针逐字节验证过六种组合：

| 变体 | body 类型 | 服务端实收 | 结论 |
|---|---|---|---|
| 小包 identity **字符串** | string | 48 B（期望 32） | JS 字符串出网被按 UTF-8 改写 ❌ |
| 小包 identity **Uint8Array** | typed array | 32 B | ✅ |
| 小包 base64（对照） | string | 32 B | ✅ |
| 大包 identity 字符串 | string | 136,250 B（期望 90,880） | ❌ |
| 大包 base64（对照） | string | 90,880 B | ✅ |
| **大包 identity Uint8Array（90,880 B / 2 片）** | typed array | **90,880 B** | ✅ 生产量级保真 |

结论：**body 直接给 `Uint8Array` + `X-Body-Encoding: identity`** —— 同一份包上行 121,176 → **90,880 B（-25%）**，顺带省掉设备端约 31ms 的 Base64 编码。

回退逻辑（新通道万一不可用，不会丢数据）：

1. 包体 > 512KB，或 `$response` 给不出 typed array（老版小火箭）→ 自动走原来的 Base64 路径；
2. `$httpClient.post` 对 typed array **抛异常** → 整包改用 Base64 重发（换新 `upload_id`，不会让同一单混两种编码）。

## 客户端

| 文件 | 说明 |
|---|---|
| `mfy.sgmodule` | 模块配置，6 条 PJSK Response 规则，脚本指向线上 `mfy-upload-v4.js?v=8db9e559`（**单一事实源**：改脚本只动服务端，不用改仓库） |
| `mfy-upload-v4.js` | 当前脚本（`UPLOAD_VERSION = "v4.3-uint8array-identity"`，sha256 `8db9e559f98c7f14…`）—— 与线上同名字节一致，仓库内留档 |
| `mfy-upload-v3.js` | 历史脚本（v4.1.5 · Base64），仅为仍持有旧 URL 缓存的设备保留 |

若想改成从本仓库 raw 加载脚本，把 `script-path` 换成
`https://raw.githubusercontent.com/RakastanChenia/mfy-PT-Tracker-shadowrocket/main/mfy-upload-v4.js?v=8db9e559` 即可。

重新导入模块后，设备日志（`[mfy-upload]`）里会打：

```text
[mfy-upload] version=v4.3-uint8array-identity, upload_id=xxxxxxxxx, mode=identity, source=bodyBytes:Uint8Array:90880, bytes=90880, chunks=2
[mfy-upload] DISPATCH_ALL mode=identity chunks=2 -> release response
```

**判断设备实际跑的是哪一版，只看这两处**：设备日志的 `version=` / `mode=`，服务端日志的 `ver=` / `encoding=`。
模块里的 `?v=` 只是"期望的脚本指纹"——客户端缓存可能仍在用旧脚本。服务端若看到 `encoding=base64 ver=v4.1.5-dispatch-only`，就说明这台设备还在跑旧脚本（重导模块即可）。

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
响应体 → Base64 → 按 max(64KB, ceil(len/8)) 切片（保证 ≤8 片，任何包体都不会被截断）
       → 一次性全部 POST → $done() 放行 → 游戏继续
```

同一份 90,880 字节的响应实测：**游戏侧等待 810ms → 33ms**（其中 31ms 是 Base64 编码，派发只占 2ms）。
分片大小从此只影响后台传输快慢，玩家完全无感。

## 代价与取舍

- **没有应用层重试了**：回调不会回来，就收不到分片回执，也就不可能重试。单片失败这一次就丢，等下一次响应补上；服务端 `/api/raw2` 按 `upload_id` 幂等，重复 / 乱序到达都安全。
- 圣何塞链路上实测（120 次上传 / 325 个分片）**重试一次都没触发过**，所以这个取舍没有实测代价。
- v4.1.5 把那段"回调永远不会触发"的重试 / 超时 / 逐片日志代码**整段删掉**（260 → 199 行），脚本只剩「编码 → 派发 → 放行」三步，不留任何等回执的分支。
- 分片大小实测（真实 90,880B 包、50 次配对压测）：**64KB（2 片）中位 765ms 略优**；128KB 及以上全部退化为 1 片、中位 875~884ms。**结论：维持 64KB。**

## 代价与取舍

- **没有应用层重试了**：回调不会回来，就收不到分片回执，也就不可能重试。单片失败这一次就丢，等下一次响应补上；服务端 `/api/raw2` 按 `upload_id` 幂等，重复 / 乱序到达都安全。
- 圣何塞链路上实测（120 次上传 / 325 个分片）**重试一次都没触发过**，所以这个取舍没有实测代价。
- v4.1.5 把那段"回调永远不会触发"的重试 / 超时 / 逐片日志代码**整段删掉**（260 → 199 行），脚本只剩「编码 → 派发 → 放行」三步，不留任何等回执的分支。
- 分片大小实测（真实 90,880B 包、50 次配对压测）：**64KB（2 片）中位 765ms 略优**；128KB 及以上全部退化为 1 片、中位 875~884ms。**结论：维持 64KB。**

## 服务端

`/api/raw2` 已内置幂等处理，客户端直接用，无需替换服务端文件：分片落盘 → 收齐后后台拼装 → （`identity` 直接用原始字节 / `base64` 先解码）→ AES-CBC + MessagePack → PT / Ranking 入库。
状态文件定时清理；同一 `upload_id` 的 `total_chunks` / 原始 URL / `X-Body-Encoding` 不允许中途变化。旧接口 `/api/raw`、`/api/har` 已下线（404）。

## 上传链路

```text
PJSK Response
    ↓
Shadowrocket MITM（binary-body-mode=1）
    ↓
原始字节（X-Body-Encoding: identity）        ← v5.0.0；>512KB 或拿不到 typed array 时回退 Base64
    ↓
max(64KB, len/8) 分片，一次性并行 POST        ← 1~2ms
    ↓
$done() 放行响应体，游戏继续                  ← v4.1.5 实测 33ms（其中 31ms 是 Base64；identity 更低）
    ↓
（后台）圣何塞 VPS /api/raw2 → 收齐拼装 → AES-CBC + MessagePack → 入库
```

## 版本

- **v5.0.0**（当前）：原始字节上传（`identity`），上行 -25%，真机逐字节验证 + Base64 回退。
- v4.1.5：Base64 通道 + 先派发再放行（游戏侧等待 810ms → 33ms）。
