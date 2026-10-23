/* GordonDrop 面板逻辑 (Cloudflare Workers 版) */
const $ = (s) => document.querySelector(s);
let FILES = [], SHARES = [];

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}
function fmtSize(n) {
  n = +n || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function fmtDate(ms) {
  return new Date(+ms || 0).toLocaleString("zh-CN", { hour12: false }).slice(0, 16);
}
function kindOf(mime) {
  mime = mime || "";
  if (mime.startsWith("video")) return "video";
  if (mime.startsWith("image")) return "image";
  if (mime.startsWith("audio")) return "audio";
  return "file";
}
async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = "/login.html"; throw new Error("未登录"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("请求失败 " + r.status));
  return j;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

/* ---------- 视图切换 ---------- */
document.querySelectorAll(".nav-item").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#view-" + b.dataset.view).classList.remove("hidden");
    if (b.dataset.view === "shares") loadShares();
    if (b.dataset.view === "settings") loadSysinfo();
  })
);

/* ---------- 文件库 ---------- */
async function loadFiles() {
  const q = $("#search").value.trim();
  const j = await api("/api/files" + (q ? "?q=" + encodeURIComponent(q) : ""));
  FILES = j.files;
  renderFiles();
  const st = await api("/api/stats");
  $("#storageText").textContent = `${st.count} 个文件 · 共 ${fmtSize(st.bytes)} · ${st.shares} 个分享`;
  $("#storageBar").style.width = Math.min(100, st.count) + "%";
}
function renderFiles() {
  $("#emptyFiles").classList.toggle("hidden", FILES.length > 0);
  $("#fileList").innerHTML = FILES.map((f) => `
    <div class="file-row">
      <div class="file-icon ${kindOf(f.mime)}"></div>
      <div class="file-info">
        <div class="file-name">${esc(f.name)}</div>
        <div class="file-sub">${fmtSize(f.size)} · ${fmtDate(f.created_at)}</div>
      </div>
      <div class="file-actions">
        <button class="btn primary" onclick="openShare('${f.id}', '${escAttr(f.name)}')">分享</button>
        <button class="btn danger" onclick="delFile('${f.id}')">删除</button>
      </div>
    </div>`).join("");
}
$("#search").addEventListener("input", () => {
  clearTimeout($("#search")._t);
  $("#search")._t = setTimeout(loadFiles, 300);
});

async function delFile(id) {
  if (!confirm("确定删除这个文件吗？R2 上的源文件也会一起删除。")) return;
  await api("/api/files?id=" + encodeURIComponent(id), { method: "DELETE" });
  toast("已删除");
  loadFiles();
}

/* ---------- 上传（预签名 URL 直传 R2，带进度） ---------- */
const dz = $("#dropzone"), fi = $("#fileInput");
$("#uploadBtn").onclick = () => fi.click();
dz.onclick = () => fi.click();
["dragover", "dragenter"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (ev) => uploadMany(ev.dataTransfer.files));
fi.addEventListener("change", () => { uploadMany(fi.files); fi.value = ""; });

async function uploadMany(files) {
  for (const f of files) uploadOne(f);
}
function uploadOne(file) {
  const box = document.createElement("div");
  box.className = "up-item";
  box.innerHTML = `<div class="up-top"><span>${esc(file.name)}</span><span class="pct">准备…</span></div><div class="up-bar"><i></i></div>`;
  $("#uploadList").prepend(box);
  const bar = box.querySelector(".up-bar i"), pct = box.querySelector(".pct");

  (async () => {
    // 1. 拿预签名上传地址
    const init = await api("/api/upload-url", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || "application/octet-stream" }),
    });
    // 2. 浏览器直传 R2（不经过 Worker）
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", init.upload_url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + "%"; pct.textContent = p + "%";
        }
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("R2 返回 " + xhr.status)));
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.send(file);
    });
    // 3. 确认入库
    await api("/api/files/complete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: init.id, r2_key: init.r2_key, name: file.name, size: file.size, mime: file.type || "application/octet-stream" }),
    });
    box.classList.add("done"); pct.textContent = "完成 ✓";
    setTimeout(() => box.remove(), 2500);
    loadFiles();
  })().catch((e) => {
    box.classList.add("error"); pct.textContent = "失败";
    toast("上传失败：" + e.message);
  });
}

/* ---------- 二维码（纯本地生成，不经过任何第三方服务） ---------- */
// 依赖 public/js/qrcode.js（qrcode-generator 1.4.4, MIT, Kazuhiko Arase）
// typeNumber=0 自动选版本，纠错等级 M；分享 URL 一般 40~60 字符，容量充足。
// 画布按 8 倍像素绘制再由 CSS 缩到 220px，截图/下载都清晰。
function drawQr(canvas, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4; // 静区（白边）至少 4 个模块，缺了它很多扫码器认不出
  const total = count + margin * 2;
  const cell = 8;
  const size = total * cell;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // 必须黑白高对比：深色底上直接放黑码扫不出来
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
    }
  }
  canvas._qrText = text;
}
function downloadQr(canvas, name) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = name || "gordondrop-share-qr.png";
  a.click();
}

