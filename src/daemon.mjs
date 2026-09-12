import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getUpdates, sendMessage, DEFAULT_BASE_URL } from './ilink.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const AGY_BIN = process.env.AGY_BIN || path.join(os.homedir(), '.local', 'bin', 'agy');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('\x1b[31m%s\x1b[0m', '错误: 未检测到配置文件 config.json。请先运行 `npm run login` 完成微信扫码绑定！');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const { botToken, baseUrl = DEFAULT_BASE_URL } = config;
let userId = config.userId;

let currentCwd = config.defaultCwd || process.env.HOME;
let continueSession = false;
let isBusy = false;
let currentTask = null; // 记录当前运行中任务的快照与子进程句柄
let updatesBuf = '';

console.log('\x1b[32m%s\x1b[0m', '=== 反重力 Agent 微信 ClawBot 桥接守护进程已启动 ===');
console.log(`- 目标微信 User ID: ${userId || '等待首条消息自动绑定'}`);
console.log(`- 默认执行目录: ${currentCwd}`);
console.log(`- 反重力引擎: ${AGY_BIN}`);
console.log('正在长轮询监听微信消息...\n');

/**
 * 格式化任务聚合快报卡片
 */
function formatTaskSummary(task, elapsed) {
  const parts = [];
  parts.push(`⏱️ [阶段进展 · 已耗时 ${elapsed}s]`);
  parts.push(`• 当前阶段: ${task.phase || '分析与执行中'}`);

  if (task.filesRead.size > 0) {
    const arr = Array.from(task.filesRead);
    const sample = arr.slice(0, 2).join(', ');
    const countHint = arr.length > 2 ? ` 等 ${arr.length} 个文件` : '';
    parts.push(`• 📖 读取文件: ${sample}${countHint}`);
  }

  if (task.commandsRun.length > 0) {
    const lastCmd = task.commandsRun[task.commandsRun.length - 1];
    const shortCmd = lastCmd.length > 40 ? lastCmd.slice(0, 40) + '...' : lastCmd;
    const countHint = task.commandsRun.length > 1 ? ` (共 ${task.commandsRun.length} 条)` : '';
    parts.push(`• ⚙️ 执行终端: \`${shortCmd}\`${countHint}`);
  }

  if (task.filesModified.size > 0) {
    const arr = Array.from(task.filesModified);
    const sample = arr.slice(0, 2).join(', ');
    const countHint = arr.length > 2 ? ` 等 ${arr.length} 个文件` : '';
    parts.push(`• ✏️ 写入修改: ${sample}${countHint}`);
  }

  if (task.searches.length > 0) {
    const lastQ = task.searches[task.searches.length - 1];
    const shortQ = lastQ.length > 25 ? lastQ.slice(0, 25) + '...' : lastQ;
    parts.push(`• 🔍 检索信息: ${shortQ}`);
  }

  parts.push(`• 📍 当前动作: ${task.currentAction}`);
  parts.push(`━━━━━━━━━━━━━━━\n(回复 ? 或 /status 看详情，/abort 可中止)`);
  return parts.join('\n');
}

/**
 * 执行反重力 CLI (agy) - 采用 stream-json 实时流式事件与 35s 聚合推送
 */
function runAgy(prompt, cwd, onProgress) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (continueSession) {
      args.push('--continue');
    }

    console.log(`[Agent] 执行: agy ${args.join(' ')} (cwd: ${cwd})`);
    const startTime = Date.now();

    const child = spawn(AGY_BIN, args, {
      cwd,
      env: { ...process.env, PAGER: 'cat', TERM: 'xterm-256color' },
    });

    currentTask = {
      child,
      prompt,
      startTime,
      stepCount: 0,
      toolCount: 0,
      filesRead: new Set(),
      filesModified: new Set(),
      commandsRun: [],
      searches: [],
      currentAction: 'Agent 正在分析需求并规划中...',
      phase: '任务分析与筹备',
      lastSummaryTime: startTime,
      isAborted: false,
    };

    let finalResponse = '';
    let lineBuffer = '';
    let fallbackStdout = '';
    let stderr = '';

    // 周期性阶段战报定时器（方案1：短任务 < 28s 静默零打扰，长任务每 35s 聚合多合一汇总）
    const summaryTimer = setInterval(() => {
      if (!currentTask || currentTask.isAborted) return;
      const now = Date.now();
      const elapsed = Math.floor((now - currentTask.startTime) / 1000);
      const timeSinceLastSummary = now - currentTask.lastSummaryTime;

      if (elapsed >= 28 && timeSinceLastSummary >= 35000) {
        currentTask.lastSummaryTime = now;
        onProgress(formatTaskSummary(currentTask, elapsed));
      }
    }, 4000);

    function handleAgyEvent(evt) {
      if (!evt || typeof evt !== 'object') return;

      if (evt.event === 'step_update' && evt.step_update) {
        const step = evt.step_update;
        currentTask.stepCount = Math.max(currentTask.stepCount, (step.step_index || 0) + 1);

        if (step.step_type === 'tool' && step.state === 'ACTIVE') {
          currentTask.toolCount++;
          const tName = step.tool_name;
          const params = step.tool_info?.parameters || {};

          if (tName === 'run_command') {
            const cmd = (params.CommandLine || '').trim();
            if (cmd) currentTask.commandsRun.push(cmd);
            currentTask.currentAction = `⚙️ 执行命令: ${cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd}`;
            currentTask.phase = '终端运行与验证';
          } else if (tName === 'view_file') {
            const f = path.basename(params.AbsolutePath || '');
            if (f) currentTask.filesRead.add(f);
            currentTask.currentAction = `📖 查看文件: ${f}`;
            currentTask.phase = '代码与上下文调研';
          } else if (tName === 'replace_file_content' || tName === 'write_to_file' || tName === 'multi_replace_file_content') {
            const f = path.basename(params.TargetFile || '');
            if (f) currentTask.filesModified.add(f);
            currentTask.currentAction = `✏️ 编写修改: ${f}`;
            currentTask.phase = '代码与文档编写';
          } else if (tName === 'grep_search' || tName === 'search_web') {
            const q = (params.Query || '').trim();
            if (q) currentTask.searches.push(q);
            currentTask.currentAction = `🔍 检索: ${q.slice(0, 30)}`;
            currentTask.phase = '代码与资料检索';
          } else if (tName === 'list_dir') {
            const d = path.basename(params.DirectoryPath || '') || '工程目录';
            currentTask.currentAction = `📁 浏览目录: ${d}`;
          } else {
            currentTask.currentAction = `🛠️ 调用工具: ${tName}`;
          }

          console.log(`[Agent 动作] ${currentTask.currentAction}`);
          // 彻底取消每个工具的即时打扰推送，所有动作沉淀至 currentTask 统一聚合
        } else if (step.step_type === 'agent_response' && step.state === 'ACTIVE') {
          currentTask.currentAction = 'Agent 正在综合上下文分析规划中...';
        }
      } else if (evt.event === 'result' && evt.result) {
        finalResponse = evt.result.response || '';
      }
    }

    child.stdout.on('data', (d) => {
      const text = d.toString();
      fallbackStdout += text;
      lineBuffer += text;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          handleAgyEvent(parsed);
        } catch (e) {
          // 忽略非 JSON 原始输出
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearInterval(summaryTimer);
      const durationMs = Date.now() - startTime;
      currentTask = null;
      resolve({
        success: false,
        output: `执行启动失败: ${err.message}`,
        durationMs,
      });
    });

    child.on('close', (code, signal) => {
      clearInterval(summaryTimer);
      const durationMs = Date.now() - startTime;
      const wasAborted = currentTask?.isAborted || signal === 'SIGTERM';

      const filesReadCount = currentTask?.filesRead.size || 0;
      const filesModCount = currentTask?.filesModified.size || 0;
      const cmdCount = currentTask?.commandsRun.length || 0;
      const summaryParts = [];
      if (filesReadCount) summaryParts.push(`读${filesReadCount}文件`);
      if (cmdCount) summaryParts.push(`跑${cmdCount}命令`);
      if (filesModCount) summaryParts.push(`改${filesModCount}文件`);
      const stepSummary = summaryParts.length ? ` · ${summaryParts.join('/')}` : '';

      currentTask = null;

      console.log(`[Agent] 执行结束 (code: ${code}, signal: ${signal}, 耗时: ${(durationMs / 1000).toFixed(1)}s)${stepSummary}`);
      continueSession = true;

      if (wasAborted) {
        resolve({
          success: false,
          aborted: true,
          output: '任务已被用户手动远程中止。',
          durationMs,
          stepSummary,
        });
        return;
      }

      let resultText = finalResponse.trim();
      if (!resultText) {
        const cleanOut = fallbackStdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
        resultText = cleanOut;
      }
      if (!resultText && stderr) {
        const cleanErr = stderr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
        resultText = `stderr:\n${cleanErr}`;
      }
      if (!resultText) {
        resultText = '任务已完成（无文字输出）。';
      }

      resolve({
        success: code === 0,
        output: resultText,
        durationMs,
        stepSummary,
      });
    });
  });
}

