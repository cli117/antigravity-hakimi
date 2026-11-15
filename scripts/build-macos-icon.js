#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { assertNotOfficialAntigravityApp } = require(path.join(
  __dirname,
  '..',
  'payload',
  'dist',
  'asar-engine.js'
));

const ICONSET_SPECS = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
];

const JXA_RENDER_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("Foundation");

function run(argv) {
  const inPath = argv[0];
  const outPath = argv[1];
  const rawMode = argv[2] === "1";

  const data = $.NSData.dataWithContentsOfFile(inPath);
  if (data.isNil()) throw new Error("Failed to read normalized PNG");
  const srcRep = $.NSBitmapImageRep.imageRepWithData(data);
  if (srcRep.isNil()) throw new Error("Failed to decode bitmap");

  const w = Number(srcRep.pixelsWide);
  const h = Number(srcRep.pixelsHigh);
  if (!(w > 0 && h > 0)) throw new Error("Invalid image dimensions");

  // Lock NSImage size to exact pixel dimensions so Retina DPI metadata never scales draw output
  srcRep.size = $.NSMakeSize(w, h);
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h));
  img.addRepresentation(srcRep);

  const side = Math.min(w, h);
  const cropX = Math.floor((w - side) / 2);
  const cropY = Math.floor((h - side) / 2);

  function alphaAt(px, py) {
    const c = srcRep.colorAtXY(px, py);
    return c.isNil() ? 1.0 : Number(c.alphaComponent);
  }

  const hasTransparentCorners =
    Boolean(srcRep.hasAlpha) &&
    alphaAt(cropX, cropY) < 0.06 &&
    alphaAt(cropX + side - 1, cropY) < 0.06 &&
    alphaAt(cropX, cropY + side - 1) < 0.06 &&
    alphaAt(cropX + side - 1, cropY + side - 1) < 0.06;

  const outRep =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null,
      1024,
      1024,
      8,
      4,
      true,
      false,
      $.NSCalibratedRGBColorSpace,
      0,
      0
    );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(outRep);
  $.NSGraphicsContext.setCurrentContext(ctx);
  ctx.imageInterpolation = $.NSImageInterpolationHigh;

  const useSquircle = !rawMode && !hasTransparentCorners;
  const dstRect = useSquircle
    ? $.NSMakeRect(100, 100, 824, 824)
    : $.NSMakeRect(0, 0, 1024, 1024);

  if (useSquircle) {
    const clip = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(dstRect, 185, 185);
    clip.addClip;
  }

  const srcRect = $.NSMakeRect(cropX, cropY, side, side);
  img.drawInRectFromRectOperationFraction(
    dstRect,
    srcRect,
    $.NSCompositingOperationSourceOver,
    1.0
  );
  ctx.flushGraphics;

  const pngData = outRep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (pngData.isNil() || !pngData.writeToFileAtomically(outPath, true)) {
    throw new Error("Failed to write 1024x1024 PNG");
  }

  return JSON.stringify({ w: w, h: h, side: side, masked: useSquircle });
}
`;

function parseArgs(argv) {
  const opts = {
    inputPath: null,
    outIcnsPath: null,
    outPngPath: null,
    rawIcon: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') {
      opts.inputPath = argv[++i];
    } else if (arg === '--out-icns') {
      opts.outIcnsPath = argv[++i];
    } else if (arg === '--out-png') {
      opts.outPngPath = argv[++i];
    } else if (arg === '--no-mask') {
      opts.rawIcon = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/build-macos-icon.js --input <path> --out-icns <path> --out-png <path> [--no-mask]'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.inputPath) throw new Error('Missing required --input');
  if (!opts.outIcnsPath) throw new Error('Missing required --out-icns');
  if (!opts.outPngPath) throw new Error('Missing required --out-png');
  return opts;
}

function buildMacosIcon(rawOpts = {}) {
  const inputPath = path.resolve(String(rawOpts.inputPath || ''));
  const outIcnsPath = path.resolve(String(rawOpts.outIcnsPath || ''));
  const outPngPath = path.resolve(String(rawOpts.outPngPath || ''));
  const rawIcon = Boolean(rawOpts.rawIcon);

  if (!inputPath || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`找不到图标文件: ${rawOpts.inputPath || inputPath}`);
  }

  assertNotOfficialAntigravityApp(outIcnsPath, 'write custom icns');
  assertNotOfficialAntigravityApp(outPngPath, 'write custom icon.png');

  fs.mkdirSync(path.dirname(outIcnsPath), { recursive: true });
  fs.mkdirSync(path.dirname(outPngPath), { recursive: true });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-'));
  try {
    if (inputPath.toLowerCase().endsWith('.icns')) {
      try {
        const fmtOut = execFileSync('sips', ['-g', 'format', inputPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!/format:\s*icns/i.test(fmtOut)) {
          throw new Error('not an icns file');
        }
      } catch (e) {
        throw new Error(`无效的 .icns 图标文件: ${inputPath}`);
      }

      fs.copyFileSync(inputPath, outIcnsPath);
      execFileSync(
        'sips',
        ['-s', 'format', 'png', '-z', '512', '512', inputPath, '--out', outPngPath],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      if (!fs.existsSync(outIcnsPath) || fs.statSync(outIcnsPath).size === 0) {
        throw new Error(`输出 .icns 写入失败: ${outIcnsPath}`);
      }
      if (!fs.existsSync(outPngPath) || fs.statSync(outPngPath).size === 0) {
        throw new Error(`输出 512x512 PNG 写入失败: ${outPngPath}`);
      }

      return {
        ok: true,
        mode: 'icns',
        masked: false,
        outIcnsPath,
        outPngPath,
      };
    }

    const normalizedPng = path.join(workDir, 'normalized.png');
    try {
      execFileSync('sips', ['-s', 'format', 'png', inputPath, '--out', normalizedPng], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(
        `无法读取或转换图标图片: ${inputPath}（支持 PNG / JPG / WebP / HEIC / ICNS 等格式）`
      );
    }

    const jxaFile = path.join(workDir, 'render.jxa');
    const base1024Png = path.join(workDir, 'base1024.png');
    fs.writeFileSync(jxaFile, JXA_RENDER_SCRIPT, 'utf8');

    const jxaStdout = execFileSync(
      'osascript',
      ['-l', 'JavaScript', jxaFile, normalizedPng, base1024Png, rawIcon ? '1' : '0'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    const renderMeta = JSON.parse(jxaStdout);

    const iconsetDir = path.join(workDir, 'AppIcon.iconset');
    fs.mkdirSync(iconsetDir, { recursive: true });
    for (const spec of ICONSET_SPECS) {
      const target = path.join(iconsetDir, spec.name);
      execFileSync(
        'sips',
        ['-z', String(spec.size), String(spec.size), base1024Png, '--out', target],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
    fs.copyFileSync(base1024Png, path.join(iconsetDir, 'icon_512x512@2x.png'));

    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outIcnsPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.copyFileSync(path.join(iconsetDir, 'icon_512x512.png'), outPngPath);

    if (!fs.existsSync(outIcnsPath) || fs.statSync(outIcnsPath).size === 0) {
      throw new Error(`生成 .icns 失败: ${outIcnsPath}`);
    }
    if (!fs.existsSync(outPngPath) || fs.statSync(outPngPath).size === 0) {
      throw new Error(`生成 512x512 PNG 失败: ${outPngPath}`);
    }

    return {
      ok: true,
      mode: 'image',
      w: renderMeta.w,
      h: renderMeta.h,
      side: renderMeta.side,
      masked: Boolean(renderMeta.masked),
      outIcnsPath,
      outPngPath,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const res = buildMacosIcon(opts);
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

module.exports = {
  ICONSET_SPECS,
  buildMacosIcon,
};
