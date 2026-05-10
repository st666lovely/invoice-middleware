/**
 * Telegram Module v8
 * FIX CHÍNH: Cache lưu vào file JSON để tồn tại qua restart
 * Webhook nhận tin realtime → lưu vào cache → tìm kiếm từ cache
 *
 * FORMAT CAPTION (ảnh + 4-5 dòng):
 *   myhanh1233
 *   09431231244
 *   CKFP5e0h
 *   Chưa nhận được
 *   Lý do (tùy chọn)
 *
 * REPLY cập nhật:
 *   Đã nhận được ✅
 *   Ghi chú thêm (tùy chọn)
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const logger = require("./logger");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID     = process.env.TELEGRAM_GROUP_ID;
const CACHE_TTL    = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE   = path.join(process.cwd(), "telegram_cache.json");

// In-memory cache
let imageCache = new Map(); // msgId → entry
let textCache  = new Map(); // msgId → entry
let replyIndex = new Map(); // parentId → [childId]

// ── Load/Save cache từ file ───────────────────────────────────────────────────
function saveCache() {
  try {
    const data = {
      images:  [...imageCache.entries()].filter(([,v]) => !v.hash), // Không lưu hash (buffer)
      imagesWithMeta: [...imageCache.entries()].map(([k,v]) => [k, {
        ...v, hash: undefined, // Bỏ hash khi lưu file
      }]),
      texts:   [...textCache.entries()],
      replies: [...replyIndex.entries()],
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
  } catch(e) { logger.debug("saveCache error", {error:e.message}); }
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (data.imagesWithMeta) {
      imageCache = new Map(data.imagesWithMeta.map(([k,v]) => [k, {...v, hash: null}]));
    }
    if (data.texts)   textCache  = new Map(data.texts);
    if (data.replies) replyIndex = new Map(data.replies.map(([k,v]) => [k, Array.isArray(v)?v:[v]]));
    logger.info("Cache loaded from file", { images: imageCache.size, texts: textCache.size });
  } catch(e) { logger.debug("loadCache error", {error:e.message}); }
}

// Auto-save mỗi 5 phút
setInterval(saveCache, 5 * 60 * 1000);

// Load ngay khi khởi động
loadCache();

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * STATUS_MAP: keyword ngắn → canonical status đầy đủ
 * Admin không cần gõ chính xác từng chữ — bot detect bằng keyword ngắn
 * Thứ tự quan trọng: keyword dài/cụ thể đặt TRƯỚC để tránh nhầm
 */
const STATUS_MAP = [
  // 2 trạng thái đặc biệt có link CSKH — detect bằng keyword unique ngắn
  { kw: "hỗ trợ lên điểm",
    full: "Đã nhận được, anh giúp em click vào telegram CSKH để bên em tiện trao đổi và hỗ trợ lên điểm" },
  { kw: "chuyển sai ngân hàng",
    full: "Chuyển sai ngân hàng nhận, anh giúp em click vào telegram CSKH để bên em tiện trao đổi biết thêm thông tin ạ" },

  // Trạng thái thông thường
  { kw: "đã lên điểm",    full: "Đã lên điểm" },
  { kw: "chưa lên điểm",  full: "Chưa lên điểm" },
  { kw: "đã nhận được",   full: "Đã nhận được" },
  { kw: "chưa nhận được", full: "Chưa nhận được" },
  { kw: "đã thanh toán",  full: "Đã thanh toán" },
  { kw: "chờ thanh toán", full: "Chờ thanh toán" },
  { kw: "chờ xác nhận",   full: "Chờ xác nhận thông tin" },
  { kw: "đang xử lý",     full: "Đang xử lý" },
  { kw: "đã xử lý",       full: "Đã xử lý" },
  { kw: "thành công",     full: "Thành công" },
  { kw: "thất bại",       full: "Thất bại" },
  { kw: "đã hủy",         full: "Đã hủy" },
  { kw: "hoàn tiền",      full: "Hóa đơn hoàn tiền" },
  { kw: "lỗi thanh toán", full: "Lỗi thanh toán" },
  { kw: "chưa xác định",  full: "Giao dịch chưa xác định" },
  { kw: "đang kiểm tra",  full: "Đang kiểm tra" },
];

