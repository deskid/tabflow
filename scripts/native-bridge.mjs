#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const CODEX_AUTH_PATH = path.join(HOME, '.codex', 'auth.json');
const CODEX_MODELS_URL = 'http://127.0.0.1:3425/v1/models';
const CODEX_PROXY_URL = 'http://127.0.0.1:3425/v1/chat/completions';

const DEFAULT_SYSTEM_PROMPT = `你是一个专业的浏览器标签页整理助手。请根据标签页的标题与网址，将其归纳整理为 2 到 6 个逻辑清晰的主题组。组名简明扼要（2 到 6 个汉字），并分配合适的颜色。`;

// Chrome Native Messaging Protocol (4-byte length prefix uint32-LE)
function sendMessage(msg) {
  const jsonStr = JSON.stringify(msg);
  const buffer = Buffer.from(jsonStr, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buffer.length, 0);
  process.stdout.write(header);
  process.stdout.write(buffer);
}

function getCodexAccount() {
  try {
    if (!fs.existsSync(CODEX_AUTH_PATH)) {
      return { loggedIn: false, error: 'Codex auth file not found' };
    }
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf8'));
    let email = '已登录用户';
    let exp = null;

    if (auth.tokens?.access_token) {
      try {
        const payloadBase64 = auth.tokens.access_token.split('.')[1];
        const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
        email = payload['https://api.openai.com/profile']?.email || payload.email || email;
        exp = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
      } catch {
        // ignore
      }
    }

    return {
      loggedIn: true,
      email,
      authMode: auth.auth_mode || 'chatgpt',
      accountId: auth.tokens?.account_id || null,
      exp,
    };
  } catch (err) {
    return { loggedIn: false, error: String(err) };
  }
}

async function getAvailableModels() {
  try {
    const res = await fetch(CODEX_MODELS_URL);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.data)) {
        return data.data.map(m => ({
          id: m.id,
          name: m.display_name || m.id,
        }));
      }
    }
  } catch {
    // ignore
  }

  // Fallback recommended models
  return [
    { id: 'antigravity/gemini-3.8-flash', name: 'Gemini 3.8 Flash (推荐/极速)' },
    { id: 'deepseek/deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'auto/gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'auto/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'antigravity/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ];
}

async function classifyTabs(tabs, customPrompt, model) {
  const account = getCodexAccount();
  const userInstruction = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
  const targetModel = model || 'antigravity/gemini-3.8-flash';

  const fullPrompt = `${userInstruction}

必须严格输出 JSON 数组，格式为：
[
  { "name": "组名", "color": "blue", "tabIds": [101, 102] }
]
可选颜色仅限：grey, blue, red, yellow, green, pink, purple, cyan。除 JSON 数组外不要输出任何其他说明文字。`;

  try {
    const summary = tabs.map(t => ({ id: t.id, title: t.title, url: t.url }));

    const res = await fetch(CODEX_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: fullPrompt },
          { role: 'user', content: JSON.stringify(summary) }
        ],
        max_tokens: 800
      })
    });

    if (res.ok) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      const match = content.match(/\[\s*\{.*\}\s*\]/s);
      if (match) {
        const groups = JSON.parse(match[0]);
        return { success: true, groups, account, modelUsed: targetModel };
      }
    }
  } catch (err) {
    // If local proxy temporarily unavailable
  }

  return { success: true, fallback: true, account };
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('readable', async () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);

    while (inputBuffer.length >= 4) {
      const msgLen = inputBuffer.readUInt32LE(0);
      if (inputBuffer.length < 4 + msgLen) {
        break;
      }

      const msgBytes = inputBuffer.subarray(4, 4 + msgLen);
      inputBuffer = inputBuffer.subarray(4 + msgLen);

      try {
        const msg = JSON.parse(msgBytes.toString('utf8'));
        await handleMessage(msg);
      } catch (err) {
        sendMessage({ success: false, error: String(err) });
      }
    }
  }
});

async function handleMessage(msg) {
  if (msg.action === 'PING') {
    sendMessage({ success: true, pong: true, version: '1.0.0' });
  } else if (msg.action === 'GET_CODEX_ACCOUNT') {
    const account = getCodexAccount();
    sendMessage({ success: true, account });
  } else if (msg.action === 'GET_MODELS') {
    const models = await getAvailableModels();
    sendMessage({ success: true, models });
  } else if (msg.action === 'CLASSIFY_TABS') {
    const result = await classifyTabs(msg.tabs || [], msg.customPrompt, msg.model);
    sendMessage(result);
  } else {
    sendMessage({ success: false, error: `Unknown action: ${msg.action}` });
  }
}
