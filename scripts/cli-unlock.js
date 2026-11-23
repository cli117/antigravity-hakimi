#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  detectAgyCliBinary,
  analyzeAgyCli,
  applyAgyCliUnlock,
} = require(path.join(__dirname, '..', 'payload', 'dist', 'meter-cli-unlock.js'));

function parseArgs(argv) {
  const opts = {
    action: 'analyze',
    binaryPath: null,
    mode: 'dynamic',
    limitTokens: null,
    strict: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--analyze') opts.action = 'analyze';
    else if (a === '--apply') opts.action = 'apply';
    else if (a === '--binary') opts.binaryPath = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--limit') opts.limitTokens = Number(argv[++i]);
    else if (a === '--strict') opts.strict = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node scripts/cli-unlock.js [--analyze|--apply] [--binary <path>] [--mode <default|fixed|dynamic>] [--limit <tokens>] [--strict] [--json]'
      );
      process.exit(0);
    } else if (!a.startsWith('--') && !opts.binaryPath) {
      opts.binaryPath = a;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  const res = opts.action === 'apply'
    ? applyAgyCliUnlock(opts)
    : analyzeAgyCli(opts.binaryPath || null, opts);

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (opts.action === 'apply') {
    if (!res.ok) {
      console.error(`❌ agy CLI 修补失败: ${res.error}`);
      if (/EACCES|EPERM/i.test(String(res.error || ''))) {
        console.error('💡 提示: 目标 agy 二进制所在目录无写权限，可尝试使用 sudo 执行或将 agy 安装到 ~/.local/bin/agy');
      }
      process.exit(1);
    }
    console.log(`✅ ${res.message}`);
    if (res.targetPath) {
      console.log(`  目标文件: ${res.targetPath}`);
    }
    if (res.brokenSymlinks && res.brokenSymlinks.length) {
      for (const b of res.brokenSymlinks) {
        console.log(`⚠️  发现失效软链接: ${b.path} -> ${b.target || 'unknown'}`);
      }
    }
    if (!res.found) {
      console.log('💡 提示: 如 agy 位于自定义路径，可传 --binary <path> 或设置 AGY_CLI_BIN=<path>');
    }
    if (res.syncedConfigs && res.syncedConfigs.length) {
      console.log(`  同步配置: ${res.syncedConfigs.join(', ')}`);
    }
  } else {
    if (!res.found) {
      console.log(`[not_found] ${res.message}`);
      if (res.brokenSymlinks && res.brokenSymlinks.length) {
        for (const b of res.brokenSymlinks) {
          console.log(`  broken symlink: ${b.path} -> ${b.target || 'unknown'}`);
        }
      }
    } else {
      const targetMeta = res.format && res.arch ? `${res.format} ${res.arch}` : 'unknown';
      const parts = [
        `offersContextWindow=${res.offersContextWindow?.status}`,
        `autoCompactEnv=${res.autoCompactEnv?.status}`,
      ];
      if (res.regionUnlock) {
        parts.push(`regionUnlock=${res.regionUnlock.status}`);
      }
      if (res.checkpointUnlock) {
        const ck = res.checkpointUnlock;
        const ckLabel = ck.configuredMode
          ? `${ck.configuredMode}${ck.configuredLimitTokens ? `:${ck.configuredLimitTokens}` : ''}`
          : ck.status;
        parts.push(`checkpointConfig=${ckLabel}`);
      }
      console.log(`[${res.status}] ${res.realPath} (${targetMeta}; ${parts.join(', ')})`);
    }
  }
  process.exit(res.ok ? 0 : 1);
}

module.exports = {
  detectAgyCliBinary,
  analyzeAgyCli,
  applyAgyCliUnlock,
};
