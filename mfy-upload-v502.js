// MFY PT Tracker 自动上报 —— v4.1 诊断版
//
// 1. 每一步都打日志，方便定位到底断在哪；
// 2. 兼容 body / bodyBytes 为 ArrayBuffer、Uint8Array、base64 字符串、raw 字符串；
// 3. 只上传模块 pattern 匹配到的目标响应。

const UPLOAD_VERSION = "v5.0.2-base64-rollback";
// 【2026-09-30 暂时回滚】identity（typed array）通道**全部停用**，一律走 Base64。
// 原因：小火箭对 typed array 的"子视图"会送错字节——第 2 片起 subarray 的 byteOffset != 0
// 被忽略、从头取字节，导致多片大包总长度正确但内容被改写（CBC padding 报错），用户成绩丢数据。
// 下面这段历史说明与 identity 分支保留着，等有内容级验证后再谈重开（把 IDENTITY_MAX_BYTES 调回 >0）。
//
// 原说明：identity（原始字节）只用于"单片"包（<=64KB）。
// 实测（2026-09-30，uid …1878053 / iPad16,5 / Shadowrocket 2701）：
//   6 片 / 328,112 B 与 6 片 / 367,280 B 的包，服务端收到的**总长度一字不差**，但内容被改写
//   （CBC 只看最后一组 → "无效 padding：195" / "padding 校验失败"）；
//   而所有单片 identity 包（100+ 条真实收菜包）解密全部正常，base64 通道多片包 7/7 正常。
// 即：小火箭对 typed array 的**子视图**（第 2 片起 byteOffset != 0）会送错字节。
// 所以 >64KB（必然多片）一律回退 base64 —— 宁可少省 25%，也不能丢 PT/成绩数据。
const IDENTITY_MAX_BYTES = 0;   // 0 = 停用 identity，全部走 Base64（暂时回滚）

const upload_url = "http://167.234.217.255:8000/api/raw2";
const MIN_CHUNK  = 64 * 1024;   // 64KB 起步：小包也切得开
const BURST      = 8;           // 一轮最多派发几片（回调不会回来，必须一次发完）

const TARGET_HOSTS = {
  "mkcn-prod-public-60001-1.dailygn.com": true,
  "mkcn-prod-public-60001-2.dailygn.com": true
};

function log(message) {
  console.log("[mfy-upload] " + message);
}

function isTargetUrl(url) {
  try {
    url = String(url);
    const m = url.match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
    if (!m) return false;

    const host = m[1].toLowerCase().split(":")[0];
    if (!TARGET_HOSTS[host]) return false;

    const path = m[2].split("?")[0];
    if (path.indexOf("/api/user/") !== 0) return false;

    if (path.indexOf("/mysekai/harvest") >= 0) return true;
    if (path.indexOf("/mysekai/tutorial/harvest") >= 0) return true;
    if (path.indexOf("/multi-live/") >= 0) return true;

    if (path.indexOf("/rank-match-season/") >= 0) {
      return path.indexOf("/live/") >= 0 && url.indexOf("type=result") >= 0;
    }

    if (path.indexOf("/live/") >= 0) return true;
    if (path.indexOf("/challenge-live/solo/") >= 0) return true;

    return false;
  } catch (e) {
    return false;
  }
}

function bytesToBase64(u8) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const b1 = u8[i];
    const b2 = i + 1 < u8.length ? u8[i + 1] : 0;
    const b3 = i + 2 < u8.length ? u8[i + 2] : 0;

    out += B64[b1 >> 2];
    out += B64[((b1 & 3) << 4) | (b2 >> 4)];
    out += (i + 1 < u8.length) ? B64[((b2 & 15) << 2) | (b3 >> 6)] : "=";
    out += (i + 2 < u8.length) ? B64[b3 & 63] : "=";
  }
  return out;
}

function stringToBase64(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytesToBase64(bytes);
}

function looksLikeBase64(s) {
  if (typeof s !== "string") return false;
  const clean = s.replace(/[\r\n\t ]/g, "");
  return clean.length > 0 && clean.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
}

function getBase64Body() {
  const resp = (typeof $response !== "undefined") ? $response : null;
  if (!resp) {
    log("FATAL: no $response object");
    return { data: "", source: "none" };
  }

  const bb = resp.bodyBytes;
  if (bb) {
    if (typeof ArrayBuffer !== "undefined" && bb instanceof ArrayBuffer) {
      return { data: bytesToBase64(new Uint8Array(bb)), source: "bodyBytes:ArrayBuffer:" + bb.byteLength };
    }
    if (typeof Uint8Array !== "undefined" && bb instanceof Uint8Array) {
      return { data: bytesToBase64(bb), source: "bodyBytes:Uint8Array:" + bb.length };
    }
    if (typeof bb === "string") {
      if (looksLikeBase64(bb)) {
        return { data: bb.replace(/[\r\n\t ]/g, ""), source: "bodyBytes:base64-string:" + bb.length };
      }
      return { data: stringToBase64(bb), source: "bodyBytes:raw-string:" + bb.length };
    }
    log("WARN: bodyBytes unknown type=" + (typeof bb));
  }

  const b = resp.body;
  if (b) {
    if (typeof ArrayBuffer !== "undefined" && b instanceof ArrayBuffer) {
      return { data: bytesToBase64(new Uint8Array(b)), source: "body:ArrayBuffer:" + b.byteLength };
    }
    if (typeof Uint8Array !== "undefined" && b instanceof Uint8Array) {
      return { data: bytesToBase64(b), source: "body:Uint8Array:" + b.length };
    }
    if (typeof b === "string") {
      if (looksLikeBase64(b)) {
        return { data: b.replace(/[\r\n\t ]/g, ""), source: "body:base64-string:" + b.length };
      }
      return { data: stringToBase64(b), source: "body:raw-string:" + b.length };
    }
    log("WARN: body unknown type=" + (typeof b));
  }

  return { data: "", source: "empty" };
}

