# MFY PT Tracker Shadowrocket 模块 v4.1.4

在设备上抓国服 PJSK 的活动 / 排名响应，Base64 后上传到自建 tracker（`POST /api/raw2`）。

## v4.1.4 改了什么：先派发、再放行

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
- 分片大小实测（真实 90,880B 包、50 次配对压测）：**64KB（2 片）中位 765ms 略优**；128KB 及以上全部退化为 1 片、中位 875~884ms。**结论：维持 64KB。**

## 客户端

| 文件 | 说明 |
|---|---|
| `mfy.sgmodule` | 模块配置，6 条 PJSK Response 规则都指向 `mfy-upload-v3.js?v=e1a43182` |
| `mfy-upload-v3.js` | 当前脚本（v4.1.4） |

重新导入模块后，设备日志（`[mfy-upload]`）里会打：

```text
[mfy-upload] version=v4.1.4-release-first, upload_id=xxxxxxxxx, chunks=2, base64Bytes=121176
[mfy-upload] DISPATCH_ALL chunks=2 chunkSize=65536 -> release response
```

**不会再出现**旧版的 `chunk 1/2 ok …` / `ALL_CHUNKS_DONE …` —— 回调已经不存在了，这是预期，不是坏了。

服务端日志里对应 `[RAW2] 分片已保存 … encoding=base64 ver=v4.1.4-release-first ua=Shadowrocket/…`，
拼装完成后是 `[RAW2] 后台处理完成 … state=completed`；若看到 `state=rejected` + `decrypt_failed`，说明设备还在跑旧脚本，重导模块即可。

## 服务端

`/api/raw2` 已内置幂等处理，客户端直接用，无需替换服务端文件：分片落盘 → 收齐后后台拼装 → Base64 解码 → AES-CBC + MessagePack → PT / Ranking 入库。
状态文件定时清理；同一 `upload_id` 的 `total_chunks` / 原始 URL / `X-Body-Encoding` 不允许中途变化。旧接口 `/api/raw`、`/api/har` 已下线（404）。

## 上传链路

```text
PJSK Response
    ↓
Shadowrocket MITM（binary-body-mode=1）
    ↓
Base64 编码（X-Body-Encoding: base64）
    ↓
max(64KB, len/8) 分片，一次性并行 POST        ← 1~2ms
    ↓
$done() 放行响应体，游戏继续                  ← 实测 33ms 后游戏就拿到数据
    ↓
（后台）圣何塞 VPS /api/raw2 → 收齐拼装 → Base64 解码 → AES-CBC + MessagePack → 入库
```
