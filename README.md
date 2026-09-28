# MFY PT Tracker Shadowrocket 模块 v4.1

在 v3（64KB 小分片 + 4 并行 + 每片应用层重传）基础上，**改为先 Base64 再分片**：
二进制 AES 密文不能当 JS 字符串直接 POST（会被 UTF-8 洗坏），服务端拿到的是坏密文 → `422 decrypt_failed`，
表现为「分片都返回 200，但数据进不了库」。Base64 编码 + 请求头 `X-Body-Encoding: base64` 由服务端还原后再解密。

## 客户端

文件（**内容必须保持一致**，老缓存的模块仍在按 `mfy-upload-v3.js` 这个文件名拉脚本）：

- `mfy.sgmodule`：模块配置；6 个 PJSK Response 规则全部指向 `mfy-upload.js?v=b8485c5c`。
- `mfy-upload.js`：当前脚本（v4.1）：Base64 分片、64KB 一片、最多 4 片并行、每片最多重试 3 次（总尝试最多 4 次）。
- `mfy-upload-v3.js`：与 `mfy-upload.js` 同内容的兼容副本，只为老模块缓存不 404。

重新导入模块后，设备日志（`[mfy-upload]`）里会打：

```text
[mfy-upload] version=v4.1-64k-parallel-base64-debug, upload_id=xxxxxxxxx, chunks=4, base64Bytes=260000
[mfy-upload] chunk 1/4 ok attempt=1 resp={"ok":true,"queued":true,...}
[mfy-upload] ALL_CHUNKS_DONE upload_id=xxxxxxxxx, failed=0/4
```

服务端日志里对应 `[RAW2] 分片已保存 … encoding=base64 ver=v4.1-… ua=Shadowrocket/…`，
拼装完成后是 `[RAW2] 后台处理完成 … state=completed`；若看到 `state=rejected` + `decrypt_failed`，说明设备还在跑旧脚本。

失败时会类似：

```text
[mfy-upload] chunk 2/4 attempt 1 failed: Error: ...
[mfy-upload] chunk 2/4 retry 1 in 1000ms
```

重试条件：网络错误、没有收到响应、HTTP 408/425/429、HTTP 5xx。普通 4xx 参数错误不会盲目重试。

重试退避：1s → 2s → 4s。

## 服务端

服务端 `app.py` 已内置下述 `/api/raw2` 幂等处理，客户端直接使用即可，无需替换服务端文件。

服务端新增：

1. `processing` 状态：相同 `upload_id` 同时到达时只允许一个任务入队。
2. `done` 状态：最后一个 HTTP 200 回执丢失、客户端因此重传时，服务器直接返回 `already_completed`，不会重新创建已完成上传。
3. 同一 `upload_id` 的 `total_chunks` / 原始 URL / `X-Body-Encoding` 不允许中途变化。
4. 后台处理失败时保留分片目录并释放 `processing` 状态，后续可继续处理；不会因为一次解析异常把已上传数据直接删掉。
5. 状态文件定时清理，避免长期占用磁盘。
6. `X-Body-Encoding: base64` 支持：收齐分片后先 Base64 解码，再做 AES-CBC 解密。

## 上传链路

```text
PJSK Response
    ↓
Shadowrocket MITM（binary-body-mode=1）
    ↓
Base64 编码（X-Body-Encoding: base64）
    ↓
64KB chunks
    ↓
最多 4 个并行 HTTP POST
    ↓
单片失败：1s / 2s / 4s 自动重传
    ↓
圣何塞 VPS /api/raw2
    ↓
收齐后后台拼装 → Base64 解码
    ↓
AES-CBC + MessagePack
    ↓
PT / Ranking 入库
```

本版本不是替代 TCP 的底层重传，而是在 HTTP 请求级别增加“单片重发”。TCP 本身仍然负责底层丢包重传。
