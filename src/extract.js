/**
 * extract.js — Smart rule-based extraction (không dùng Claude API)
 * Approach: phân loại từng token theo đặc điểm, scoring để tránh nhầm
 */

const logger = require("./logger");

// ── Nhận dạng loại token ──────────────────────────────────────────────────────

function isPhone(s) {
  return /^(\+84|0)\d{9,10}$/.test(s.replace(/[\s\-\.]/g,""));
}

function isCKCode(s) {
  const t = s.replace(/[^A-Za-z0-9]/g,"");
  if (t.length < 4 || t.length > 30) return false;
  const hasLetter = /[A-Za-z]/.test(t);
  const hasDigit  = /[0-9]/.test(t);
  if (!hasLetter || !hasDigit) return false;
  // Số phần số phải >= 4 chữ số HOẶC dạng uppercase ngẫu nhiên
  const digitPart = t.replace(/[A-Za-z]/g,"");
  const letterPart = t.replace(/[0-9]/g,"");
  // "len123" → số chỉ 3 → không phải CK; "CKFP5e0h" → đủ điều kiện
  // Ngoại lệ: nếu uppercase >= 2 ký tự + có số → likely CK
  const hasUppercase = /[A-Z]/.test(t);
  return digitPart.length >= 4 || (hasUppercase && letterPart.length >= 2 && digitPart.length >= 1);
}

function isTxnId(s) {
  // Mã giao dịch thuần số >= 6 chữ số
  return /^\d{6,20}$/.test(s.replace(/[\s\-\.]/g,""));
}

function isFullname(s) {
  const t = s.trim();
  if (t.length < 4 || t.length > 60) return false;
  // Phải có ít nhất 2 từ
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  // KHÔNG được có số
  if (/[0-9]/.test(t)) return false;
  // Phải là chữ cái (có dấu hoặc không)
  if (!/^[A-Za-zÀ-ỹ\s]+$/.test(t)) return false;
  return true;
}

function isUsername(s) {
  // Username: chữ+số, không có khoảng trắng, ngắn
  return /^[A-Za-z0-9@._\-]{2,30}$/.test(s) && !/\s/.test(s);
}

// ── Xử lý label prefix ───────────────────────────────────────────────────────
function stripLabel(text) {
  // "ck: CKFP5e0h" → "CKFP5e0h"
  return text.replace(/^(?:ck|mã\s*ck|nội\s*dung|mã\s*gd|mã\s*giao\s*dịch|ma\s*ck|ma\s*gd|nd|ref|code|họ\s*tên|ho\s*ten|fullname|name|tên)[:\s]+/i,"").trim();
}

// ── Extract chính ─────────────────────────────────────────────────────────────
function extractInfo(text, session) {
  const result = {};
  if (!text) return result;

  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  for (const rawLine of lines) {
    const line = stripLabel(rawLine);

    // Tìm CK code / Mã GD (ưu tiên nếu có label rõ ràng)
    if (!session.transferContent && !result.transferContent) {
      const hasLabel = /(?:ck|mã\s*ck|nội\s*dung|mã\s*gd|mã\s*giao\s*dịch|ma\s*ck|nd|code)[:\s]/i.test(rawLine);
      if (hasLabel) {
        // Tách các token trong value
        const tokens = line.split(/[\s;,]+/);
        for (const tok of tokens) {
          if (isCKCode(tok)) { result.transferContent = tok.toUpperCase(); break; }
          if (isTxnId(tok))  { result.transferContent = tok; break; }
        }
      }
    }

    // Tìm Họ Tên (có label)
    if (!session.fullname && !result.fullname) {
      const hasLabel = /(?:họ\s*tên|ho\s*ten|fullname|tên\s*thật|ten\s*that|name)[:\s]/i.test(rawLine);
      if (hasLabel && isFullname(line)) {
        result.fullname = line;
      }
    }
  }

  // Nếu chưa tìm được → thử parse toàn bộ text theo token
  const allText = text.replace(/\n/g," ");
  const tokens = allText.split(/[\s,;|]+/).filter(Boolean);

  // Pass 1: tìm CK code standalone
  if (!session.transferContent && !result.transferContent) {
    for (const tok of tokens) {
      const clean = tok.replace(/[^A-Za-z0-9]/g,"");
      if (isCKCode(clean)) { result.transferContent = clean.toUpperCase(); break; }
      if (isTxnId(clean) && clean.length >= 8) { result.transferContent = clean; break; }
    }
  }

  // Pass 2: tìm Họ Tên — toàn bộ text nếu là chuỗi chữ thuần 2+ từ
  if (!session.fullname && !result.fullname) {
    const onlyLetters = allText.trim();
    if (isFullname(onlyLetters)) {
      result.fullname = onlyLetters;
    }
  }

  // Pass 3: tìm Mã GD thuần số nếu chưa có gì
  if (!session.transferContent && !result.transferContent) {
    for (const tok of tokens) {
      const clean = tok.replace(/[^0-9]/g,"");
      if (isTxnId(clean)) { result.transferContent = clean; break; }
    }
  }

  // Xác định intent đơn giản
  const t = text.toLowerCase();
  let intent = "provide_info";
  if (Object.keys(result).length === 0) {
    const questionWords = ["tại sao","vì sao","bao giờ","khi nào","làm sao","như thế","có không","được không","sao vậy","sao thế","alo","hello","hi","chào","xin chào"];
    if (questionWords.some(w => t.includes(w)) || (text.endsWith("?") && text.length > 20)) {
      intent = "ask_status";
    } else {
      intent = "other";
    }
  }
  result.intent = intent;

  if (Object.keys(result).length > 1) {
    logger.info("Extract result", { text: text.slice(0,50), result: JSON.stringify(result).slice(0,100) });
  }

  return result;
}

// ── Keyword nhận dạng hóa đơn ────────────────────────────────────────────────
const INVOICE_KW = [
  "hóa đơn","nạp tiền","nạp","chưa lên","chưa nhận","không lên","không nhận",
  "tiền","chuyển khoản","thanh toán","giao dịch","điểm","ngân hàng",
  "kiểm tra","tra cứu","tra soát","lệnh","mã ck","mã gd","bill","biên lai",
  "hoa don","nap tien","chua len","chua nhan","khong len","chuyen khoan",
  "giao dich","kiem tra","tra cuu","ngan hang","ma ck",
  "deposit","payment","transfer","invoice","bank","acb","vcb","mbbank","momo","zalopay",
];

function isInvoiceRelated(text) {
  const t = (text||"").toLowerCase();
  return INVOICE_KW.some(kw => t.includes(kw));
}

module.exports = { extractInfo, isInvoiceRelated };
