import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcodeTerminal from 'qrcode-terminal';
import { getBotQrCode, pollQrCodeStatus, DEFAULT_BASE_URL } from './ilink.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

async function main() {
  console.log('\x1b[36m%s\x1b[0m', '=== 微信 ClawBot 扫码登录绑定 ===\n');
  console.log('正在请求微信官方 iLink Bot 登录二维码...');

  let qrData;
  try {
    qrData = await getBotQrCode();
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', `获取二维码失败: ${err.message}`);
    process.exit(1);
  }

  const { qrcode, qrcode_img_content } = qrData;
  if (!qrcode || !qrcode_img_content) {
    console.error('\x1b[31m%s\x1b[0m', '返回的二维码数据异常:', qrData);
    process.exit(1);
  }

  console.log('\n请使用【手机微信】扫描以下二维码进行授权绑定：\n');
  qrcodeTerminal.generate(qrcode_img_content, { small: true });

  console.log('\n如果终端二维码排版异常，你可以直接在浏览器打开此链接扫码：');
  console.log('\x1b[34m%s\x1b[0m\n', qrcode_img_content);
  console.log('等待扫码中（请在手机微信确认授权）...');

  let scanned = false;
  while (true) {
    try {
      const statusRes = await pollQrCodeStatus(qrcode);
      const status = statusRes.status;

      if (status === 'wait') {
        process.stdout.write('.');
      } else if (status === 'scaned') {
        if (!scanned) {
          console.log('\n\x1b[33m%s\x1b[0m', '✔ 手机已扫码，请在微信端点击【确认登录】...');
          scanned = true;
        }
      } else if (status === 'confirmed') {
        console.log('\n\n\x1b[32m%s\x1b[0m', '🎉 授权成功！微信 ClawBot 与本机已完成绑定！');
        const config = {
          botToken: statusRes.bot_token,
          userId: statusRes.user_id,
          baseUrl: statusRes.baseurl || DEFAULT_BASE_URL,
          authorizedAt: new Date().toISOString(),
          defaultCwd: process.env.AGY_DEFAULT_CWD || process.env.HOME || process.cwd(),
        };

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`凭据已安全保存至: ${CONFIG_PATH}`);
        console.log(`绑定的微信 User ID: ${config.userId}`);
        console.log('\n你现在可以运行以下命令启动后台守护服务：');
        console.log('\x1b[36m%s\x1b[0m', '  npm start\n');
        process.exit(0);
      } else if (status === 'expired') {
        console.log('\n\x1b[31m%s\x1b[0m', '❌ 二维码已过期，请重新运行此命令。');
        process.exit(1);
      }
    } catch (err) {
      console.warn(`\n[重试中] 轮询网络波动: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