/**
 * 处理收到的微信消息
 */
async function handleMessage(msg) {
  const fromUser = msg.from_user_id;
  const contextToken = msg.context_token;

  // 自愈与自动绑定逻辑
  if (!userId) {
    userId = fromUser;
    config.userId = userId;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[身份绑定] 自动记录首个授权微信 User ID: ${userId}`);
  } else if (fromUser !== userId) {
    console.warn(`[安全拦截] 拦截来自非授权用户的消息 (from: ${fromUser})`);
    return;
  }

  // 1. 尝试获取纯文本消息 (type === 1)
  const textItem = msg.item_list?.find((item) => item.type === 1);
  let text = textItem?.text_item?.text?.trim();

  // 2. 尝试获取语音消息 (type === 3)
  const voiceMsgItem = msg.item_list?.find((item) => item.type === 3);
  if (!text && voiceMsgItem) {
    const voiceText = voiceMsgItem.voice_item?.text?.trim();
    if (voiceText) {
      console.log(`🎤 [收到微信语音转写文字]: "${voiceText}"`);
      text = voiceText;
    } else {
      const playDuration = voiceMsgItem.voice_item?.playtime
        ? (voiceMsgItem.voice_item.playtime / 1000).toFixed(1)
        : null;
      const durationHint = playDuration ? `时长约 ${playDuration} 秒` : '原生语音';
      console.log(`🎤 [收到微信语音消息 (${durationHint})，无转文字内容]`);

      await sendMessage(
        botToken,
        fromUser,
        contextToken,
        `🎤 收到你的语音消息（${durationHint}）。\n当前桥接服务暂未配置语音识别转写模块：\n• 建议长按该语音消息选择【转文字】后发送\n• 或直接使用输入法语音转文字 / 键盘输入发送指令`,
        baseUrl
      );
      return;
    }
  }

  // 3. 处理其他多媒体消息 (图片/文件/视频)
  if (!text) {
    const hasOtherMedia = msg.item_list?.some((i) => [2, 4, 5].includes(i.type));
    if (hasOtherMedia) {
      console.log('[收到多媒体消息 (图片/文件/视频)]');
      await sendMessage(
        botToken,
        fromUser,
        contextToken,
        '📎 收到多媒体消息（图片/文件/视频），当前服务主要处理文本与指令交互。请发送文本需求～',
        baseUrl
      );
    }
    return;
  }

  console.log(`\n📩 [收到微信指令]: "${text}"`);

  // 并发锁保护与运行中任务交互
  if (isBusy && currentTask) {
    // A. 远程强制中止指令
    if (text === '/abort' || text === '/stop' || text === '终止' || text === '取消') {
      console.log('[收到远程中止指令]');
      currentTask.isAborted = true;
      try {
        currentTask.child.kill('SIGTERM');
      } catch (err) {
        console.error('Kill task failed:', err);
      }
      await sendMessage(botToken, fromUser, contextToken, '🛑 已发送中止信号，正在停止当前 Agent 任务...', baseUrl);
      return;
    }

    // B. 运行时状态主动探针（支持 /status, /progress, ?, 进度, 到哪了）
    if (
      text === '/status' ||
      text === '/progress' ||
      text === '进度' ||
      text === '到哪了' ||
      text === '怎么样了' ||
      text === '?' ||
      text === '？'
    ) {
      const elapsed = Math.floor((Date.now() - currentTask.startTime) / 1000);
      const statusReport = formatTaskSummary(currentTask, elapsed);
      await sendMessage(botToken, fromUser, contextToken, statusReport, baseUrl);
      return;
    }

    // C. 其它指令友好提示
    const elapsed = Math.floor((Date.now() - currentTask.startTime) / 1000);
    await sendMessage(
      botToken,
      fromUser,
      contextToken,
      `⏳ 任务正在执行中（已耗时 ${elapsed}s）\n当前动作: ${currentTask.currentAction}\n• 发送 ? 或 /status 查看合并阶段战报\n• 发送 /abort 可强制中止当前任务。`,
      baseUrl
    );
    return;
  }

  // 空闲状态下的内置快捷指令
  if (text === '/help') {
    const helpMsg = `🤖 反重力 Agent 手机终端指南：
━━━━━━━━━━━━━━━
• 直接输入任务：让 Agent 查代码、跑测试、写脚本
• /status : 查看电脑状态（若任务正在执行则查看实时进度）
• /abort : 强制中止当前正在运行的任务
• /cd <路径> : 切换当前 Agent 所在的工程目录
• /new : 清除上下文，开启全新会话
• /help : 查看本帮助信息
━━━━━━━━━━━━━━━
当前目录: ${currentCwd}`;
    await sendMessage(botToken, fromUser, contextToken, helpMsg, baseUrl);
    return;
  }

  if (text === '/status') {
    const memFree = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const memTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const uptimeHours = (os.uptime() / 3600).toFixed(1);
    const statusMsg = `🖥️ Linux 本机运行状态：
━━━━━━━━━━━━━━━
• 状态: 在线 (空闲) 🟢
• 主机名: ${os.hostname()} (${os.platform()} ${os.arch()})
• 运行时长: ${uptimeHours} 小时
• 内存使用: 剩余 ${memFree}G / 共 ${memTotal}G
• 当前工作区: ${currentCwd}
• 会话模式: ${continueSession ? '连续上下文' : '全新会话'}`;
    await sendMessage(botToken, fromUser, contextToken, statusMsg, baseUrl);
    return;
  }

  if (text.startsWith('/cd ')) {
    let target = text.slice(4).trim();
    if (target.startsWith('~')) {
      target = path.join(os.homedir(), target.slice(1));
    } else if (!path.isAbsolute(target)) {
      target = path.resolve(currentCwd, target);
    }

    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      currentCwd = target;
      await sendMessage(botToken, fromUser, contextToken, `📁 工作区已切换至：\n${currentCwd}`, baseUrl);
    } else {
      await sendMessage(botToken, fromUser, contextToken, `❌ 目录不存在: ${target}`, baseUrl);
    }
    return;
  }

  if (text === '/new') {
    continueSession = false;
    await sendMessage(botToken, fromUser, contextToken, '🔄 会话上下文已重置，下一条指令将作为新任务启动。', baseUrl);
    return;
  }

  isBusy = true;
  try {
    // 先给微信快速回执一个进度提示
    await sendMessage(
      botToken,
      fromUser,
      contextToken,
      `⚡ 任务已派发至本机 Agent，正在执行：\n"${text.length > 50 ? text.slice(0, 50) + '...' : text}"`,
      baseUrl
    );

    // 进度回调函数
    const onProgress = async (progressText) => {
      try {
        await sendMessage(botToken, fromUser, contextToken, progressText, baseUrl);
      } catch (err) {
        console.warn(`[进度推送失败] ${err.message}`);
      }
    };

    // 调用反重力 Agent 执行
    const result = await runAgy(text, currentCwd, onProgress);

    const seconds = (result.durationMs / 1000).toFixed(1);
    let replyHeader = '';
    if (result.aborted) {
      replyHeader = `🛑 [任务已中止 · 耗时 ${seconds}s${result.stepSummary || ''}]\n\n`;
    } else if (result.success) {
      replyHeader = `✅ [任务完成 · 耗时 ${seconds}s${result.stepSummary || ''}]\n\n`;
    } else {
      replyHeader = `⚠️ [任务异常退出 · 耗时 ${seconds}s${result.stepSummary || ''}]\n\n`;
    }

    await sendMessage(botToken, fromUser, contextToken, `${replyHeader}${result.output}`, baseUrl);
  } catch (err) {
    console.error('[执行异常]:', err);
    await sendMessage(botToken, fromUser, contextToken, `❌ 执行出错: ${err.message}`, baseUrl);
  } finally {
    isBusy = false;
    currentTask = null;
  }
}

/**
 * 守护进程长轮询主循环
 */
async function startDaemonLoop() {
  while (true) {
    try {
      const updates = await getUpdates(botToken, updatesBuf, baseUrl, 35000);
      if (updates && (updates.ret === 0 || updates.ret === undefined)) {
        if (updates.get_updates_buf) {
          updatesBuf = updates.get_updates_buf;
        }

        if (Array.isArray(updates.msgs) && updates.msgs.length > 0) {
          for (const msg of updates.msgs) {
            await handleMessage(msg);
          }
        }
      } else if (updates && updates.ret !== 0) {
        console.warn(`[getUpdates 警告] ret=${updates.ret} errmsg=${updates.errmsg}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.warn(`[网络波动，自动重试] ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startDaemonLoop().catch((err) => {
  console.error('Daemon fatal crash:', err);
  process.exit(1);
});