function getRawBytes() {
  // 优先拿原始字节：只有这条路能配合 X-Body-Encoding: identity，省掉 base64 的 33% 与 CPU。
  const resp = (typeof $response !== "undefined") ? $response : null;
  if (!resp) return { bytes: null, source: "none" };
  const bb = resp.bodyBytes;
  if (bb) {
    if (typeof ArrayBuffer !== "undefined" && bb instanceof ArrayBuffer) {
      return { bytes: new Uint8Array(bb), source: "bodyBytes:ArrayBuffer:" + bb.byteLength };
    }
    if (typeof Uint8Array !== "undefined" && bb instanceof Uint8Array) {
      return { bytes: bb, source: "bodyBytes:Uint8Array:" + bb.length };
    }
    return { bytes: null, source: "bodyBytes:" + (typeof bb) };
  }
  const b = resp.body;
  if (b) {
    if (typeof ArrayBuffer !== "undefined" && b instanceof ArrayBuffer) {
      return { bytes: new Uint8Array(b), source: "body:ArrayBuffer:" + b.byteLength };
    }
    if (typeof Uint8Array !== "undefined" && b instanceof Uint8Array) {
      return { bytes: b, source: "body:Uint8Array:" + b.length };
    }
  }
  return { bytes: null, source: "no-bytes:" + (typeof b) };
}

function startUpload() {
let released = false;
// $done 只能放行一次；提前放行后，收尾路径再调用它是无害的空操作。
function release() {
  if (released) return;
  released = true;
  $done({});
}

let url = "";
try {
  url = (typeof $request !== "undefined" && $request.url)
    ? String($request.url)
    : "";
} catch (e) {
  log("FATAL: read $request.url failed: " + e);
}

log("trigger url=" + url);

if (!url) {
  log("FATAL: $request.url is empty, cannot upload");
  release();
  return;
}

if (!isTargetUrl(url)) {
  log("SKIP: url not target: " + url);
  release();
  return;
}

const bodyInfo = getBase64Body();
log("body source=" + bodyInfo.source + ", base64Len=" + bodyInfo.data.length);

if (!bodyInfo.data || bodyInfo.data.length === 0) {
  log("FATAL: no response body data");
  release();
  return;
}

const raw = getRawBytes();
let mode = "identity";
let payloadBytes = null;
let payloadText = "";
if (raw.bytes && raw.bytes.length > 0 && raw.bytes.length <= IDENTITY_MAX_BYTES) {
  payloadBytes = raw.bytes;
} else {
  mode = "base64";   // 兜底：>64KB（多片）、或 $response 给不出 typed array（老版小火箭）
  payloadText = bodyInfo.data;
}

function dispatchAll(useIdentity) {
  const upload_id = Math.random().toString(36).substr(2, 9);
  if (!useIdentity && !payloadText) {
    payloadText = payloadBytes ? bytesToBase64(payloadBytes) : bodyInfo.data;
  }
  const total = useIdentity ? payloadBytes.length : payloadText.length;
  const chunkSize = Math.max(MIN_CHUNK, Math.ceil(total / BURST));
  const totalChunks = Math.ceil(total / chunkSize);
  const encoding = useIdentity ? "identity" : "base64";
  log("version=" + UPLOAD_VERSION + ", upload_id=" + upload_id + ", mode=" + encoding +
      ", source=" + raw.source + ", bytes=" + total + ", chunks=" + totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, total);
    $httpClient.post({
      url: upload_url,
      headers: {
        "X-Original-Url": url,
        "X-Upload-Version": UPLOAD_VERSION,
        "X-Upload-Id": upload_id,
        "X-Chunk-Index": String(i),
        "X-Total-Chunks": String(totalChunks),
        "X-Body-Encoding": encoding,
        "Content-Type": "application/octet-stream",
      },
      body: useIdentity ? payloadBytes.subarray(start, end) : payloadText.slice(start, end),
    }, function () {});
  }
  return totalChunks;
}

// 一次性把分片交给网络栈（毫秒级），随后立刻放行响应体 —— 游戏不等上传。
// identity 抛异常（老版小火箭不认 typed array）时，整包改用 base64 重发：已发出的 identity 分片
// 会挂在一个永远收不齐的 upload_id 上（15 分钟后自动清理），不会污染这一包的数据。
try {
  log("DISPATCH_ALL mode=" + mode + " chunks=" + dispatchAll(mode === "identity") + " -> release response");
} catch (exc) {
  log("identity 派发抛异常，整包回退 base64: " + exc);
  log("DISPATCH_ALL mode=base64-fallback chunks=" + dispatchAll(false));
}
release();
}

startUpload();