/* ---------- 分享 ---------- */
let shareFileId = null;
function openShare(id, name) {
  shareFileId = id;
  $("#shareFileName").textContent = name;
  $("#shareResult").classList.add("hidden");
  const qc = $("#shareQrCanvas");
  if (qc) { qc.width = 0; qc.height = 0; qc._qrText = ""; }
  $("#sharePwd").value = "";
  $("#shareViews").value = "";
  $("#shareModal").classList.remove("hidden");
}
$("#shareCancel").onclick = () => $("#shareModal").classList.add("hidden");
$("#shareCreate").onclick = async () => {
  try {
    const days = $("#shareExpire").value ? +$("#shareExpire").value : null;
    const maxViews = $("#shareViews").value ? +$("#shareViews").value : null;
    const j = await api("/api/shares", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: shareFileId,
        expires_in_days: days,
        max_views: maxViews,
        password: $("#sharePwd").value,
      }),
    });
    const shareUrl = location.origin + "/f/" + j.token;
    $("#shareUrl").value = shareUrl;
    $("#shareResult").classList.remove("hidden");
    // 有密码时扫码也绕不过去：仍打开 /f/xxx 后在分享页输密码，这里提前说清
    $("#shareQrPwdHint").classList.toggle("hidden", !$("#sharePwd").value);
    drawQr($("#shareQrCanvas"), shareUrl);
    loadShares();
  } catch (e) { toast(e.message); }
};
$("#shareQrDownload").onclick = () => downloadQr($("#shareQrCanvas"), "gordondrop-" + shareFileId + "-qr.png");
$("#copyBtn").onclick = async () => {
  await navigator.clipboard.writeText($("#shareUrl").value);
  toast("链接已复制");
};

async function loadShares() {
  const j = await api("/api/shares");
  SHARES = j.shares;
  $("#emptyShares").classList.toggle("hidden", SHARES.length > 0);
  $("#shareList").innerHTML = SHARES.map((s) => {
    const exp = s.expires_at ? fmtDate(s.expires_at) + " 到期" : "永久有效";
    const gone = s.expires_at && s.expires_at < Date.now();
    const usedUp = s.max_views && s.views >= s.max_views;
    return `
    <div class="file-row">
      <div class="file-icon ${kindOf(s.mime)}"></div>
      <div class="file-info">
        <div class="file-name">${esc(s.name)}
          ${s.has_password ? '<span class="tag pwd">密码</span>' : ""}
          ${gone ? '<span class="tag exp">已过期</span>' : ""}
          ${usedUp ? '<span class="tag exp">次数用完</span>' : ""}
        </div>
        <div class="file-sub"><a href="/f/${s.token}" target="_blank">/f/${s.token}</a> · ${exp}${s.max_views ? " · 最多 " + s.max_views + " 次" : ""} · ${s.views} 次查看</div>
      </div>
      <div class="file-actions">
        <button class="btn" onclick="showShareQr('${s.token}', '${escAttr(s.name)}', ${s.has_password})">二维码</button>
        <button class="btn" onclick="copyShare('${s.token}')">复制</button>
        <button class="btn danger" onclick="delShare('${s.token}')">删除</button>
      </div>
    </div>`;
  }).join("");
}
function showShareQr(token, name, hasPassword) {
  const url = location.origin + "/f/" + token;
  $("#qrFileName").textContent = name + (hasPassword ? "（有密码，扫码后仍需输入密码）" : "");
  $("#qrUrl").value = url;
  drawQr($("#listQrCanvas"), url);
  $("#qrModal").classList.remove("hidden");
}
$("#qrClose").onclick = () => $("#qrModal").classList.add("hidden");
$("#qrModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden"); });
$("#qrCopy").onclick = async () => { await navigator.clipboard.writeText($("#qrUrl").value); toast("链接已复制"); };
$("#qrDownload").onclick = () => downloadQr($("#listQrCanvas"));
async function copyShare(token) {
  await navigator.clipboard.writeText(location.origin + "/f/" + token);
  toast("链接已复制");
}
async function delShare(token) {
  if (!confirm("删除这个分享链接？文件本身不受影响。")) return;
  await api("/api/shares?token=" + encodeURIComponent(token), { method: "DELETE" });
  toast("已删除"); loadShares();
}

/* ---------- 设置 ---------- */
async function loadSysinfo() {
  const box = $("#sysinfo");
  const labels = {
    ADMIN_PASSWORD: "登录密码",
    SESSION_SECRET: "会话密钥",
    CF_ACCOUNT_ID: "Cloudflare 账户 ID",
    D1_DATABASE_ID: "D1 数据库 ID",
    D1_API_TOKEN: "D1 API Token",
    R2_ACCESS_KEY_ID: "R2 Key ID",
    R2_SECRET_ACCESS_KEY: "R2 Secret",
  };
  try {
    const h = await api("/api/health");
    let html = "";
    for (const [k, label] of Object.entries(labels)) {
      html += `<div class="health-row">${h.secrets[k] ? "✅" : "❌"} ${label} <code>${k}</code></div>`;
    }
    html += `<div class="health-row">${h.d1.ok ? "✅" : "❌"} D1 数据库连接${h.d1.ok ? "" : "——" + esc(h.d1.error)}</div>`;
    html += `<div class="health-row">${h.r2.ok ? "✅" : "❌"} R2 存储桶连接${h.r2.ok ? "" : "——" + esc(h.r2.error)}</div>`;
    box.innerHTML = html;
  } catch (e) {
    box.textContent = "❌ " + e.message;
  }
}

loadFiles();
