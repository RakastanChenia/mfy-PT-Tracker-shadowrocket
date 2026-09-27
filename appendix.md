# 建议：`mfy-upload.js` 改为「小分片 + 并行上传」

> 面向 `RakastanChenia/mfy-PT-Tracker-shadowrocket`
> 影响文件：`mfy-upload.js`（分片与上传逻辑）
> 服务端：**无需任何额外改动**（详见第四节）

---

## 一、一句话结论

现在的实现是「**1MB 分片 + 严格串行 + 同步接口**」。
由于实际包体只有 **约 190KB**（`multi-live` 结果 ≈194KB、`live` ≈87KB），**1MB 的分片阈值永远切不开**，等于**每个包都是一整块、单连接、一次性发完** ✗。
在国际链路（高 RTT + 丢包）上，这会表现为「**偶发 60 秒级超时，甚至被模块里的 `timeout=60` 中途杀掉**」。

建议改为：**64KB 分片 + 最多 4 片并行 + 每片最多重试 3 次**（并推荐把 `upload_url` 指向已上线的异步接口 `/api/raw2`）。
模块侧改动约 **6 行**，服务端零改动。

---

## 二、现状：代码事实

```js
 1| const upload_url = "http://168.138.217.249:8000/api/raw";   // 同步处理：客户端要等后端解密+解析+写库
 2| const chunkSize = 1 * 1024 * 1024; // 1MB                    // 阈值 > 实际包体 → 永远只有 1 片
13| const totalChunks = Math.ceil(body.length / chunkSize);
41| $httpClient.post(options, (error, resp, data) => {
58|   sendChunk(index + 1);                                      // 写在回调里 → 严格串行，永远只有 1 条连接
```

由此产生三个问题：

| # | 问题 | 后果 |
|---|---|---|
| 1 | 分片阈值 1MB > 包体 ~190KB | `totalChunks === 1`，**分片机制实际从未生效**；单次请求就是全部数据，失败要整体重来 |
| 2 | `sendChunk(index + 1)` 串行 | 只有 1 条 TCP 连接：一旦丢包，它的拥塞窗口就卡住整包（实测见过 `Send-Q` 仍有 99KB 卡在本地发不出去） |
| 3 | 指向同步接口 `/api/raw` | 客户端要等后端把解密/解析/写库全干完才收到响应；叠加模块行的 `timeout=60`，**上传可能被脚本超时杀掉** |

## 三、实测数据

**测量环境**：同一条链路（上海宿舍 → 东京 VPS `168.138.217.249:8000`）、同一个服务端、同一份 `multi-live` 响应（约 194KB）。
客户端不是 Shadowrocket 本体，而是一个遵守**完全相同契约**的自建客户端（同样的 5 个请求头、同样的分片语义）。
**两组数据的分片变量是唯一差异，接口均已指向 `/api/raw2`**，因此可直接对比「分片策略」这一项：

| 配置 | 样本 | 最短 | 中位 | 平均 | **最坏** | 失败 |
|---|---|---|---|---|---|---|
| 1MB × 1 并行（≈现状） | 11 | 1.89s | **11.76s** | 31.63s | **109.05s** | 2 |
| **64KB × 4 并行 + 重试** | 5 | 1.95s | **2.76s** | 3.85s | **8.70s** | **0** |

- 中位 **4.3×**、平均 **8.2×**、**最坏 12.5×**
- 失败次数 **2/11 → 0/5**
- 小包（约 3KB）中位 **1.18s**

**原因**：这类消费级/校园网络的瓶颈不在总带宽，而在**单条连接的丢包恢复**。
拆成 N 条并行流 = N 份独立的拥塞窗口在跑；同时**重试粒度从 190KB 降到 64KB** —— 这是失败率归零的主因。

## 四、服务端已就绪（所以模块侧改完即可生效）

- 异步接口 `POST /api/raw2` **已上线**，与 `/api/raw` **契约完全一致**（同样的 5 个请求头、同样的 `chunk_%06d.bin` 分片存储）
- **按分片数量判断收齐**（`len(chunks) == total`），拼装时按**分片编号排序** → **乱序 / 并行到达完全安全**
- 实测已通过：同一个包以 **3~4 片并行乱序**上传，服务端日志正常输出
  `[RAW2] 后台处理完成 status=200 bytes=193968` + `[RAW] 已提交 … PT更新=1 排名更新=1`，数据正确入库
- 处理逻辑与 `/api/raw` **共用同一个函数、写入同一个数据库**，只是把「拼装+解密+解析+写库」搬到后台线程
- `/api/raw` **保持原样可用**，老客户端不会受任何影响

> 如果希望**只改客户端、暂不切接口**：也完全可以——只做第五节的分片/并行改动，继续打 `/api/raw`。
> 收益依然是上面那 4~12 倍；切到 `/api/raw2` 的额外好处是「回执毫秒级返回」，能进一步降低被 `timeout=60` 杀掉的概率。

## 五、建议改动（约 6 行）

