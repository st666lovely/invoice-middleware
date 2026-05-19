# ST666 Full Fixed Backend Files

## Thay file
1. `server.js` → thay vào `src/server.js`
2. `boBrowser.js` → thêm/thay vào `src/boBrowser.js`
3. `package.json` → thay file `package.json` ở root repo

## Render Environment cần có
BO_LOGIN_URL=
BO_DEPOSIT_URL=
BO_USERNAME=
BO_PASSWORD=
PLAYWRIGHT_BROWSERS_PATH=0

## Render Build Command
npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium

## Render Start Command
npm start

## Deploy
Manual Deploy → Clear build cache & deploy
