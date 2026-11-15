#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const asarEngine = require('../payload/dist/asar-engine');
const modulesConfig = require('../payload/dist/modules-config');
const regionUnlock = require('../payload/dist/meter-region-unlock');
const contextUnlock = require('../payload/dist/meter-context-unlock');
const enhance = require('../payload/dist/meter-enhance');
const cliUnlock = require('../payload/dist/meter-cli-unlock');

function readInfoPlistJson(plistPath) {
  if (!plistPath || !fs.existsSync(plistPath)) return null;
  try {
    if (process.platform === 'darwin') {
      const jsonText = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return JSON.parse(jsonText);
    }
  } catch {}
  try {
    const xml = fs.readFileSync(plistPath, 'utf8');
    const verMatch = xml.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/);
    const asarBlockMatch = xml.match(
      /<key>\s*Resources\/app\.asar\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/
    );
    const hashMatch = asarBlockMatch
      ? asarBlockMatch[1].match(/<key>\s*hash\s*<\/key>\s*<string>\s*([0-9a-fA-F]{64})\s*<\/string>/)
      : null;
    return {
      CFBundleShortVersionString: verMatch ? verMatch[1].trim() : null,
      ElectronAsarIntegrity: hashMatch
        ? { 'Resources/app.asar': { hash: hashMatch[1].toLowerCase(), algorithm: 'SHA256' } }
        : null,
    };
  } catch {
    return null;
  }
}

function getPlistAsarHash(plistObj) {
  return plistObj?.ElectronAsarIntegrity?.['Resources/app.asar']?.hash || null;
}

function resolveOfficialAppPath(explicitFrom) {
  if (explicitFrom) return path.resolve(explicitFrom);
  if (fs.existsSync('/Applications/Antigravity.app.orig')) return '/Applications/Antigravity.app.orig';
  return '/Applications/Antigravity.app';
}

