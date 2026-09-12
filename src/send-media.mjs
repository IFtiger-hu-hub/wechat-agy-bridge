#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendImageMessage, sendMessage, DEFAULT_BASE_URL } from './ilink.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Error: config.json not found.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const { botToken, userId, baseUrl = DEFAULT_BASE_URL } = config;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node src/send-media.mjs <image-path> [optional-caption-text]');
  process.exit(1);
}

const filePath = path.resolve(process.cwd(), args[0]);
const caption = args[1] || '';

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

async function run() {
  console.log(`Uploading & sending image to WeChat (${userId})...`);
  if (caption) {
    await sendMessage(botToken, userId, '', caption, baseUrl);
  }
  const res = await sendImageMessage(botToken, userId, '', filePath, baseUrl);
  console.log('Image pushed successfully!', res);
}

run().catch((err) => {
  console.error('Push failed:', err);
  process.exit(1);
});
