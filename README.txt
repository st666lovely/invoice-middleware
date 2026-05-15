# ST666 Playwright BO Remark Test

## Files
- `server.js` → thay vào `src/server.js`
- `boBrowser.js` → thêm mới vào `src/boBrowser.js`
- `package.json` → tham khảo để thêm `playwright`

## Render ENV cần thêm
BO_LOGIN_URL=https://bo.bo666st.com/login
BO_DEPOSIT_URL=https://bo.bo666st.com/depositAudit
BO_USERNAME=
BO_PASSWORD=

## Render Build Command khuyến nghị
npm install && npx playwright install chromium

## Start Command
npm start

## Flow
Web bấm Hối thúc HĐ
→ server gọi Playwright
→ login BO
→ vào Deposit Audit
→ nhập Player ID
→ bấm Search
→ lấy cột Deposit Remark
→ đưa vào dòng 4 caption Telegram
