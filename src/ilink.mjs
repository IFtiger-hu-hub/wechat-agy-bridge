import crypto from 'node:crypto';
import fs from 'node:fs';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_APP_ID = 'bot';
export const ILINK_APP_CLIENT_VERSION = '132102';

/**
 * Generate X-WECHAT-UIN header: random uint32 -> decimal string -> base64
 */
export function generateWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/**
 * Build common headers for iLink Bot requests
 */
export function buildHeaders(token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': generateWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export function buildBaseInfo() {
  return {
    channel_version: '2.4.6',
    bot_agent: 'AntigravityBridge/1.0',
  };
}

/**
 * Fetch login QR code from iLink
 */
export async function getBotQrCode(baseUrl = DEFAULT_BASE_URL, botType = '3') {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (!res.ok) {
    throw new Error(`get_bot_qrcode failed with status ${res.status}`);
  }
  return await res.json();
}

/**
 * Long-poll QR code scan status
 */
export async function pollQrCodeStatus(qrcode, baseUrl = DEFAULT_BASE_URL, timeoutMs = 35000) {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`get_qrcode_status failed with status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

/**
 * Long-poll getUpdates to receive incoming messages
 */
export async function getUpdates(token, getUpdatesBuf = '', baseUrl = DEFAULT_BASE_URL, timeoutMs = 35000) {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/getupdates`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf || '',
        base_info: buildBaseInfo(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`getupdates failed with status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/**
 * Send text message to user (auto chunking if text > 4000 chars)
 */
export async function sendMessage(token, toUserId, contextToken, text, baseUrl = DEFAULT_BASE_URL) {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/sendmessage`;
  const maxChunk = 4000;
  const chunks = [];

  for (let i = 0; i < text.length; i += maxChunk) {
    chunks.push(text.substring(i, i + maxChunk));
  }
  if (chunks.length === 0) chunks.push('');

  for (const chunk of chunks) {
    const clientId = crypto.randomBytes(8).toString('hex');
    const payload = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: 1,
            text_item: { text: chunk },
          },
        ],
        context_token: contextToken || '',
      },
      base_info: buildBaseInfo(),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`sendMessage failed ${res.status}: ${errText}`);
    }
    const result = await res.json();
    if (result.ret && result.ret !== 0) {
      throw new Error(`sendMessage error ret=${result.ret} errmsg=${result.errmsg}`);
    }
  }
}

/**
 * Send image to user via iLink Bot Media CDN pipeline
 * @param {string} token - bot token
 * @param {string} toUserId - target user id
 * @param {string} contextToken - context token
 * @param {string|Buffer} imageInput - image file path or Buffer
 * @param {string} baseUrl - iLink base URL
 */
export async function sendImageMessage(token, toUserId, contextToken, imageInput, baseUrl = DEFAULT_BASE_URL) {
  let rawBuffer;
  if (Buffer.isBuffer(imageInput)) {
    rawBuffer = imageInput;
  } else if (typeof imageInput === 'string') {
    if (!fs.existsSync(imageInput)) {
      throw new Error(`Image file not found: ${imageInput}`);
    }
    rawBuffer = fs.readFileSync(imageInput);
  } else {
    throw new Error('imageInput must be a file path or a Buffer');
  }

  const aesKey = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString('hex');
  const clientId = crypto.randomBytes(8).toString('hex');
  const rawSize = rawBuffer.length;
  const rawMd5 = crypto.createHash('md5').update(rawBuffer).digest('hex');

  // AES-128-ECB PKCS7 encryption
  const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
  const encBuffer = Buffer.concat([cipher.update(rawBuffer), cipher.final()]);
  const encSize = encBuffer.length;

  const aesKeyHex = aesKey.toString('hex');
  const aesKeyB64 = Buffer.from(aesKeyHex, 'ascii').toString('base64');

  // Step 1: getuploadurl
  const uploadUrlReq = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/getuploadurl`;
  const uploadUrlRes = await fetch(uploadUrlReq, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      filekey,
      media_type: 1, // 1: image
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: encSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: buildBaseInfo(),
    }),
  });

  if (!uploadUrlRes.ok) {
    const errText = await uploadUrlRes.text();
    throw new Error(`getuploadurl failed ${uploadUrlRes.status}: ${errText}`);
  }
  const uploadData = await uploadUrlRes.json();
  if (uploadData.ret && uploadData.ret !== 0) {
    throw new Error(`getuploadurl error ret=${uploadData.ret} errmsg=${uploadData.errmsg}`);
  }

  let cdnUrl = uploadData.upload_full_url;
  if (!cdnUrl) {
    cdnUrl = `${baseUrl.replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadData.upload_param || '')}&filekey=${encodeURIComponent(filekey)}`;
  }

  // Step 2: Upload encrypted bytes to CDN
  const cdnRes = await fetch(cdnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: encBuffer,
  });

  if (!cdnRes.ok) {
    throw new Error(`CDN upload failed with status ${cdnRes.status}`);
  }

  const encryptQueryParam = cdnRes.headers.get('x-encrypted-param') || '';

  // Step 3: Send message with image_item
  const sendUrl = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/sendmessage`;
  const sendPayload = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 2, // 2: image_item
          image_item: {
            media: {
              encrypt_query_param: encryptQueryParam,
              aes_key: aesKeyB64,
              encrypt_type: 1,
            },
            mid_size: encSize,
          },
        },
      ],
      context_token: contextToken || '',
    },
    base_info: buildBaseInfo(),
  };

  const sendRes = await fetch(sendUrl, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(sendPayload),
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`sendImageMessage failed ${sendRes.status}: ${errText}`);
  }
  const sendResult = await sendRes.json();
  if (sendResult.ret && sendResult.ret !== 0) {
    throw new Error(`sendImageMessage error ret=${sendResult.ret} errmsg=${sendResult.errmsg}`);
  }
  return sendResult;
}