/**
 * Normalize text để so sánh — bỏ dấu câu, lowercase
 * "30/4 tài vụ chưa nhận được tiền" → "30 4 tài vụ chưa nhận được tiền"
 */
function normalizeText(text) {
  return (text||"").toLowerCase()
    .replace(/[\/\-_.,:;!?()[\]{}]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

function detectStatus(text) {
  if (!text) return null;
  const t = normalizeText(text);
  // Thứ tự quan trọng: keyword dài/cụ thể trước để tránh nhầm
  const match = STATUS_MAP.find(s => t.includes(s.kw.toLowerCase()));
  return match ? match.full : null;
}

function normCK(ck) {
  return (ck||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
}

function isPhone(s) {
  return /^(0|\+84)\d{9,10}$/.test(s.replace(/\s/g,""));
}

function cleanPhone(v) {
  const d = v.replace(/\D/g,"");
  return (d.startsWith("84") && d.length===11) ? "0"+d.slice(2) : d;
}

function isCKCode(s) {
  if (!s || s.length < 4 || s.length > 30) return false;
  // CK code chữ+số: CKFP5e0h
  if (/^[A-Za-z0-9]{4,30}$/.test(s) && /[A-Za-z]/.test(s) && /[0-9]/.test(s)) return true;
  // Mã giao dịch thuần số (>= 6 chữ số): 126947749984
  if (/^\d{6,20}$/.test(s)) return true;
  return false;
}

function parseCaption(text) {
  /**
   * FORMAT CAPTION (ảnh + 4-5 dòng):
   *   Dòng 1: Username
   *   Dòng 2: Số điện thoại
   *   Dòng 3: Nội dung CK / Mã giao dịch
   *   Dòng 4: Lý do (tùy chọn)
   *   Dòng 5: Trạng thái
   *
   * Ví dụ:
   *   myhanh1233
   *   09431231244
   *   CKFP5e0h
   *   Lý do (tùy chọn)
   *   Chưa nhận được
   */
  if (!text) return {};
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  // Dòng 1: username — cố định
  const username = lines[0] || null;
  // Dòng 2: số điện thoại (lưu vào fullname để tương thích)
  const fullname = lines[1] || null;

  let ckCode=null, status=null, note=null;

  for (let i=2; i<lines.length; i++) {
    const line = lines[i];

    // Tìm trạng thái trước
    const s = detectStatus(line);
    if (s && !status) { status=s; continue; }

    // Dòng 3: CK code — số thuần >= 6 chữ số (mã GD ngân hàng)
    if (!ckCode && /^\d{6,30}$/.test(line)) {
      ckCode = line; continue;
    }

    // Dòng 3: CK code — chữ + số mix (VD: CKFP5e0h, SG30T74N)
    if (!ckCode && /^[A-Za-z0-9]{4,30}$/.test(line) && /[A-Za-z]/.test(line) && /[0-9]/.test(line)) {
      ckCode = normCK(line); continue;
    }

    // Dòng còn lại → lý do / ghi chú
    if (!note) note = line;
  }

  // Fallback: tìm CK trong chuỗi kiểu "ACB;48525327;CKFP5e0h"
  if (!ckCode) {
    const m = text.match(/;([A-Za-z]{2,}[0-9][A-Za-z0-9]{1,})\b/);
    if (m) ckCode = normCK(m[1]);
  }

  return { username, fullname, ckCode, orderCode: null, status, note };
}

function parseReplyText(text) {
  /**
   * FORMAT REPLY (4 dòng):
   *   Dòng 1: Ghi chú tự do
   *   Dòng 2: Ghi chú tự do
   *   Dòng 3: Ghi chú tự do
   *   Dòng 4: Trạng thái mới
   *
   * Trường hợp đặc biệt:
   *   1 dòng → trạng thái luôn
   *   2 dòng → dòng 1 ghi chú, dòng 2 trạng thái
   *   3 dòng → dòng 1+2 ghi chú, dòng 3 trạng thái
   *   4+ dòng → dòng 1+2+3 ghi chú, dòng 4+ trạng thái ← FORMAT CHUẨN
   */
  if (!text) return { status: null, note: null };
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  if (lines.length === 1) {
    return { status: detectStatus(lines[0]), note: null };
  }
  if (lines.length === 2) {
    return {
      status: detectStatus(lines[1]) || detectStatus(lines[0]),
      note:   detectStatus(lines[1]) ? lines[0] : null,
    };
  }
  if (lines.length === 3) {
    const status = detectStatus(lines[2]);
    return {
      status,
      note: status ? [lines[0], lines[1]].join(" | ") : null,
    };
  }

  // 4+ dòng (FORMAT CHUẨN): dòng 1+2+3 = ghi chú, dòng 4+ = trạng thái
  const note       = [lines[0], lines[1], lines[2]].join(" | ");
  const statusText = lines.slice(3).join(" ");
  const status     = detectStatus(statusText);

  return { status, note: status ? note : null };
}

function getLargestPhoto(photos) {
  if (!photos?.length) return null;
  return photos.reduce((a,b)=>a.file_size>b.file_size?a:b);
}

async function getFileUrl(fileId) {
  try {
    const res=await axios.get(`${TELEGRAM_API}/getFile`,{params:{file_id:fileId},timeout:10000});
    const p=res.data.result?.file_path;
    return p?`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${p}`:null;
  } catch(e){return null;}
}

function addReply(parentId,childId) {
  const ch=replyIndex.get(parentId)||[];
  if(!ch.includes(childId))ch.push(childId);
  replyIndex.set(parentId,ch);
}

function getLatestStatus(rootId) {
  // Dùng msgId thay vì message_date để tránh lỗi NaN
  // msgId cao hơn = tin nhắn mới hơn
  let best={status:null,note:null,msgId:-1};
  function traverse(id) {
    const e=imageCache.get(id)||textCache.get(id);
    if(e?.status && id > best.msgId) best={status:e.status,note:e.note||null,msgId:id};
    for(const cid of (replyIndex.get(id)||[])) traverse(cid);
  }
  traverse(rootId);
  return best.status?best:null;
}

// ── Index message ─────────────────────────────────────────────────────────────
async function indexMessage(msg) {
  if (!msg||String(msg.chat.id)!==String(GROUP_ID)) return;

  const msgId   =msg.message_id;
  const parentId=msg.reply_to_message?.message_id||null;
  const msgDate =msg.date*1000;
  const text    =msg.text||"";
  const caption =msg.caption||"";

  if(parentId) addReply(parentId,msgId);

  // Tin có ảnh
  const photo=getLargestPhoto(msg.photo);
  if(photo){
    const parsed=parseCaption(caption);
    logger.info("Caption parsed",{msgId,...parsed});
    try {
      const url=await getFileUrl(photo.file_id);
      if(url){
        const buf=await downloadImage(url);
        if(buf){
          const hash=await computeHash(buf);
          const entry={
            message_id:msgId,parent_id:parentId,message_date:msgDate,
            hash,file_id:photo.file_id,
            ck_code:parsed.ckCode,username:parsed.username,
            fullname:parsed.fullname,orderCode:parsed.orderCode,
            status:parsed.status,note:parsed.note,
            cached_at:Date.now(),
          };
          imageCache.set(msgId,entry);
          saveCache();
          logger.info("Image indexed",{msgId,ck:parsed.ckCode,fullname:parsed.fullname,status:parsed.status});
        }
      }
    } catch(e){logger.error("Image index error",{msgId,error:e.message});}
    return;
  }

  // Tin text (reply)
  const{status,note}=parseReplyText(text);
  if(status||parentId){
    textCache.set(msgId,{message_id:msgId,parent_id:parentId,message_date:msgDate,status,note,cached_at:Date.now()});
    if(status){saveCache();logger.info("Reply indexed",{msgId,status,note,parentId});}
  }
}

// Tìm theo CK
function findByCK(searchCK) {
  const n=normCK(searchCK);
  if(!n||n.length<4) return null;
  for(const[id,entry]of imageCache){
    if(Date.now()-entry.cached_at>CACHE_TTL){imageCache.delete(id);continue;}
    const ck=entry.ck_code||"";
    if(ck===n||ck.includes(n)||n.includes(ck)){
      logger.info("CK match",{id,ck,search:n});
      return id;
    }
  }
  return null;
}

// ── MAIN SEARCH ───────────────────────────────────────────────────────────────
async function searchInvoiceByAll({username,fullname,transferContent,imageBuffer}){
  logger.info("=== SEARCH ===",{username,fullname,transferContent,cacheSize:imageCache.size});

  // 1. Tìm theo CK
  let rootId=findByCK(transferContent);

  // 2. Fallback: khớp ảnh
  if(!rootId&&imageBuffer){
    const imgs=[];
    for(const[,img]of imageCache)if(img.hash)imgs.push(img);
    logger.info("Image match attempt",{validImages:imgs.length});
    if(imgs.length){
      const m=await findMatchingInvoice(imageBuffer,imgs);
      if(m){rootId=m.message_id;logger.info("Image match",{rootId});}
    }
  }

  if(!rootId){logger.info("NOT FOUND",{transferContent,cacheSize:imageCache.size});return{found:false};}

  const latest=getLatestStatus(rootId);
  const root=imageCache.get(rootId);
  return{
    found:true,
    status:latest?.status||root?.status||"Đang xử lý",
    note:latest?.note||root?.note||null,
  };
}

async function processUpdate(update){
  const msg=update.message||update.channel_post;
  if(msg) await indexMessage(msg);
}

async function setupWebhook(webhookUrl){
  const res=await axios.post(`${TELEGRAM_API}/setWebhook`,{
    url:`${webhookUrl}/webhook/telegram`,allowed_updates:["message"],drop_pending_updates:false,
  });
  logger.info("Webhook set",{ok:res.data.ok});
}

/**
 * Khởi động: tắt webhook → lấy 200 tin nhắn gần nhất → bật lại webhook
 * Chạy 1 lần khi server start để nạp cache dù server vừa restart
 */
async function warmupCache(webhookUrl) {
  try {
    logger.info("Warming up cache...");

    // 1. Tắt webhook tạm thời
    await axios.post(`${TELEGRAM_API}/deleteWebhook`, { drop_pending_updates: false });
    logger.info("Webhook deleted temporarily");

    // 2. Chờ 1 giây để Telegram xử lý
    await new Promise(r => setTimeout(r, 1000));

    // 3. Lấy 200 tin nhắn gần nhất
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { limit: 200, timeout: 10, allowed_updates: ["message"] },
      timeout: 20000,
    });

    const updates = [...(res.data.result || [])].sort(
      (a, b) => (a.message?.date || 0) - (b.message?.date || 0)
    );

    let indexed = 0;
    for (const u of updates) {
      if (u.message) { await indexMessage(u.message); indexed++; }
    }
    logger.info(`Warmup: fetched ${updates.length} msgs, indexed ${indexed}, images:${imageCache.size}`);

    // 4. Bật lại webhook
    await setupWebhook(webhookUrl);
    logger.info("Webhook re-activated after warmup");

  } catch(e) {
    logger.error("Warmup error", { error: e.message });
    // Dù lỗi vẫn cố bật lại webhook
    try { await setupWebhook(webhookUrl); } catch(_) {}
  }
}

const telegramService={
  processUpdate, setupWebhook, warmupCache,
  getCacheStats:()=>({images:imageCache.size,texts:textCache.size,replies:replyIndex.size}),
};

// Thêm trạng thái mới vào runtime không cần restart
function addRuntimeStatus({kw, full, emoji}) {
  STATUS_MAP.unshift({ kw: kw.toLowerCase(), full, emoji: emoji||"📋" });
  logger.info("Runtime status added", { kw, full });
}

// Debug: xem nội dung cache chi tiết
function getDebugCache() {
  const images = [...imageCache.entries()].map(([id, e]) => ({
    msgId:     id,
    username:  e.username  || null,
    ck_code:   e.ck_code   || null,
    status:    e.status    || null,
    hasHash:   !!e.hash,
    cached_at: new Date(e.cached_at).toISOString(),
  }));
  const texts = [...textCache.entries()].map(([id, e]) => ({
    msgId:  id,
    parent: e.parent_id,
    status: e.status,
  }));
  return { images, texts, replyCount: replyIndex.size };
}

module.exports={searchInvoiceByAll,telegramService,addRuntimeStatus,getDebugCache};
