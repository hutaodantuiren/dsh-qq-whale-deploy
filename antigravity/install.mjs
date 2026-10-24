#!/usr/bin/env node
/**
 * 一键部署 Antigravity 反代 Gemini（Windows）。
 *
 * 做四件事：
 *   1. 用 pnpm 装 bun + antigravity-proxy 到 <dsh-home>/antigravity
 *   2. 复制一份 proxy 工作目录，并打上本机需要的补丁（端口 / OAuth 回调 / 工具结果名 / 客户端版本 / 模型目录 UA / 原子写）
 *   3. 生成 start-proxy.cmd（带梯子代理环境变量）
 *   4. 给 DSH 的 sdk / desktop profile 加 llm-pi-ai provider，并写入凭据占位
 *
 * 用法：
 *   node install.mjs [--dsh-home <dir>] [--port 3457] [--vpn-proxy http://127.0.0.1:2712] [--no-profiles]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const DSH_HOME = path.resolve(arg('--dsh-home', path.join(os.homedir(), '.dsh')));
const PORT = Number(arg('--port', '3457'));
const VPN = arg('--vpn-proxy', 'http://127.0.0.1:2712');
const SKIP_PROFILES = argv.includes('--no-profiles');
const INSTALL_DIR = path.join(DSH_HOME, 'antigravity');
const PROXY_DIR = path.join(INSTALL_DIR, 'proxy');

function log(...a) { console.log('[antigravity]', ...a); }
function fail(msg) { console.error(`[antigravity] 失败：${msg}`); process.exit(1); }

function findNode() {
  const candidates = [
    process.execPath,
    process.env.DSH_DESKTOP_NODE_EXECUTABLE,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    'node',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'node') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

function findPnpm() {
  if (process.env.PNPM_CMD) return process.env.PNPM_CMD.split(' ');
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
    'E:/code/deepseekharness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return [findNode(), c];
  }
  return ['pnpm'];
}

function run(command, args, cwd, { allowFailure = false } = {}) {
  log(`$ ${[command, ...args].join(' ')}`);
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0 && !allowFailure) fail(`命令失败：${command} ${args.join(' ')}（exit ${r.status}）`);
  return r.status === 0;
}

function findBun() {
  const root = path.join(INSTALL_DIR, 'node_modules', '.pnpm');
  if (!fs.existsSync(root)) return '';
  for (const entry of fs.readdirSync(root)) {
    if (!entry.startsWith('@oven+bun-windows-x64@')) continue;
    const exe = path.join(root, entry, 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

// ---------- 源码补丁 ----------
function patchFile(file, marker, apply) {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(marker)) {
    log('已打过补丁，跳过', path.basename(file));
    return;
  }
  const after = apply(before);
  if (after === before) fail(`补丁锚点没匹配上：${file}`);
  fs.writeFileSync(file, after);
  log('已打补丁', path.basename(file));
}

function applyPatches(dir) {
  const p = (...s) => path.join(dir, ...s);

  patchFile(p('src/server.ts'), 'process.env.PROXY_PORT', (s) =>
    s.replace(/port:\s*3000,\s*\n\s*hostname:\s*"0\.0\.0\.0",/,
      'port: Number(process.env.PROXY_PORT || process.env.PORT || 3457),\n  hostname: "127.0.0.1",'));

  patchFile(p('src/utils/headers.ts'), 'process.env.ANTIGRAVITY_VERSION', (s) =>
    s.replace('const ANTIGRAVITY_VERSION = "1.15.8";',
      '// 客户端版本决定 Google 返回的模型目录（1.15.8 只到 3.5，2.5.5 才有 3.8）\nconst ANTIGRAVITY_VERSION = process.env.ANTIGRAVITY_VERSION || "2.5.5";'));

  patchFile(p('src/utils/headers.ts'), 'process.env.OAUTH_REDIRECT_URI', (s) =>
    s.replace('redirectUri: "http://localhost:3000/oauth-callback"',
      'redirectUri: process.env.OAUTH_REDIRECT_URI || "http://localhost:3000/oauth-callback"'));

  patchFile(p('src/utils/transform.ts'), 'toolNameById', (s) => {
    const anchor = 'const contents = otherMessages.map((msg: any) => {';
    if (!s.includes(anchor)) return s;
    const inject = `const toolNameById = new Map<string, string>();
  for (const m of openaiBody.messages) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && tc?.function?.name) toolNameById.set(String(tc.id), String(tc.function.name));
      }
    }
  }

  const contents = otherMessages.map((msg: any) => {`;
    return s
      .replace(anchor, inject)
      .replace('name: msg.name || "function_result",', 'name: msg.name || toolNameById.get(String(msg.tool_call_id)) || "function_result",');
  });

  patchFile(p('src/api/quota.ts'), 'UA 里的版本号决定', (s) =>
    s.replace(/\s*"User-Agent":\s*"antigravity",\n/, '\n        // UA 里的版本号决定模型目录，这里不要覆盖\n'));

  patchFile(p('src/auth/storage.ts'), 'rename(tmp, ACCOUNTS_FILE)', (s) => {
    let out = s;
    if (!out.includes('from "node:fs/promises"')) {
      out = out.replace('import { join } from "path";', 'import { join } from "path";\nimport { rename } from "node:fs/promises";');
    }
    return out.replace(
      /await Bun\.write\(ACCOUNTS_FILE, JSON\.stringify\(config, null, 2\)\);/,
      '// 原子写：并发保存时直接 Bun.write 会把文件写坏\n    const tmp = `${ACCOUNTS_FILE}.tmp`;\n    await Bun.write(tmp, JSON.stringify(config, null, 2));\n    await rename(tmp, ACCOUNTS_FILE);',
    );
  });

  patchFile(p('src/server.ts'), 'running on http://127.0.0.1:${', (s) =>
    s.replace('console.log("Antigravity Proxy running on http://127.0.0.1:3000");',
      'console.log(`Antigravity Proxy running on http://127.0.0.1:${process.env.PROXY_PORT || process.env.PORT || 3457}`);'));
}

// ---------- 生成启动脚本 ----------
function writeStartScript(bun) {
  const file = path.join(INSTALL_DIR, 'start-proxy.cmd');
  const lines = [
    '@echo off',
    'rem Antigravity Gemini reverse proxy. Requires the VPN on %VPN%.',
    'setlocal',
    `set "HTTPS_PROXY=${VPN}"`,
    `set "HTTP_PROXY=${VPN}"`,
    'set "NO_PROXY=127.0.0.1,localhost"',
    `set "OAUTH_REDIRECT_URI=http://localhost:${PORT}/oauth-callback"`,
    `set "PROXY_PORT=${PORT}"`,
    `set "ANTIGRAVITY_VERSION=2.5.5"`,
    `cd /d "${PROXY_DIR}"`,
    '',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',${PORT});$c.Close();exit 0}catch{exit 1}" >nul 2>&1`,
    'if not errorlevel 1 (',
    `  echo Antigravity proxy already running on ${PORT}.`,
    '  exit /b 0',
    ')',
    '',
    `start "" /min "${bun}" src/server.ts`,
    `echo Antigravity proxy starting on http://127.0.0.1:${PORT}`,
  ];
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
  log('已生成', file);
}

// ---------- DSH profile ----------
function providerBlock(port) {
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      antigravity:',
    '        displayName: Antigravity Gemini',
    '        apiKeyEnv: ANTIGRAVITY_API_KEY',
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${port}/v1`,
    '        models:',
    '          - id: gemini-3.8-flash-medium',
    '            name: Gemini 3.8 Flash Medium (Antigravity)',
    '            contextWindow: 1048576',
    '            maxTokens: 65536',
    '            input: [text, image]',
    '          - id: gemini-3.8-flash-high',
    '            name: Gemini 3.8 Flash High (Antigravity)',
    '            contextWindow: 1048576',
    '            maxTokens: 65536',
    '            input: [text, image]',
    '          - id: gemini-3.8-flash-low',
    '            name: Gemini 3.8 Flash Low (Antigravity)',
    '            contextWindow: 1048576',
    '            maxTokens: 65536',
    '            input: [text, image]',
    '',
  ].join('\n');
}

function patchProfiles(port) {
  for (const name of ['sdk', 'desktop']) {
    const dir = path.join(DSH_HOME, 'profiles', name);
    const file = path.join(dir, 'cordis.patch.yml');
    if (!fs.existsSync(file)) { log(`没有 ${name} profile，跳过`); continue; }
    let text = fs.readFileSync(file, 'utf8');
    if (text.includes('providers:') && text.includes('antigravity:')) { log(`${name} profile 已有 antigravity，跳过`); continue; }
    const block = providerBlock(port);
    if (/^\[\]\s*$/m.test(text)) {
      // 模板 profile 只有注释 + 一个空数组，直接替换掉，否则追加会变成非法 YAML
      text = text.replace(/^\[\]\s*$/m, block.trimEnd());
    } else {
      text = text.trimEnd() + '\n\n' + block;
    }
    if (name === 'sdk') {
      text += '\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: antigravity\n    model: gemini-3.8-flash-medium\n';
    }
    fs.writeFileSync(file, text);
    log(`已更新 ${name} profile`);
  }

  const cred = path.join(DSH_HOME, '.credentials.yaml');
  if (fs.existsSync(cred)) {
    let text = fs.readFileSync(cred, 'utf8');
    if (!text.includes('ANTIGRAVITY_API_KEY')) {
      if (/^refs:\s*$/m.test(text)) text = text.replace(/^refs:\s*$/m, 'refs:\n  ANTIGRAVITY_API_KEY: antigravity-local');
      else text = text.trimEnd() + '\nrefs:\n  ANTIGRAVITY_API_KEY: antigravity-local\n';
      fs.writeFileSync(cred, text);
      log('已写入凭据占位 ANTIGRAVITY_API_KEY');
    }
  } else {
    fs.writeFileSync(cred, 'version: 1\nrefs:\n  ANTIGRAVITY_API_KEY: antigravity-local\n');
    log('已创建 .credentials.yaml');
  }
}

// ---------- main ----------
function main() {
  log('DSH home:', DSH_HOME, '| port:', PORT, '| vpn:', VPN);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  if (!fs.existsSync(path.join(INSTALL_DIR, 'package.json'))) {
    fs.writeFileSync(path.join(INSTALL_DIR, 'package.json'), JSON.stringify({ name: 'dsh-antigravity-runtime', private: true, version: '0.0.0' }, null, 2) + '\n');
  }

  if (!fs.existsSync(path.join(INSTALL_DIR, 'node_modules', 'antigravity-proxy'))) {
    const [cmd, ...prefix] = findPnpm();
    // pnpm 会因为「忽略 bun 的 build script」返回 exit 1，但包其实已经装好了，放宽处理。
    run(cmd, [...prefix, 'add', 'bun', 'antigravity-proxy'], INSTALL_DIR, { allowFailure: true });
  } else {
    log('依赖已存在，跳过安装');
  }

  const src = path.join(INSTALL_DIR, 'node_modules', 'antigravity-proxy');
  if (!fs.existsSync(src)) fail('没找到 antigravity-proxy，检查 pnpm 安装');
  if (fs.existsSync(PROXY_DIR)) {
    if (fs.existsSync(path.join(PROXY_DIR, 'antigravity-accounts.json'))) {
      log('proxy 目录已存在且已登录账号，保留现状（只重新打补丁）');
    } else {
      fs.rmSync(PROXY_DIR, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(PROXY_DIR)) {
    // dereference：pnpm 的 node_modules 里全是符号链接，Windows 上直接复制会 EPERM
    fs.cpSync(src, PROXY_DIR, { recursive: true, dereference: true });
    log('已复制 proxy 到', PROXY_DIR);
  }

  applyPatches(PROXY_DIR);
  const bun = findBun();
  if (!bun) log('警告：没找到 bun.exe，启动脚本里会留空');
  writeStartScript(bun || 'bun');
  if (!SKIP_PROFILES) patchProfiles(PORT);

  console.log('\n完成。下一步：');
  console.log(`  1. 开梯子（默认 ${VPN}，不是 HK/大陆节点）`);
  console.log(`  2. 运行 ${path.join(INSTALL_DIR, 'start-proxy.cmd')}`);
  console.log(`  3. 浏览器打开 http://127.0.0.1:${PORT}/oauth/start 登录 Google`);
  console.log(`  4. 验证 curl http://127.0.0.1:${PORT}/v1/models`);
  console.log('  5. 重启 DSH；qq-bridge 的 config.json 设 provider=antigravity、model=gemini-3.8-flash-medium、reasoningEffort=""');
  console.log('详见仓库 docs/ANTIGRAVITY.md');
}

main();