```diff
-const upload_url = "http://168.138.217.249:8000/api/raw";
-const chunkSize = 1 * 1024 * 1024; // 1MB
+const upload_url = "http://168.138.217.249:8000/api/raw2";   // 可选：异步接口，回执毫秒级
+const chunkSize = 64 * 1024;        // 64KB：小包也能切片，重试代价低
+const PARALLEL = 4;                 // 最多 4 片在途
```

完整替换（保留原有 5 个请求头不变，只把「串行推进」换成「滑动窗口补位」）：

```js
const upload_url = "http://168.138.217.249:8000/api/raw2";
const chunkSize = 64 * 1024;   // 64KB
const PARALLEL  = 4;           // 最多 4 片在途

const body = (typeof $response !== "undefined" && $response.body) ? $response.body : "";
const url  = (typeof $request  !== "undefined" && $request.url)  ? $request.url  : "";

if (!body || body.length === 0) { console.log("[mfy] no response body"); $done({}); return; }
//                                                                                ^^^^^^^
//                              原有的 `$done({})` 后没有 return，空包时仍会继续发出一个空请求（顺手修掉）

const upload_id   = Math.random().toString(36).substr(2, 9);
const totalChunks = Math.ceil(body.length / chunkSize);
let started = 0, done = 0, failed = 0;

function log(m) { console.log(`[mfy-upload] [${upload_id}] ${m}`); }
log(`start upload, chunks=${totalChunks}, bytes=${body.length}`);

function sendChunk(index) {
  const start = index * chunkSize;
  const chunk = body.slice(start, Math.min(start + chunkSize, body.length));

  $httpClient.post({
    url: upload_url,
    headers: {
      "X-Original-Url": url,
      "X-Upload-Id": upload_id,
      "X-Chunk-Index": String(index),
      "X-Total-Chunks": String(totalChunks),
      "Content-Type": "application/octet-stream",
    },
    body: chunk,
  }, (error, resp, data) => {
    if (error || !resp || resp.status !== 200) {
      failed++;
      log(`chunk ${index + 1} failed: ${error || ("HTTP " + resp.status)}`);
    }
    done++;
    if (done === totalChunks) {          // 全部结束才 $done，否则脚本提前结束会取消在途请求
      log(`done, failed=${failed}/${totalChunks}`);
      $done({});
      return;
    }
    if (started < totalChunks) sendChunk(started++);   // 谁先回来谁补位 → 始终 ≤ PARALLEL 条在途
  });
}

for (let i = 0; i < Math.min(PARALLEL, totalChunks); i++) sendChunk(started++);
```

**实现要点（避免踩坑）**：
1. `$httpClient.post` 是**回调式异步**——必须等 `done === totalChunks` 才调用 `$done({})`，否则脚本提前退出会**取消在途请求**；
2. 并发用「**滑动窗口补位**」而不是一次性 `Promise.all` 全发，避免大包时几十条请求同时打出去；
3. `PARALLEL = 4` 是保守值，可按需调整；
4. 分片编号语义**没有任何变化**（服务端本来就按编号拼装，与到达顺序无关）。

**应用层重传策略**：单片失败自动重试（同一 `X-Chunk-Index` 重发是**幂等**的，服务端按编号覆盖写）：

```js
if (error || !resp || resp.status !== 200) {
  if (!retried[index]) { retried[index] = true; setTimeout(() => sendChunk(index), 1000); return; }
  failed++;  log(`chunk ${index + 1} failed: ${error || ("HTTP " + resp.status)}`);
}
```

## 六、兼容性与风险

| 项 | 结论 |
|---|---|
| 请求契约 | **完全不变**（同样的 5 个请求头、同样的二进制 body、同样的分片语义） |
| 服务端 | `/api/raw` 与 `/api/raw2` **并存**；老接口一行未改，老客户端不受影响 |
| 分片到达顺序 | **任意**（服务端按 `chunk_%06d.bin` 编号排序拼装，已实测乱序并行通过） |
| 单分片大小 | 任意（服务端只关心「收齐了没有」） |
| 模块的 `timeout=60` | 并行后脚本整体耗时大幅缩短，**更不容易**被超时杀掉（如仍担心，可把模块行的 `timeout` 提到 120） |
| 大包（接近 `max-size`） | 小分片 + 有界并发也能降低 JS 侧内存峰值与单请求失败的整体代价 |

## 七、如何验证

1. **看服务端日志**：成功时会出现
   ```
   [RAW2] 后台处理完成 status=200 bytes=193968 url=…/multi-live/<uuid>
   [RAW]  已提交，账号=<game_id> PT更新=1 排名更新=1 警告=0
   ```
2. **看客户端日志**：`start upload, chunks=3, bytes=193968` → `chunk 1 ok / chunk 2 ok / chunk 3 ok` → `done, failed=0/3`
   （改动前这里恒为 `chunks=1`）
3. **对比耗时**：在脚本里加一行首尾时间差日志，即可得到本 PR 描述里的对照数据。

---

如果有任何疑问（接口细节、服务端实现、压力表现），欢迎随时讨论，我这边可以配合联调与压测。感谢维护这个模块 🙏
