"use strict";

// Mapping prefix mã đơn → Group ID Telegram của kênh T3
const PAYMENT_CHANNEL_MAP = {
  "N33PAY":   "-1003895406131",
  "GDPVN":    "-1003694816539",   // GDPAYVN
  "SPPAY":    "-1003716238196",
  "THUYPAY": "-1003828299681",   // THUYPHATPAY
  "YOUPAYS":  "-1003761701169",
};

// Tập hợp tất cả Group ID của T3 (để nhận dạng tin nhắn từ nhóm T3)
const T3_GROUP_IDS = new Set(Object.values(PAYMENT_CHANNEL_MAP));

// Lấy Group ID của kênh T3 từ remarks (dựa vào prefix mã đơn)
function resolveChannelGroup(remarks) {
  if (!remarks) return null;
  const upper = remarks.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = Object.keys(PAYMENT_CHANNEL_MAP)
    .sort((a, b) => b.length - a.length) // Khớp prefix dài trước
    .find(p => upper.startsWith(p));
  return prefix ? PAYMENT_CHANNEL_MAP[prefix] : null;
}

function isT3Group(chatId) {
  return T3_GROUP_IDS.has(String(chatId));
}

module.exports = { PAYMENT_CHANNEL_MAP, T3_GROUP_IDS, resolveChannelGroup, isT3Group };
