# Serverga qo'yish (Production)

## Tayyorlik checklist

- [x] Bot kodi tayyor (`src/`)
- [x] MongoDB (Atlas yoki server MongoDB)
- [x] `.env` serverda (gitga yuklanmaydi)
- [ ] Serverda `yt-dlp` o'rnatilgan
- [ ] Serverda `ffmpeg` o'rnatilgan (audio uchun)
- [ ] `ADMIN_IDS` to'g'ri ID bilan to'ldirilgan
- [ ] Bot token xavfsiz (hech kimga ko'rsatilmagan)

## Server talablari

- Ubuntu 22.04+ (yoki boshqa Linux)
- Node.js **20+**
- RAM: kamida **1 GB** (2 GB tavsiya)
- Disk: **5 GB+**

## 1. Serverga ulanish

```bash
ssh root@SERVER_IP
```

## 2. Tizim paketlari

```bash
sudo apt update
sudo apt install -y curl git ffmpeg

# yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2
sudo npm install -g pm2
```

## 3. Loyihani yuklash

```bash
cd /opt
sudo git clone YOUR_REPO_URL save-bot
cd save-bot
npm install --production
```

## 4. `.env` yaratish

```bash
cp .env.example .env
nano .env
```

Majburiy:

```env
TELEGRAM_BOT_TOKEN=...
MONGODB_URI=mongodb+srv://...
NODE_ENV=production
ADMIN_IDS=5079701692
YTDLP_BINARY=/usr/local/bin/yt-dlp
REQUIRED_CHANNEL_USERNAME=Islom_Anvar
DOWNLOAD_CONCURRENCY=4
BROADCAST_CONCURRENCY=28
BROADCAST_DELAY_MS=35
```

## 5. Ishga tushirish (PM2)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Ko'rish:

```bash
pm2 status
pm2 logs save-bot
```

Qayta ishga tushirish:

```bash
pm2 restart save-bot
```

## 6. Tekshirish

1. Telegramda botga `/start` yozing
2. Instagram/YouTube link yuboring
3. Admin: lichkada `/admin` yoki `/users`

## Xavfsizlik

- `.env` hech qachon GitHubga commit qilmang
- Token ochilgan bo'lsa: BotFather → `/revoke` → yangi token
- `ADMIN_IDS` faqat o'z ID ingiz

## Muammo bo'lsa

```bash
which yt-dlp
yt-dlp --version
pm2 logs save-bot --lines 100
```

MongoDB ulanmagan bo'lsa `MONGODB_URI` ni tekshiring (IP whitelist Atlas da: `0.0.0.0/0` yoki server IP).
