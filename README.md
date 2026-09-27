# MFY PT Tracker Shadowrocket 模块 v3

本版本在原有 64KB 小分片 + 4 并行基础上增加应用层重传，并同步增强 `/api/raw2` 的服务端幂等处理。

## 客户端

文件：

- `mfy.sgmodule`：模块配置；6 个 PJSK Response 规则全部指向 `mfy-upload-v3.js`。
- `mfy-upload-v3.js`：64KB 分片、最多 4 片并行、每片最多重试 3 次（总尝试最多 4 次）。
- `mfy-upload-v2.js`：保留并同步为新版内容，兼容已经引用旧文件名的安装。
- `mfy-upload.js`：同样同步为新版内容，兼容旧安装。

重新导入模块后，看日志中的：

```text
version=v3-64k-parallel-retry3
```

失败时会类似：

```text
chunk 2 failed on attempt 1 (Error: ...), retry 1 in 1000ms
chunk 2 ok on attempt 2
```

重试条件：网络错误、没有收到响应、HTTP 408/425/429、HTTP 5xx。普通 4xx 参数错误不会盲目重试。

重试退避：1s → 2s → 4s。

## 服务端

需要使用配套的 `app_retry3.py` 替换原 `app.py`（或者把其中的 `/api/raw2` 改动合并进去）。

服务端新增：

1. `processing` 状态：相同 `upload_id` 同时到达时只允许一个任务入队。
2. `done` 状态：最后一个 HTTP 200 回执丢失、客户端因此重传时，服务器直接返回 `already_completed`，不会重新创建已完成上传。
3. 同一 `upload_id` 的 `total_chunks` / 原始 URL 不允许中途变化。
4. 后台处理失败时保留分片目录并释放 `processing` 状态，后续可继续处理；不会因为一次解析异常把已上传数据直接删掉。
5. 状态文件定时清理，避免长期占用磁盘。

## 上传链路

```text
PJSK Response
    ↓
Shadowrocket MITM
    ↓
64KB chunks
    ↓
最多 4 个并行 HTTP POST
    ↓
单片失败：1s / 2s / 4s 自动重传
    ↓
东京 VPS /api/raw2
    ↓
收齐后后台拼装
    ↓
AES-CBC + MessagePack
    ↓
PT / Ranking 入库
```

本版本不是替代 TCP 的底层重传，而是在 HTTP 请求级别增加“单片重发”。TCP 本身仍然负责底层丢包重传。