function runDoctor(options = {}) {
  const checks = [];
  const push = (id, level, title, detail, meta = null) => {
    checks.push({ id, level, title, detail, ...(meta ? { meta } : {}) });
  };

  const officialApp = resolveOfficialAppPath(options.officialApp);
  const officialPlist = path.join(officialApp, 'Contents', 'Info.plist');
  const officialAsar = path.join(officialApp, 'Contents', 'Resources', 'app.asar');
  const officialLs = path.join(officialApp, 'Contents', 'Resources', 'bin', 'language_server');

  // 1. Official Antigravity bundle integrity (must stay clean / untouched)
  let officialVersion = null;
  if (!fs.existsSync(officialApp)) {
    push('official_bundle', 'WARN', '官方 Antigravity.app', `未检测到官方包: ${officialApp}`);
  } else {
    const offPlistObj = readInfoPlistJson(officialPlist);
    officialVersion = offPlistObj?.CFBundleShortVersionString || modulesConfig.readBundleShortVersion(officialPlist);
    const expectedHash = getPlistAsarHash(offPlistObj);
    if (!fs.existsSync(officialAsar)) {
      push('official_integrity', 'FAIL', '官方 ASAR 完整性', `缺少 ${officialAsar}`);
    } else {
      try {
        const actualHash = asarEngine.computeAsarHeaderSha256(officialAsar);
        if (expectedHash && actualHash === expectedHash) {
          push('official_integrity', 'OK', '官方 ASAR 完整性', `v${officialVersion || '?'} SHA-256 校验通过`);
        } else {
          push(
            'official_integrity',
            'FAIL',
            '官方 ASAR 完整性',
            `Info.plist hash=${expectedHash || 'none'} 与实际 ${actualHash} 不一致`
          );
        }
      } catch (e) {
        push('official_integrity', 'FAIL', '官方 ASAR 完整性', `读取异常: ${e.message}`);
      }

      const offMods = modulesConfig.inspectDiskModules(officialAsar);
      if (!offMods.meter && !offMods.chinese) {
        push('official_clean_asar', 'OK', '官方纯净隔离守卫', '官方 app.asar 未含任何注入代码');
      } else {
        push(
          'official_clean_asar',
          'FAIL',
          '官方纯净隔离守卫',
          `官方 app.asar 意外检测到注入标记 (meter=${offMods.meter}, chinese=${offMods.chinese})`
        );
      }
    }

    if (!fs.existsSync(officialLs)) {
      push('official_region_unlock', 'WARN', '官方 language_server', `未找到 ${officialLs}`);
    } else {
      try {
        const offReg = regionUnlock.analyzeRegionUnlock(officialLs, { quiet: true });
        if (offReg.status === 'unpatched') {
          push('official_region_unlock', 'OK', '官方地区锁状态', '官方 language_server 保持原始未改状态 (unpatched)');
        } else if (offReg.status === 'patched') {
          push('official_region_unlock', 'FAIL', '官方地区锁状态', '官方 language_server 已被修改，违反只读守卫');
        } else {
          push('official_region_unlock', 'WARN', '官方地区锁状态', `状态 ${offReg.status}: ${offReg.reason || ''}`);
        }
      } catch (e) {
        push('official_region_unlock', 'WARN', '官方地区锁状态', `检测异常: ${e.message}`);
      }
    }
  }

  // 2. Target 哈基米.app inspection
  const hakimiApp = path.resolve(options.appPath || asarEngine.getHakimiAppPath());
  const hakimiPlist = path.join(hakimiApp, 'Contents', 'Info.plist');
  const hakimiAsar = path.join(hakimiApp, 'Contents', 'Resources', 'app.asar');
  const hakimiLs = path.join(hakimiApp, 'Contents', 'Resources', 'bin', 'language_server');

  if (!fs.existsSync(hakimiApp)) {
    push(
      'hakimi_bundle',
      options.allowMissing ? 'WARN' : 'FAIL',
      '哈基米.app 安装状态',
      `未找到目标副本: ${hakimiApp}（可运行 bash ./build-hakimi.sh --force 构建）`
    );
  } else {
    const vs = modulesConfig.checkAppVersionSync({ officialPlist, hakimiPlist });
    if (vs.outdated) {
      push(
        'hakimi_version_sync',
        'WARN',
        '版本同步检查',
        `官方 v${vs.officialVersion} 与 哈基米.app v${vs.hakimiVersion} 不一致，建议运行: bash ./build-hakimi.sh --force --restart`,
        vs
      );
    } else {
      push(
        'hakimi_version_sync',
        'OK',
        '版本同步检查',
        `v${vs.hakimiVersion || '?'}${vs.officialVersion ? ` (与官方 v${vs.officialVersion} 同步)` : ''}`,
        vs
      );
    }

    const hakPlistObj = readInfoPlistJson(hakimiPlist);
    const hakExpectedHash = getPlistAsarHash(hakPlistObj);
    if (!fs.existsSync(hakimiAsar)) {
      push('hakimi_integrity', 'FAIL', '哈基米 ASAR 完整性', `缺少 ${hakimiAsar}`);
    } else {
      try {
        const hakActualHash = asarEngine.computeAsarHeaderSha256(hakimiAsar);
        if (hakExpectedHash && hakActualHash === hakExpectedHash) {
          push('hakimi_integrity', 'OK', '哈基米 ASAR 完整性', `ElectronAsarIntegrity 摘要匹配 (${hakActualHash.slice(0, 12)}…)`);
        } else {
          push(
            'hakimi_integrity',
            'FAIL',
            '哈基米 ASAR 完整性',
            `Info.plist hash=${hakExpectedHash || 'none'} 与实际 ${hakActualHash} 不一致`
          );
        }
      } catch (e) {
        push('hakimi_integrity', 'FAIL', '哈基米 ASAR 完整性', `读取异常: ${e.message}`);
      }

      const mods = modulesConfig.inspectDiskModules(hakimiAsar);
      if (mods.meterReady && mods.chineseReady) {
        push('hakimi_asar_modules', 'OK', '注入模块就绪度', 'Context Meter 监控与简体中文汉化已就绪');
      } else {
        push(
          'hakimi_asar_modules',
          'FAIL',
          '注入模块就绪度',
          `模块状态异常 (meterReady=${mods.meterReady}, chineseReady=${mods.chineseReady}, chinese=${mods.chineseReason || mods.chineseStatus})`
        );
      }

      try {
        const entries = asarEngine.builtinAsar.listPackage(hakimiAsar);
        const missingNew = ['/dist/meter-region-unlock.js', '/dist/meter-cli-unlock.js'].filter(
          (p) => !entries.includes(p)
        );
        if (missingNew.length === 0) {
          push('hakimi_asar_payload', 'OK', '内置扩展载荷', '已包含自适应地区解锁与 CLI 解锁模块');
        } else {
          push(
            'hakimi_asar_payload',
            'WARN',
            '内置扩展载荷',
            `当前已安装的 app.asar 尚未包含 ${missingNew.join(', ')}（构建于此次更新前），建议运行 bash ./build-hakimi.sh --force --restart 更新`
          );
        }
      } catch (e) {
        push('hakimi_asar_payload', 'WARN', '内置扩展载荷', `列表读取异常: ${e.message}`);
      }
    }

    if (!options.skipCodesign && process.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--verify', '--strict', hakimiApp], { stdio: 'pipe' });
        push('hakimi_codesign', 'OK', 'macOS 代码签名', 'codesign --verify --strict 通过');
      } catch (e) {
        const msg = (e.stderr ? e.stderr.toString('utf8').trim() : '') || e.message;
        push('hakimi_codesign', 'FAIL', 'macOS 代码签名', `签名校验失败: ${msg}`);
      }
    }

    if (!fs.existsSync(hakimiLs)) {
      push('hakimi_region_unlock', 'FAIL', 'language_server 二进制', `缺少 ${hakimiLs}`);
    } else {
      try {
        const reg = regionUnlock.analyzeRegionUnlock(hakimiLs, { quiet: true });
        if (reg.status === 'patched') {
          push('hakimi_region_unlock', 'OK', '账号地区解锁补丁', `已生效 (${reg.va || 'ValidateAndOnboardAccount'})`);
        } else {
          push('hakimi_region_unlock', 'FAIL', '账号地区解锁补丁', `未处于已解锁状态: ${reg.status} (${reg.reason || ''})`);
        }
      } catch (e) {
        push('hakimi_region_unlock', 'FAIL', '账号地区解锁补丁', `分析失败: ${e.message}`);
      }

      try {
        const ctxInfo = contextUnlock.analyzeBinary(hakimiLs, {
          skipProcessCheck: true,
          backupDir: options.backupDir,
        });
        const enhInfo = enhance.getEnhanceStatus({
          targets: [{ id: 'desktop', path: hakimiLs }],
          skipProcessCheck: true,
          backupDir: options.backupDir,
        });
        push(
          'hakimi_context_title',
          'OK',
          '上下文与标题补丁状态',
          `上下文=${ctxInfo.configuredMode || ctxInfo.status}${ctxInfo.configuredLimitTokens ? ` (${ctxInfo.configuredLimitTokens})` : ''} · 标题=${enhInfo?.summary?.chineseTitleMode || 'unknown'}`
        );
      } catch (e) {
        push('hakimi_context_title', 'WARN', '上下文与标题补丁状态', `检测异常: ${e.message}`);
      }

      if (!options.skipProcess) {
        try {
          const psOut = execFileSync('ps', ['-ax', '-o', 'pid=,lstart=,command='], {
            encoding: 'utf8',
            env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' },
          });
          const procs = contextUnlock.parseMacPsOutput(psOut, hakimiLs);
          push(
            'hakimi_process',
            'OK',
            '运行进程检测',
            procs.length > 0
              ? `检测到 ${procs.length} 个运行中的 language_server 进程 (PID: ${procs.map((p) => p.pid).join(', ')})`
              : '当前未运行 哈基米.app language_server'
          );
        } catch (e) {
          push('hakimi_process', 'WARN', '运行进程检测', `ps 查询异常: ${e.message}`);
        }
      }
    }
  }

  // 3. Optional agy CLI check (informational WARN when missing or broken symlink)
  try {
    const cliRes = cliUnlock.analyzeAgyCli(options.cliBinaryPath || null, {
      homeDir: options.homeDir,
      backupDir: options.cliBackupDir,
      stateDir: options.stateDir,
    });
    if (cliRes.status === 'patched') {
      push('agy_cli', 'OK', 'agy CLI 解锁状态', `已解锁: ${cliRes.realPath}`);
    } else if (cliRes.status === 'not_found') {
      const symlinkNote =
        Array.isArray(cliRes.brokenSymlinks) && cliRes.brokenSymlinks.length > 0
          ? `；检测到失效软链接: ${cliRes.brokenSymlinks.map((s) => `${s.path} -> ${s.target}`).join(', ')}`
          : '';
      push('agy_cli', 'WARN', 'agy CLI 解锁状态', `未检测到可用 agy CLI 二进制${symlinkNote}（非桌面端必需）`);
    } else {
      push(
        'agy_cli',
        'WARN',
        'agy CLI 解锁状态',
        `状态=${cliRes.status} (${cliRes.realPath || cliRes.binaryPath || ''})，可运行 npm run unlock:cli`
      );
    }
  } catch (e) {
    push('agy_cli', 'WARN', 'agy CLI 解锁状态', `检测异常: ${e.message}`);
  }

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    if (c.level === 'OK') counts.ok++;
    else if (c.level === 'WARN') counts.warn++;
    else counts.fail++;
  }

  return {
    ok: counts.fail === 0,
    checkedAt: new Date().toISOString(),
    officialApp,
    hakimiApp,
    counts,
    checks,
  };
}

function formatReport(report) {
  const lines = [
    `antigravity-hakimi doctor (${report.checkedAt})`,
    `Official: ${report.officialApp}`,
    `Hakimi:   ${report.hakimiApp}`,
    '',
  ];
  for (const c of report.checks) {
    lines.push(`[${c.level.padEnd(4)}] ${c.title}: ${c.detail}`);
  }
  lines.push('');
  lines.push(
    `Summary: ${report.counts.ok} OK, ${report.counts.warn} WARN, ${report.counts.fail} FAIL -> ${report.ok ? 'PASS' : 'FAIL'}`
  );
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app' && argv[i + 1]) opts.appPath = argv[++i];
    else if (a === '--from' && argv[i + 1]) opts.officialApp = argv[++i];
    else if (a === '--allow-missing') opts.allowMissing = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--skip-codesign') opts.skipCodesign = true;
    else if (a === '--skip-process') opts.skipProcess = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: node scripts/doctor.js [--app <path>] [--from <path>] [--allow-missing] [--json]');
      process.exit(0);
    }
    const report = runDoctor(opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  readInfoPlistJson,
  runDoctor,
  formatReport,
};
