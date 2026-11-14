/**
 * @fileoverview 跨平台 Antigravity 上下文压缩水位管理器（与 MetaBot 100% 共享策略与备份目录）。
 *
 * 核心职责与安全不变量：
 * 1. 与 MetaBot 共享单一事实源策略文件 `~/.gemini/antigravity-context-policy.json` 与备份托管目录
 *    `~/.gemini/antigravity/.metabot-context-sync/`，在插件面板或 MetaBot `/context` 切换均双向实时同步；
 * 2. 双架构五重闭环语义解码：
 *    - macOS ARM64 Mach-O：解析 `__TEXT` + `__lrodata_gopcln` 锁定 `ClampCheckpointConfigForModelInfo`，
 *      通过 `decodeArm64ClampAt` 自适应任意寄存器与结构体偏移；整包 CoW 快照 + 由内向外一致签名 + 三重预检原子替换；
 *    - Windows / Linux `x86_64` PE64：解析 `.rdata` 内嵌 `gopclntab` 锁定函数区间，通过 `decodeX64ClampAt`
 *      自适应任意寄存器与偏移；支持 `.orig` 首次自愈备份、`--stamp` 预检与 NTFS 锁安全 `.metabot-old-*` 原子替换；
 *    - 同步联动本机独立安装的 `agy` / `agy.exe` CLI（若存在）；
 * 3. 切回 `256k` 时 100% 从官方原版备份字节级还原并复核 SHA-256，绝不触碰或终止正在运行的 `language_server` 进程；
 * 4. 若用户从未设置过全局策略文件，启动巡检保持 100% 只读零修改；仅当已存在用户策略且客户端升级回退时自动重适配。
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { LS_ADDR } from './config.mjs';

export const CONTEXT_WINDOW_MODES = Object.freeze(['256k', '512k', '768k', '1m']);
const PATCHED_CONTEXT_MODES = Object.freeze(['512k', '768k', '1m']);

const CTX_TOKENS_256K = 256_000;
const CTX_TOKENS_512K = 524_288;
const CTX_TOKENS_768K = 786_432;
const CTX_TOKENS_1M_DISPLAY = 1_000_000;
const CTX_TOKENS_1M_CHECKPOINT = 983_040;

const AGY_CLAMP_OFFSET_HINTS = Object.freeze([
  0x1379024, 0x1370858, 0x1364db8, 0x14cde68, 0x13545b8, 0x13e0fe8, 0x1310278, 0x127be88, 0x12717f8,
  0x182310a, 0x18c09ea,
]);

const AGY_CLAMP_V1_UNPATCHED_HEX = '031040b923010035231480b9048893d27f0004eb';
const AGY_CLAMP_V1_512K_HEX = '031040b90301a05207000014048893d27f0004eb';
const AGY_CLAMP_V1_768K_HEX = '031040b98301a05207000014048893d27f0004eb';
const AGY_CLAMP_V1_PATCHED_HEX = '031040b91f2003d5231480b9048893d27f0004eb';

const AGY_CLAMP_V2_UNPATCHED_HEX = '030c40b923010035231480b9048893d27f0004eb';
const AGY_CLAMP_V2_512K_HEX = '030c40b90301a05207000014048893d27f0004eb';
const AGY_CLAMP_V2_768K_HEX = '030c40b98301a05207000014048893d27f0004eb';
const AGY_CLAMP_V2_PATCHED_HEX = '030c40b91f2003d5231480b9048893d27f0004eb';

const AGY_CLAMP_V3_UNPATCHED_HEX = '450c40b925010035651480b9068893d2bf0006eb';
const AGY_CLAMP_V3_512K_HEX = '450c40b90501a05207000014068893d2bf0006eb';
const AGY_CLAMP_V3_768K_HEX = '450c40b98501a05207000014068893d2bf0006eb';
const AGY_CLAMP_V3_PATCHED_HEX = '450c40b91f2003d5651480b9068893d2bf0006eb';

export const AGY_CLAMP_X64_UNPATCHED_HEX =
  '83780c00751c486353144881fa409c00007f0531d290eb074881c2c063ffff89500c8b531485d27e1589d629';

const AGY_CLAMP_PATTERNS = Object.freeze([
  {
    id: 'v3-x2-0x0c',
    variants: [
      { state: 'official-256k', mode: '256k', buf: Buffer.from(AGY_CLAMP_V3_UNPATCHED_HEX, 'hex') },
      { state: 'patched-512k', mode: '512k', buf: Buffer.from(AGY_CLAMP_V3_512K_HEX, 'hex') },
      { state: 'patched-768k', mode: '768k', buf: Buffer.from(AGY_CLAMP_V3_768K_HEX, 'hex') },
      { state: 'patched-1m', mode: '1m', buf: Buffer.from(AGY_CLAMP_V3_PATCHED_HEX, 'hex') },
    ],
  },
  {
    id: 'v2-0x0c',
    variants: [
      { state: 'official-256k', mode: '256k', buf: Buffer.from(AGY_CLAMP_V2_UNPATCHED_HEX, 'hex') },
      { state: 'patched-512k', mode: '512k', buf: Buffer.from(AGY_CLAMP_V2_512K_HEX, 'hex') },
      { state: 'patched-768k', mode: '768k', buf: Buffer.from(AGY_CLAMP_V2_768K_HEX, 'hex') },
      { state: 'patched-1m', mode: '1m', buf: Buffer.from(AGY_CLAMP_V2_PATCHED_HEX, 'hex') },
    ],
  },
  {
    id: 'v1-0x10',
    variants: [
      { state: 'official-256k', mode: '256k', buf: Buffer.from(AGY_CLAMP_V1_UNPATCHED_HEX, 'hex') },
      { state: 'patched-512k', mode: '512k', buf: Buffer.from(AGY_CLAMP_V1_512K_HEX, 'hex') },
      { state: 'patched-768k', mode: '768k', buf: Buffer.from(AGY_CLAMP_V1_768K_HEX, 'hex') },
      { state: 'patched-1m', mode: '1m', buf: Buffer.from(AGY_CLAMP_V1_PATCHED_HEX, 'hex') },
    ],
  },
]);

const ARM64_CLAMP_WINDOW_BYTES = 44;
const X64_CLAMP_PROBE_BYTES = 48;
const MAX_INSPECT_BINARY_BYTES = 512 * 1024 * 1024;
const ARM64_MOVZ_40000_HIGH3 = Buffer.from([0x88, 0x93, 0xd2]);
const X64_NEG40K_IMM = Buffer.from([0xc0, 0x63, 0xff, 0xff]);
const X64_POS40K_IMM = Buffer.from([0x40, 0x9c, 0x00, 0x00]);
const GO_CLAMP_FUNC_SUFFIX = Buffer.from('.ClampCheckpointConfigForModelInfo\0', 'utf8');
const GO_PCLNTAB_MAGIC_120 = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00]);
const GO_PCLNTAB_MAGIC_118 = Buffer.from([0xf0, 0xff, 0xff, 0xff, 0x00, 0x00]);
const GOOGLE_ANTIGRAVITY_TEAM_ID = 'EQHXZ8M8AV';

const ctxWinBinaryInspectionCache = new Map();
const ctxWinDynamicOffsetHints = new Set();
const ctxWinRunningImageShaByPid = new Map();
const ctxWinFileSha256Cache = new Map();
const ctxWinRunningProbeCache = {
  key: '',
  ts: 0,
  pid: 0,
  result: null,
};

const ctxWinRuntimeState = {
  snapshotCache: null,
  snapshotTs: 0,
  lastError: null,
  switchQueue: Promise.resolve(),
};

const SNAPSHOT_TTL_MS = 3000;

function isTestSandboxEnv() {
  return !LS_ADDR || LS_ADDR === 'test.invalid' || Boolean(process.env?.VITEST);
}

function ctxWinExtname(filePath) {
  const base = basename(String(filePath || ''));
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx) : '';
}

function ctxWinStripExt(filename, ext) {
  return ext && filename.endsWith(ext) ? filename.slice(0, -ext.length) : filename;
}

function safeLstat(targetPath) {
  try {
    if (typeof lstatSync === 'function') {
      return lstatSync(targetPath);
    }
    if (existsSync(targetPath)) {
      const st = statSync(targetPath);
      return {
        ...st,
        isSymbolicLink: () => false,
        isFile: () => (typeof st.isFile === 'function' ? st.isFile() : true),
        isDirectory: () => (typeof st.isDirectory === 'function' ? st.isDirectory() : false),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function safeChmod(targetPath, mode) {
  try {
    if (typeof chmodSync === 'function') {
      chmodSync(targetPath, mode);
    }
  } catch {
    // Windows / VM 沙箱忽略 chmod 异常
  }
}

function safeUnlink(targetPath) {
  try {
    if (typeof unlinkSync === 'function') {
      unlinkSync(targetPath);
    } else if (typeof rmSync === 'function') {
      rmSync(targetPath, { force: true });
    }
  } catch {
    // 忽略删除异常
  }
}

function safeCopyFile(srcPath, dstPath) {
  if (typeof copyFileSync === 'function') {
    copyFileSync(srcPath, dstPath);
    return;
  }
  writeFileSync(dstPath, readFileSync(srcPath));
}

function safeRename(srcPath, dstPath) {
  if (typeof renameSync === 'function') {
    renameSync(srcPath, dstPath);
    return;
  }
  writeFileSync(dstPath, readFileSync(srcPath));
  safeUnlink(srcPath);
}

export function normalizeContextWindowMode(raw) {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase();
  if (norm === 'official' || norm === '256k') return '256k';
  if (norm === '512k' || norm === '768k' || norm === '1m') return norm;
  return null;
}

function resolveContextModeSpec(mode) {
  switch (mode) {
    case '512k':
      return {
        contextWindow: CTX_TOKENS_512K,
        checkpointLimit: CTX_TOKENS_512K,
        expectedBinaryState: 'patched-512k',
      };
    case '768k':
      return {
        contextWindow: CTX_TOKENS_768K,
        checkpointLimit: CTX_TOKENS_768K,
        expectedBinaryState: 'patched-768k',
      };
    case '1m':
      return {
        contextWindow: CTX_TOKENS_1M_DISPLAY,
        checkpointLimit: CTX_TOKENS_1M_CHECKPOINT,
        expectedBinaryState: 'patched-1m',
      };
    default:
      return {
        contextWindow: CTX_TOKENS_256K,
        checkpointLimit: CTX_TOKENS_256K,
        expectedBinaryState: 'official-256k',
      };
  }
}

function binaryStateToMode(binaryState) {
  if (binaryState === 'patched-512k') return '512k';
  if (binaryState === 'patched-768k') return '768k';
  if (binaryState === 'patched-1m') return '1m';
  if (binaryState === 'official-256k') return '256k';
  return 'unknown';
}

function computeContextFileSha256(filePath) {
  let fstat = null;
  try {
    fstat = statSync(filePath);
  } catch {
    fstat = null;
  }
  const size = Number(fstat?.size || 0);
  const mtimeMs = Number(fstat?.mtimeMs || 0);
  const ctimeMs = Number(fstat?.ctimeMs || fstat?.mtimeMs || 0);
  const cached = ctxWinFileSha256Cache.get(filePath);
  if (
    cached &&
    size > 0 &&
    cached.size === size &&
    cached.mtimeMs === mtimeMs &&
    cached.ctimeMs === ctimeMs
  ) {
    return cached.sha256;
  }
  const hash = crypto.createHash('sha256');
  hash.update(readFileSync(filePath));
  const sha256 = hash.digest('hex');
  if (size > 0) {
    ctxWinFileSha256Cache.set(filePath, { size, mtimeMs, ctimeMs, sha256 });
  }
  return sha256;
}

function countBufferOccurrences(haystack, needle) {
  let count = 0;
  let firstOffset = -1;
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, fromIndex);
    if (idx === -1) break;
    if (firstOffset === -1) firstOffset = idx;
    count += 1;
    fromIndex = idx + 1;
  }
  return { count, firstOffset };
}

/**
 * 寄存器无关 / 结构体偏移无关的 ARM64 指令语义解码器（44 字节窗口，五重不变量校验）。
 */
export function decodeArm64ClampAt(buf, offset) {
  if (!Buffer.isBuffer(buf) || offset < 0 || offset + ARM64_CLAMP_WINDOW_BYTES > buf.length) {
    return null;
  }
  const i0 = buf.readUInt32LE(offset);
  if ((i0 & 0xffc00000) >>> 0 !== 0xb9400000) return null;
  const rt = i0 & 0x1f;
  const rnCfg = (i0 >>> 5) & 0x1f;
  const imm12 = (i0 >>> 10) & 0xfff;
  if (rt >= 29 || rnCfg >= 29) return null;

  const i3 = buf.readUInt32LE(offset + 12);
  if ((i3 & 0xffffffe0) >>> 0 !== 0xd2938800) return null;
  const rtmp = i3 & 0x1f;
  if (rtmp >= 29 || rtmp === rt || rtmp === rnCfg) return null;

  const i4 = buf.readUInt32LE(offset + 16);
  const expectedCmp = (0xeb00001f | (rtmp << 16) | (rt << 5)) >>> 0;
  if (i4 !== expectedCmp) return null;

  const i9 = buf.readUInt32LE(offset + 36);
  const expectedStr = (0xb9000000 | (imm12 << 10) | (rnCfg << 5) | rt) >>> 0;
  if (i9 !== expectedStr) return null;

  const i10 = buf.readUInt32LE(offset + 40);
  if ((i10 & 0xffc00000) >>> 0 !== 0xb9800000) return null;

  const i1 = buf.readUInt32LE(offset + 4);
  const i2 = buf.readUInt32LE(offset + 8);
  const cbnzExpected = (0x35000120 | rt) >>> 0;
  const movz512k = (0x52a00100 | rt) >>> 0;
  const movz768k = (0x52a00180 | rt) >>> 0;
  const bPlus1c = 0x14000007;
  const nopInsn = 0xd503201f;
  const i2IsLdrswRt = (i2 & 0xffc0001f) >>> 0 === (0xb9800000 | rt) >>> 0;

  let state = null;
  if (i1 === cbnzExpected && i2IsLdrswRt) state = 'official-256k';
  else if (i1 === movz512k && i2 === bPlus1c) state = 'patched-512k';
  else if (i1 === movz768k && i2 === bPlus1c) state = 'patched-768k';
  else if (i1 === nopInsn && i2IsLdrswRt) state = 'patched-1m';
  else return null;

  const byteOff = imm12 * 4;
  let patternId;
  if (rt === 3 && rnCfg === 0 && byteOff === 0x10) patternId = 'v1-0x10';
  else if (rt === 3 && rnCfg === 0 && byteOff === 0x0c) patternId = 'v2-0x0c';
  else if (rt === 5 && rnCfg === 2 && byteOff === 0x0c) patternId = 'v3-x2-0x0c';
  else patternId = `arm64-r${rt}-b${rnCfg}-0x${byteOff.toString(16)}`;

  return { state, patchOffset: offset, rt, rnCfg, byteOff, patternId };
}

function decodeX64MemRegDisp(buf, pos, rex) {
  if (pos >= buf.length) return null;
  const mrm = buf[pos++];
  const mod = mrm >> 6;
  if (mod === 3) return null;
  const reg = ((mrm >> 3) & 7) + (rex & 4 ? 8 : 0);
  const rmLow = mrm & 7;
  let baseReg = rmLow + (rex & 1 ? 8 : 0);
  if (rmLow === 4) {
    if (pos >= buf.length) return null;
    const sib = buf[pos++];
    const scale = sib >> 6;
    const idxLow = (sib >> 3) & 7;
    const baseLow = sib & 7;
    const hasIndex = !(idxLow === 4 && (rex & 2) === 0);
    if (scale !== 0 || hasIndex || (mod === 0 && baseLow === 5)) return null;
    baseReg = baseLow + (rex & 1 ? 8 : 0);
  } else if (mod === 0 && rmLow === 5) {
    return null;
  }
  let disp = 0;
  if (mod === 1) {
    if (pos >= buf.length) return null;
    disp = buf.readInt8(pos++);
  } else if (mod === 2) {
    if (pos + 4 > buf.length) return null;
    disp = buf.readInt32LE(pos);
    pos += 4;
  }
  return { reg, baseReg, disp, next: pos };
}

/**
 * 寄存器无关 / 结构体偏移无关的 `x86_64` 指令语义解码器（五重闭环不变量校验）。
 */
export function decodeX64ClampAt(buf, offset) {
  if (!Buffer.isBuffer(buf) || offset < 0 || offset + 38 > buf.length) return null;

  let p = offset;
  let rex0 = 0;
  if (buf[p] >= 0x40 && buf[p] <= 0x47) rex0 = buf[p++];
  if (p >= buf.length || buf[p] !== 0x83) return null;
  const cmpMem = decodeX64MemRegDisp(buf, p + 1, rex0);
  if (!cmpMem || (cmpMem.reg & 7) !== 7 || cmpMem.disp <= 0 || cmpMem.disp > 256) return null;
  if (cmpMem.next >= buf.length || buf[cmpMem.next] !== 0x00) return null;
  const rCfg = cmpMem.baseReg;
  const dispLimit = cmpMem.disp;
  const branchOff = cmpMem.next + 1;

  let addSubOff = -1;
  let rTmp = -1;
  for (let scan = branchOff + 8; scan <= offset + 40 && scan + 7 <= buf.length; scan += 1) {
    const rx = buf[scan];
    if ((rx === 0x48 || rx === 0x49) && buf[scan + 1] === 0x81) {
      const mrm = buf[scan + 2];
      if (mrm >> 6 === 3) {
        const subop = (mrm >> 3) & 7;
        const imm = buf.readInt32LE(scan + 3);
        if ((subop === 0 && imm === -40000) || (subop === 5 && imm === 40000)) {
          addSubOff = scan;
          rTmp = (mrm & 7) + (rx & 1 ? 8 : 0);
          break;
        }
      }
    }
  }
  if (addSubOff === -1 || rTmp < 0 || rTmp === rCfg) return null;

  const writebackOff = addSubOff + 7;
  let pw = writebackOff;
  if (pw + 2 > buf.length) return null;
  let rexw = 0;
  if (buf[pw] >= 0x40 && buf[pw] <= 0x47) rexw = buf[pw++];
  if (pw >= buf.length || buf[pw] !== 0x89) return null;
  const wbMem = decodeX64MemRegDisp(buf, pw + 1, rexw);
  if (!wbMem || wbMem.baseReg !== rCfg || wbMem.disp !== dispLimit || wbMem.reg !== rTmp) return null;

  const tailOff = wbMem.next;
  let pt = tailOff;
  if (pt + 2 > buf.length) return null;
  let rext = 0;
  if (buf[pt] >= 0x40 && buf[pt] <= 0x47) rext = buf[pt++];
  if (pt >= buf.length || buf[pt] !== 0x8b) return null;
  const tailMem = decodeX64MemRegDisp(buf, pt + 1, rext);
  if (!tailMem || tailMem.baseReg === rCfg || tailMem.disp <= 0 || tailMem.disp > 256) return null;
  const rModel = tailMem.baseReg;
  const dispMax = tailMem.disp;
  const rTail = tailMem.reg;

  let pTest = tailMem.next;
  if (pTest + 2 > buf.length) return null;
  let rexTest = 0;
  if (buf[pTest] >= 0x40 && buf[pTest] <= 0x4f) rexTest = buf[pTest++];
  if (pTest + 2 > buf.length || buf[pTest] !== 0x85) return null;
  const mrmTest = buf[pTest + 1];
  const testR1 = (mrmTest & 7) + (rexTest & 1 ? 8 : 0);
  const testR2 = ((mrmTest >> 3) & 7) + (rexTest & 4 ? 8 : 0);
  if (mrmTest >> 6 !== 3 || testR1 !== rTail || testR2 !== rTail) return null;

  const checkMovsxdAndCmp40k = (pos) => {
    let pm = pos;
    if (pm + 2 > buf.length || buf[pm] < 0x48 || buf[pm] > 0x4f) return null;
    const rexm = buf[pm++];
    if (buf[pm] !== 0x63) return null;
    const msMem = decodeX64MemRegDisp(buf, pm + 1, rexm);
    if (!msMem || msMem.reg !== rTmp || msMem.baseReg !== rModel || msMem.disp !== dispMax) return null;
    const pc = msMem.next;
    if (pc + 7 > buf.length || (buf[pc] !== 0x48 && buf[pc] !== 0x49) || buf[pc + 1] !== 0x81) return null;
    const cmrm = buf[pc + 2];
    const cr = (cmrm & 7) + (buf[pc] & 1 ? 8 : 0);
    if (cmrm >> 6 !== 3 || ((cmrm >> 3) & 7) !== 7 || cr !== rTmp) return null;
    if (buf.readInt32LE(pc + 3) !== 40000) return null;
    return pc + 7;
  };

  let state = null;
  let nopFillEnd = -1;
  if (
    branchOff + 2 <= buf.length &&
    buf[branchOff] === 0x75 &&
    branchOff + 2 + buf.readInt8(branchOff + 1) === tailOff
  ) {
    const afterCmp = checkMovsxdAndCmp40k(branchOff + 2);
    if (afterCmp !== null) {
      state = 'official-256k';
      nopFillEnd = afterCmp;
    }
  } else if (branchOff + 2 <= buf.length && buf[branchOff] === 0x90 && buf[branchOff + 1] === 0x90) {
    const afterCmp = checkMovsxdAndCmp40k(branchOff + 2);
    if (afterCmp !== null) {
      state = 'patched-1m';
      nopFillEnd = afterCmp;
    }
  } else {
    let pm = branchOff;
    let rexMov = 0;
    if (pm < buf.length && buf[pm] === 0x41) rexMov = buf[pm++];
    if (pm + 7 <= addSubOff && pm + 7 <= buf.length) {
      const opMov = buf[pm];
      const movReg = opMov - 0xb8 + (rexMov ? 8 : 0);
      if (opMov >= 0xb8 && opMov <= 0xbf && movReg === rTmp) {
        const imm = buf.readUInt32LE(pm + 1);
        const jmpPos = pm + 5;
        if (buf[jmpPos] === 0xeb && jmpPos + 2 + buf.readInt8(jmpPos + 1) === writebackOff) {
          if (imm === CTX_TOKENS_512K) state = 'patched-512k';
          else if (imm === CTX_TOKENS_768K) state = 'patched-768k';
        }
      }
    }
  }

  if (!state) return null;
  const hexOff = `0x${dispLimit.toString(16).padStart(2, '0')}`;
  return {
    state,
    patchOffset: offset,
    branchOff,
    writebackOff,
    tailOff,
    nopFillEnd,
    rCfg,
    rModel,
    rTmp,
    dispLimit,
    dispMax,
    patternId: `x64-r${rTmp}-c${rCfg}-${hexOff}`,
  };
}

function locateGoClampInMachO(raw) {
  if (raw.length < 64 || raw.readUInt32LE(0) !== 0xfeedfacf) return null;
  const ncmds = raw.readUInt32LE(16);
  let cmdOff = 32;
  let textVmaddr = null;
  let textFileoff = 0n;
  let sectTextAddr = null;
  let sectTextOff = 0;
  let sectTextSize = 0;
  let pclntabOff = null;
  let pclntabSize = 0;

  for (let c = 0; c < ncmds && cmdOff + 8 <= raw.length; c += 1) {
    const cmd = raw.readUInt32LE(cmdOff);
    const cmdsize = raw.readUInt32LE(cmdOff + 4);
    if (cmdsize < 8 || cmdOff + cmdsize > raw.length) break;
    if (cmd === 0x19 && cmdsize >= 72) {
      const segEnd = raw.indexOf(0, cmdOff + 8);
      const segname = raw
        .subarray(cmdOff + 8, segEnd !== -1 && segEnd < cmdOff + 24 ? segEnd : cmdOff + 24)
        .toString('ascii');
      const vmaddr = raw.readBigUInt64LE(cmdOff + 24);
      const fileoff = raw.readBigUInt64LE(cmdOff + 40);
      const nsects = raw.readUInt32LE(cmdOff + 64);
      if (segname === '__TEXT') {
        textVmaddr = vmaddr;
        textFileoff = fileoff;
      }
      let soff = cmdOff + 72;
      for (let s = 0; s < nsects && soff + 80 <= cmdOff + cmdsize; s += 1) {
        const sEnd = raw.indexOf(0, soff);
        const sname = raw.subarray(soff, sEnd !== -1 && sEnd < soff + 16 ? sEnd : soff + 16).toString('ascii');
        const saddr = raw.readBigUInt64LE(soff + 32);
        const ssize = Number(raw.readBigUInt64LE(soff + 40));
        const sfileoff = raw.readUInt32LE(soff + 48);
        if (segname === '__TEXT' && sname === '__text') {
          sectTextAddr = saddr;
          sectTextOff = sfileoff;
          sectTextSize = ssize;
        } else if (sname.includes('gopcln')) {
          pclntabOff = sfileoff;
          pclntabSize = ssize;
        }
        soff += 80;
      }
    }
    cmdOff += cmdsize;
  }

  const textSectionRange =
    sectTextOff > 0 && sectTextSize > 0 && sectTextOff + sectTextSize <= raw.length
      ? { start: sectTextOff, end: sectTextOff + sectTextSize }
      : undefined;

  if (
    textVmaddr === null ||
    sectTextAddr === null ||
    pclntabOff === null ||
    pclntabOff + 72 > raw.length ||
    pclntabOff + pclntabSize > raw.length
  ) {
    return { textSectionRange };
  }

  const pmagic = raw.readUInt32LE(pclntabOff);
  const ptrSize = raw[pclntabOff + 7];
  if ((pmagic !== 0xfffffff0 && pmagic !== 0xfffffff1) || ptrSize !== 8) {
    return { textSectionRange };
  }

  const nfunctab = Number(raw.readBigUInt64LE(pclntabOff + 8));
  const textStart = raw.readBigUInt64LE(pclntabOff + 24);
  const funcnameOff = Number(raw.readBigUInt64LE(pclntabOff + 32));
  const functabOff = Number(raw.readBigUInt64LE(pclntabOff + 64));
  if (nfunctab <= 0 || nfunctab > 1_000_000) return { textSectionRange };

  const fnBase = pclntabOff + funcnameOff;
  const ftBase = pclntabOff + functabOff;
  const pclnEnd = pclntabOff + pclntabSize;
  if (fnBase < pclntabOff || ftBase < pclntabOff || ftBase + nfunctab * 8 + 4 > pclnEnd) {
    return { textSectionRange };
  }

  const candidateNameOffs = new Set();
  let searchPos = fnBase;
  const searchUpper = Math.min(pclnEnd, ftBase > fnBase ? ftBase : pclnEnd);
  while (searchPos <= searchUpper - GO_CLAMP_FUNC_SUFFIX.length) {
    const hit = raw.indexOf(GO_CLAMP_FUNC_SUFFIX, searchPos);
    if (hit === -1 || hit >= searchUpper) break;
    let strStart = hit;
    while (strStart > fnBase && raw[strStart - 1] !== 0) strStart -= 1;
    candidateNameOffs.add(strStart - fnBase);
    searchPos = hit + GO_CLAMP_FUNC_SUFFIX.length;
  }
  if (candidateNameOffs.size === 0) return { textSectionRange };

  const baseVa = textStart !== 0n ? textStart : sectTextAddr;
  for (let i = 0; i < nfunctab; i += 1) {
    const entryPos = ftBase + i * 8;
    const entryOff = raw.readUInt32LE(entryPos);
    const funcInfoOff = raw.readUInt32LE(entryPos + 4);
    const finfoPos = ftBase + funcInfoOff;
    if (finfoPos + 8 > pclnEnd) continue;
    const nameOff = raw.readInt32LE(finfoPos + 4);
    if (!candidateNameOffs.has(nameOff)) continue;

    const nextEntryOff = raw.readUInt32LE(entryPos + 8);
    const vaStart = baseVa + BigInt(entryOff);
    const vaEnd = baseVa + BigInt(nextEntryOff);
    if (vaEnd <= vaStart || vaStart < textVmaddr) continue;
    const fStart = Number(vaStart - textVmaddr + textFileoff);
    const fEnd = Number(vaEnd - textVmaddr + textFileoff);
    if (fStart >= 0 && fEnd > fStart && fEnd <= raw.length && fEnd - fStart <= 8192) {
      return { funcRange: { start: fStart, end: fEnd }, textSectionRange };
    }
  }
  return { textSectionRange };
}

function locateGoClampInPE(raw) {
  if (raw.length < 0x100 || raw[0] !== 0x4d || raw[1] !== 0x5a) return null;
  const peOff = raw.readUInt32LE(0x3c);
  if (peOff < 0x40 || peOff + 24 > raw.length) return null;
  if (raw.readUInt32LE(peOff) !== 0x00004550) return null;

  const machine = raw.readUInt16LE(peOff + 4);
  if (machine !== 0x8664 && machine !== 0xaa64) return null;
  const numSections = raw.readUInt16LE(peOff + 6);
  const optSize = raw.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  if (numSections === 0 || numSections > 96 || optSize < 112 || optOff + optSize > raw.length) return null;
  if (raw.readUInt16LE(optOff) !== 0x20b) return null;

  const imageBase = raw.readBigUInt64LE(optOff + 24);
  const sectTableOff = optOff + optSize;
  if (sectTableOff + numSections * 40 > raw.length) return null;

  let textVa = 0;
  let textRawPtr = 0;
  let textRawSize = 0;
  let rdataRawPtr = 0;
  let rdataRawSize = 0;

  for (let i = 0; i < numSections; i += 1) {
    const s = sectTableOff + i * 40;
    const sEnd = raw.indexOf(0, s);
    const name = raw.subarray(s, sEnd !== -1 && sEnd < s + 8 ? sEnd : s + 8).toString('ascii');
    const vAddr = raw.readUInt32LE(s + 12);
    const rawSize = raw.readUInt32LE(s + 16);
    const rawPtr = raw.readUInt32LE(s + 20);
    if (name === '.text') {
      textVa = vAddr;
      textRawPtr = rawPtr;
      textRawSize = rawSize;
    } else if (name === '.rdata' || name.includes('gopcln')) {
      if (rdataRawSize === 0 || name.includes('gopcln')) {
        rdataRawPtr = rawPtr;
        rdataRawSize = rawSize;
      }
    }
  }

  const textEnd = Math.min(raw.length, textRawPtr + textRawSize);
  const textSectionRange =
    textRawPtr > 0 && textRawSize > 0 && textEnd > textRawPtr ? { start: textRawPtr, end: textEnd } : undefined;
  if (!textSectionRange || rdataRawPtr <= 0 || rdataRawSize <= 72 || rdataRawPtr + rdataRawSize > raw.length) {
    return { machine, textSectionRange };
  }

  const rdataEnd = rdataRawPtr + rdataRawSize;
  let pclntabOff = -1;
  for (const magicBuf of [GO_PCLNTAB_MAGIC_120, GO_PCLNTAB_MAGIC_118]) {
    let pos = rdataRawPtr;
    while (pos <= rdataEnd - 72) {
      const idx = raw.indexOf(magicBuf, pos);
      if (idx === -1 || idx > rdataEnd - 72) break;
      const minLc = raw[idx + 6];
      const ptrSize = raw[idx + 7];
      if ((minLc === 1 || minLc === 2 || minLc === 4) && ptrSize === 8) {
        const nf = Number(raw.readBigUInt64LE(idx + 8));
        const fnOff = Number(raw.readBigUInt64LE(idx + 32));
        const ftOff = Number(raw.readBigUInt64LE(idx + 64));
        if (nf > 0 && nf <= 1_000_000 && fnOff > 0 && ftOff > 0 && idx + ftOff + nf * 8 + 4 <= rdataEnd) {
          pclntabOff = idx;
          break;
        }
      }
      pos = idx + 1;
    }
    if (pclntabOff !== -1) break;
  }
  if (pclntabOff === -1) return { machine, textSectionRange };

  const nfunctab = Number(raw.readBigUInt64LE(pclntabOff + 8));
  const textStart = raw.readBigUInt64LE(pclntabOff + 24);
  const funcnameOff = Number(raw.readBigUInt64LE(pclntabOff + 32));
  const functabOff = Number(raw.readBigUInt64LE(pclntabOff + 64));
  const fnBase = pclntabOff + funcnameOff;
  const ftBase = pclntabOff + functabOff;
  const searchUpper = Math.min(rdataEnd, ftBase > fnBase ? ftBase : rdataEnd);

  const candidateNameOffs = new Set();
  let searchPos = fnBase;
  while (searchPos <= searchUpper - GO_CLAMP_FUNC_SUFFIX.length) {
    const hit = raw.indexOf(GO_CLAMP_FUNC_SUFFIX, searchPos);
    if (hit === -1 || hit >= searchUpper) break;
    let strStart = hit;
    while (strStart > fnBase && raw[strStart - 1] !== 0) strStart -= 1;
    candidateNameOffs.add(strStart - fnBase);
    searchPos = hit + GO_CLAMP_FUNC_SUFFIX.length;
  }
  if (candidateNameOffs.size === 0) return { machine, textSectionRange };

  const baseVa = textStart !== 0n ? textStart : imageBase + BigInt(textVa);
  for (let i = 0; i < nfunctab; i += 1) {
    const entryPos = ftBase + i * 8;
    const entryOff = raw.readUInt32LE(entryPos);
    const funcInfoOff = raw.readUInt32LE(entryPos + 4);
    const finfoPos = ftBase + funcInfoOff;
    if (finfoPos + 8 > rdataEnd) continue;
    const nameOff = raw.readInt32LE(finfoPos + 4);
    if (!candidateNameOffs.has(nameOff)) continue;

    const nextEntryOff = raw.readUInt32LE(entryPos + 8);
    const vaStart = baseVa + BigInt(entryOff);
    const vaEnd = baseVa + BigInt(nextEntryOff);
    if (vaEnd <= vaStart || vaStart < imageBase + BigInt(textVa)) continue;
    const fStart = Number(vaStart - imageBase) - textVa + textRawPtr;
    const fEnd = Number(vaEnd - imageBase) - textVa + textRawPtr;
    if (fStart >= textRawPtr && fEnd > fStart && fEnd <= textEnd && fEnd - fStart <= 8192) {
      return { machine, funcRange: { start: fStart, end: fEnd }, textSectionRange };
    }
  }
  return { machine, textSectionRange };
}

function scanArm64ClampInRange(raw, start, end, requireAligned = true) {
  let matched = null;
  let hits = 0;
  let from = Math.max(0, start + 13);
  const limit = Math.min(raw.length, end) - (ARM64_CLAMP_WINDOW_BYTES - 16);
  while (from <= limit) {
    const idx = raw.indexOf(ARM64_MOVZ_40000_HIGH3, from);
    if (idx === -1 || idx > limit) break;
    const candidateOffset = idx - 1 - 12;
    if (candidateOffset >= start && (!requireAligned || (candidateOffset & 3) === 0)) {
      const decoded = decodeArm64ClampAt(raw, candidateOffset);
      if (decoded) {
        hits += 1;
        if (hits > 1) return 'ambiguous';
        matched = decoded;
      }
    }
    from = idx + 1;
  }
  return matched;
}

function scanX64ClampInRange(raw, start, end) {
  let matched = null;
  const seenOffsets = new Set();
  const upper = Math.min(raw.length, end);
  for (const needle of [X64_NEG40K_IMM, X64_POS40K_IMM]) {
    let from = Math.max(0, start + 14);
    while (from <= upper - 12) {
      const idx = raw.indexOf(needle, from);
      if (idx === -1 || idx > upper - 12) break;
      const addSubOff = idx - 3;
      const candMin = Math.max(start, addSubOff - 40);
      const candMax = Math.min(upper - 38, addSubOff - 12);
      for (let cand = candMin; cand <= candMax; cand += 1) {
        if (seenOffsets.has(cand)) continue;
        const decoded = decodeX64ClampAt(raw, cand);
        if (decoded) {
          seenOffsets.add(cand);
          if (matched && matched.patchOffset !== decoded.patchOffset) {
            return 'ambiguous';
          }
          matched = decoded;
        }
      }
      from = idx + 1;
    }
  }
  return matched;
}

function inspectRawClampBuffer(raw) {
  const macho = locateGoClampInMachO(raw);
  if (macho?.funcRange) {
    const inFunc = scanArm64ClampInRange(raw, macho.funcRange.start, macho.funcRange.end, true);
    if (inFunc === 'ambiguous') return { state: 'unknown' };
    if (inFunc) {
      return {
        state: inFunc.state,
        patchOffset: inFunc.patchOffset,
        patternId: inFunc.patternId,
        arm64Rt: inFunc.rt,
      };
    }
  }

  const pe = !macho ? locateGoClampInPE(raw) : null;
  if (pe?.funcRange) {
    if (pe.machine === 0xaa64) {
      const inFuncArm = scanArm64ClampInRange(raw, pe.funcRange.start, pe.funcRange.end, true);
      if (inFuncArm === 'ambiguous') return { state: 'unknown' };
      if (inFuncArm) {
        return {
          state: inFuncArm.state,
          patchOffset: inFuncArm.patchOffset,
          patternId: inFuncArm.patternId,
          arm64Rt: inFuncArm.rt,
        };
      }
    } else {
      const inFuncX64 = scanX64ClampInRange(raw, pe.funcRange.start, pe.funcRange.end);
      if (inFuncX64 === 'ambiguous') return { state: 'unknown' };
      if (inFuncX64) {
        return {
          state: inFuncX64.state,
          patchOffset: inFuncX64.patchOffset,
          patternId: inFuncX64.patternId,
          x64Site: inFuncX64,
        };
      }
    }
  }

  const scanStart = macho?.textSectionRange?.start ?? pe?.textSectionRange?.start ?? 0;
  const scanEnd = macho?.textSectionRange?.end ?? pe?.textSectionRange?.end ?? raw.length;
  if ((!pe || pe.machine === 0xaa64) && scanEnd - scanStart >= ARM64_CLAMP_WINDOW_BYTES) {
    const semanticHit = scanArm64ClampInRange(raw, scanStart, scanEnd, Boolean(macho || pe));
    if (semanticHit === 'ambiguous') return { state: 'unknown' };
    if (semanticHit) {
      return {
        state: semanticHit.state,
        patchOffset: semanticHit.patchOffset,
        patternId: semanticHit.patternId,
        arm64Rt: semanticHit.rt,
      };
    }
  }
  if (!macho && (!pe || pe.machine === 0x8664) && scanEnd - scanStart >= 38) {
    const x64Hit = scanX64ClampInRange(raw, scanStart, scanEnd);
    if (x64Hit === 'ambiguous') return { state: 'unknown' };
    if (x64Hit) {
      return {
        state: x64Hit.state,
        patchOffset: x64Hit.patchOffset,
        patternId: x64Hit.patternId,
        x64Site: x64Hit,
      };
    }
  }

  let totalHits = 0;
  let matched = null;
  for (const pat of AGY_CLAMP_PATTERNS) {
    for (const variant of pat.variants) {
      const hit = countBufferOccurrences(raw, variant.buf);
      if (hit.count > 0) {
        totalHits += hit.count;
        matched = { state: variant.state, patchOffset: hit.firstOffset, patternId: pat.id };
      }
    }
  }
  if (totalHits !== 1 || !matched) return { state: 'unknown' };
  return matched;
}

export function buildPatchedClampBuffer(officialRaw, targetMode) {
  const scanned = inspectRawClampBuffer(officialRaw);
  if (scanned.state !== 'official-256k' || scanned.patchOffset === undefined) {
    return null;
  }

  const patchedBuf = Buffer.from(officialRaw);
  if (scanned.arm64Rt !== undefined) {
    const rt = scanned.arm64Rt;
    if (targetMode === '512k') {
      patchedBuf.writeUInt32LE((0x52a00100 | rt) >>> 0, scanned.patchOffset + 4);
      patchedBuf.writeUInt32LE(0x14000007, scanned.patchOffset + 8);
    } else if (targetMode === '768k') {
      patchedBuf.writeUInt32LE((0x52a00180 | rt) >>> 0, scanned.patchOffset + 4);
      patchedBuf.writeUInt32LE(0x14000007, scanned.patchOffset + 8);
    } else {
      patchedBuf.writeUInt32LE(0xd503201f, scanned.patchOffset + 4);
    }
  } else if (scanned.x64Site !== undefined) {
    const site = scanned.x64Site;
    if (targetMode === '1m') {
      patchedBuf[site.branchOff] = 0x90;
      patchedBuf[site.branchOff + 1] = 0x90;
    } else {
      const imm = targetMode === '512k' ? CTX_TOKENS_512K : CTX_TOKENS_768K;
      const neededBytes = (site.rTmp >= 8 ? 6 : 5) + 2;
      if (site.nopFillEnd < site.branchOff + neededBytes) return null;
      const relJmp = site.writebackOff - (site.branchOff + neededBytes);
      if (relJmp < -128 || relJmp > 127) return null;
      let w = site.branchOff;
      if (site.rTmp >= 8) {
        patchedBuf[w++] = 0x41;
      }
      patchedBuf[w++] = 0xb8 + (site.rTmp & 7);
      patchedBuf.writeUInt32LE(imm, w);
      w += 4;
      patchedBuf[w] = 0xeb;
      patchedBuf.writeInt8(relJmp, w + 1);
      w += 2;
      while (w < site.nopFillEnd) {
        patchedBuf[w++] = 0x90;
      }
    }
  } else {
    const matchedPattern = AGY_CLAMP_PATTERNS.find((p) => p.id === scanned.patternId);
    const targetVariant = matchedPattern?.variants.find((v) => v.mode === targetMode);
    if (!targetVariant) return null;
    targetVariant.buf.copy(patchedBuf, scanned.patchOffset);
  }

  const expectedState = resolveContextModeSpec(targetMode).expectedBinaryState;
  if (scanned.arm64Rt !== undefined) {
    const fastArm = decodeArm64ClampAt(patchedBuf, scanned.patchOffset);
    if (!fastArm || fastArm.state !== expectedState) return null;
    return patchedBuf;
  }
  if (scanned.x64Site !== undefined) {
    const fastX64 = decodeX64ClampAt(patchedBuf, scanned.patchOffset);
    if (!fastX64 || fastX64.state !== expectedState) return null;
    return patchedBuf;
  }
  const verified = inspectRawClampBuffer(patchedBuf);
  if (verified.state !== expectedState || verified.patchOffset !== scanned.patchOffset) {
    return null;
  }
  return patchedBuf;
}

export function inspectAntigravityContextBinary(executablePath) {
  try {
    if (!executablePath || !existsSync(executablePath)) {
      return { exists: false, state: 'unknown' };
    }
    const fstat = statSync(executablePath);
    if (typeof fstat.isFile === 'function' && !fstat.isFile()) {
      return { exists: false, state: 'unknown' };
    }
    const cached = ctxWinBinaryInspectionCache.get(executablePath);
    if (cached && cached.mtimeMs === fstat.mtimeMs && cached.size === fstat.size && fstat.size > 0) {
      return cached.result;
    }

    if (
      typeof openSync === 'function' &&
      typeof readSync === 'function' &&
      typeof closeSync === 'function' &&
      fstat.size >= 20
    ) {
      const legacyLen = AGY_CLAMP_PATTERNS[0].variants[0].buf.length;
      const probeBuf = Buffer.alloc(X64_CLAMP_PROBE_BYTES);
      const candidateHints = [...ctxWinDynamicOffsetHints, ...AGY_CLAMP_OFFSET_HINTS];
      const seenHints = new Set();
      let fd;
      try {
        fd = openSync(executablePath, 'r');
        for (const offsetHint of candidateHints) {
          if (seenHints.has(offsetHint)) continue;
          seenHints.add(offsetHint);
          const maxWant = Math.min(X64_CLAMP_PROBE_BYTES, Math.max(0, fstat.size - offsetHint));
          if (maxWant >= 38) {
            const bytesRead = readSync(fd, probeBuf, 0, maxWant, offsetHint);
            if (bytesRead >= ARM64_CLAMP_WINDOW_BYTES) {
              const decodedArm = decodeArm64ClampAt(probeBuf, 0);
              if (decodedArm) {
                const result = {
                  exists: true,
                  state: decodedArm.state,
                  patchOffset: offsetHint,
                  patternId: decodedArm.patternId,
                };
                ctxWinBinaryInspectionCache.set(executablePath, {
                  mtimeMs: fstat.mtimeMs,
                  size: fstat.size,
                  result,
                });
                return result;
              }
            }
            if (bytesRead >= 38) {
              const decodedX64 = decodeX64ClampAt(probeBuf.subarray(0, bytesRead), 0);
              if (decodedX64) {
                const result = {
                  exists: true,
                  state: decodedX64.state,
                  patchOffset: offsetHint,
                  patternId: decodedX64.patternId,
                };
                ctxWinBinaryInspectionCache.set(executablePath, {
                  mtimeMs: fstat.mtimeMs,
                  size: fstat.size,
                  result,
                });
                return result;
              }
            }
          }
          if (fstat.size >= offsetHint + legacyLen) {
            const bytesRead = readSync(fd, probeBuf, 0, legacyLen, offsetHint);
            if (bytesRead === legacyLen) {
              const sub = probeBuf.subarray(0, legacyLen);
              for (const pat of AGY_CLAMP_PATTERNS) {
                for (const variant of pat.variants) {
                  if (sub.equals(variant.buf)) {
                    const result = {
                      exists: true,
                      state: variant.state,
                      patchOffset: offsetHint,
                      patternId: pat.id,
                    };
                    ctxWinBinaryInspectionCache.set(executablePath, {
                      mtimeMs: fstat.mtimeMs,
                      size: fstat.size,
                      result,
                    });
                    return result;
                  }
                }
              }
            }
          }
        }
      } catch {
        // 回退至全量缓冲读取
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // 忽略关闭异常
          }
        }
      }
    }

    if (fstat.size <= MAX_INSPECT_BINARY_BYTES) {
      const raw = readFileSync(executablePath);
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      const scanned = inspectRawClampBuffer(buf);
      if (scanned.state !== 'unknown') {
        if (scanned.patchOffset !== undefined) {
          ctxWinDynamicOffsetHints.add(scanned.patchOffset);
        }
        const result = {
          exists: true,
          state: scanned.state,
          patchOffset: scanned.patchOffset,
          patternId: scanned.patternId,
        };
        ctxWinBinaryInspectionCache.set(executablePath, {
          mtimeMs: fstat.mtimeMs,
          size: fstat.size,
          result,
        });
        return result;
      }
    }

    const unknownResult = { exists: true, state: 'unknown' };
    ctxWinBinaryInspectionCache.set(executablePath, {
      mtimeMs: fstat.mtimeMs,
      size: fstat.size,
      result: unknownResult,
    });
    return unknownResult;
  } catch {
    return { exists: false, state: 'unknown' };
  }
}

function resolveContextPolicyPath(options = {}) {
  if (options.policyFilePath === null) return undefined;
  if (typeof options.policyFilePath === 'string' && options.policyFilePath.trim()) {
    return options.policyFilePath.trim();
  }
  if (process.env?.GEMINI_CONTEXT_POLICY_PATH?.trim()) {
    return process.env.GEMINI_CONTEXT_POLICY_PATH.trim();
  }
  if (isTestSandboxEnv()) return undefined;
  return join(homedir(), '.gemini', 'antigravity-context-policy.json');
}

function readContextPolicyRecord(options = {}) {
  const policyPath = resolveContextPolicyPath(options);
  if (!policyPath || !existsSync(policyPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    const mode = normalizeContextWindowMode(parsed?.mode);
    if (!mode) return null;
    return {
      mode,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : '',
    };
  } catch {
    return null;
  }
}

function writeContextPolicyRecord(mode, options = {}) {
  const policyPath = resolveContextPolicyPath(options);
  if (!policyPath) return;
  const tmpPath = `${policyPath}.tmp-${process.pid || 0}-${Date.now()}`;
  try {
    mkdirSync(dirname(policyPath), { recursive: true });
    const record = {
      mode,
      updatedAt: new Date().toISOString(),
      updatedBy: options.updatedBy || 'usage-monitor',
    };
    writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    safeRename(tmpPath, policyPath);
  } catch {
    safeUnlink(tmpPath);
  }
}

function resolveContextSyncDir(options = {}) {
  if (typeof options.desktopSyncDir === 'string' && options.desktopSyncDir.trim()) {
    return options.desktopSyncDir.trim();
  }
  if (process.env?.ANTIGRAVITY_DESKTOP_SYNC_DIR?.trim()) {
    return process.env.ANTIGRAVITY_DESKTOP_SYNC_DIR.trim();
  }
  return join(homedir(), '.gemini', 'antigravity', '.metabot-context-sync');
}

function normalizeDesktopAppRoot(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith('.app')) return trimmed;
  const slashNorm = trimmed.replace(/\\/g, '/');
  const appIdx = slashNorm.indexOf('.app/');
  if (appIdx >= 0) return trimmed.slice(0, appIdx + 4);
  const lower = slashNorm.toLowerCase();
  if (
    lower.endsWith('/resources/bin/language_server.exe') ||
    lower.endsWith('/resources/bin/language_server')
  ) {
    return dirname(dirname(dirname(trimmed)));
  }
  if (lower.endsWith('.exe')) return dirname(trimmed);
  const lst = safeLstat(trimmed);
  if (lst && typeof lst.isFile === 'function' && lst.isFile() && !lst.isDirectory?.()) {
    return dirname(trimmed);
  }
  return trimmed;
}

export function resolveAntigravityDesktopAppPath(options = {}) {
  if (options.desktopAppPath === null) return undefined;
  if (typeof options.desktopAppPath === 'string' && options.desktopAppPath.trim()) {
    return normalizeDesktopAppRoot(options.desktopAppPath);
  }
  if (process.env?.ANTIGRAVITY_DESKTOP_APP_PATH?.trim()) {
    return normalizeDesktopAppRoot(process.env.ANTIGRAVITY_DESKTOP_APP_PATH);
  }
  if (process.env?.ANTIGRAVITY_DESKTOP_EXECUTABLE?.trim()) {
    return normalizeDesktopAppRoot(process.env.ANTIGRAVITY_DESKTOP_EXECUTABLE);
  }
  if (isTestSandboxEnv()) return undefined;

  const platform = options.platform || process.platform;
  const home = homedir();
  if (platform === 'darwin') {
    const candidates = ['/Applications/Antigravity.app', join(home, 'Applications', 'Antigravity.app')];
    for (const appPath of candidates) {
      if (safeLstat(join(appPath, 'Contents', 'Resources', 'bin', 'language_server'))) {
        return appPath;
      }
    }
    return undefined;
  }
  if (platform === 'win32') {
    const localAppData = process.env?.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const programFiles = process.env?.ProgramFiles || 'C:\\Program Files';
    const candidates = [
      join(localAppData, 'Programs', 'Antigravity'),
      join(localAppData, 'Antigravity'),
      join(programFiles, 'Antigravity'),
    ];
    for (const appPath of candidates) {
      if (safeLstat(join(appPath, 'resources', 'bin', 'language_server.exe'))) {
        return appPath;
      }
    }
    return undefined;
  }
  for (const appPath of ['/opt/Antigravity', '/usr/lib/antigravity', '/usr/share/antigravity']) {
    if (safeLstat(join(appPath, 'resources', 'bin', 'language_server'))) {
      return appPath;
    }
  }
  return undefined;
}

function resolveDesktopLayout(appPath, platform = process.platform) {
  const lower = appPath.toLowerCase();
  const isMacBundle =
    lower.endsWith('.app') ||
    existsSync(join(appPath, 'Contents', 'Info.plist')) ||
    existsSync(join(appPath, 'Contents', 'Resources', 'bin'));
  if (isMacBundle) {
    const binDir = join(appPath, 'Contents', 'Resources', 'bin');
    return {
      kind: 'macos-bundle',
      appPath,
      binDir,
      lsFilename: 'language_server',
      lsPath: join(binDir, 'language_server'),
    };
  }
  const binDir = join(appPath, 'resources', 'bin');
  const exeCand = join(binDir, 'language_server.exe');
  const posixCand = join(binDir, 'language_server');
  const lsFilename = existsSync(exeCand)
    ? 'language_server.exe'
    : existsSync(posixCand)
      ? 'language_server'
      : platform === 'win32'
        ? 'language_server.exe'
        : 'language_server';
  return {
    kind: 'standalone-electron',
    appPath,
    binDir,
    lsFilename,
    lsPath: join(binDir, lsFilename),
  };
}

function resolveStandaloneAgyExecutable(options = {}) {
  if (options.agyExecutablePath === null) return undefined;
  if (typeof options.agyExecutablePath === 'string' && options.agyExecutablePath.trim()) {
    const p = options.agyExecutablePath.trim();
    return existsSync(p) ? p : undefined;
  }
  if (isTestSandboxEnv()) return undefined;
  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          join(home, '.local', 'bin', 'agy.exe'),
          join(home, 'AppData', 'Local', 'Programs', 'agy', 'agy.exe'),
          join(home, '.antigravity', 'bin', 'agy.exe'),
        ]
      : [
          join(home, '.local', 'bin', 'agy'),
          join(home, '.npm-global', 'bin', 'agy'),
          join(home, '.antigravity', 'bin', 'agy'),
          '/opt/homebrew/bin/agy',
          '/usr/local/bin/agy',
        ];
  for (const cand of candidates) {
    if (existsSync(cand)) {
      try {
        const lst = safeLstat(cand);
        if (lst?.isSymbolicLink?.() && typeof realpathSync === 'function') {
          return realpathSync(cand);
        }
      } catch {
        // 保留原路径
      }
      return cand;
    }
  }
  return undefined;
}

function readAsarPackageVersionSync(asarPath) {
  if (typeof openSync !== 'function' || typeof readSync !== 'function' || typeof closeSync !== 'function') {
    return undefined;
  }
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) return undefined;
    const headerPayloadSize = prefix.readUInt32LE(4);
    const headerJsonLen = prefix.readUInt32LE(12);
    if (headerJsonLen === 0 || headerJsonLen > 16 * 1024 * 1024) return undefined;
    const headerBuf = Buffer.alloc(headerJsonLen);
    if (readSync(fd, headerBuf, 0, headerJsonLen, 16) !== headerJsonLen) return undefined;
    const tree = JSON.parse(headerBuf.toString('utf8'));
    const pkgEntry = tree?.files?.['package.json'];
    if (!pkgEntry || pkgEntry.unpacked || pkgEntry.offset === undefined) return undefined;
    const pkgSize = Number(pkgEntry.size);
    const pkgOffset = Number(pkgEntry.offset);
    if (!Number.isFinite(pkgSize) || pkgSize <= 0 || pkgSize > 256 * 1024 || !Number.isFinite(pkgOffset) || pkgOffset < 0) {
      return undefined;
    }
    const pkgBuf = Buffer.alloc(pkgSize);
    if (readSync(fd, pkgBuf, 0, pkgSize, 8 + headerPayloadSize + pkgOffset) !== pkgSize) return undefined;
    const pkg = JSON.parse(pkgBuf.toString('utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  }
}

function readDesktopAppVersionSync(appPath) {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  if (existsSync(plistPath)) {
    try {
      const xml = readFileSync(plistPath, 'utf8');
      const m = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/i.exec(xml);
      if (m?.[1]) return m[1];
    } catch {
      // 继续尝试其它入口
    }
  }
  const unpackedPkgPath = join(appPath, 'resources', 'app', 'package.json');
  if (existsSync(unpackedPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(unpackedPkgPath, 'utf8'));
      if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    } catch {
      // 继续尝试 app.asar
    }
  }
  const asarPath = join(appPath, 'resources', 'app.asar');
  if (existsSync(asarPath)) {
    return readAsarPackageVersionSync(asarPath);
  }
  return undefined;
}

function inspectDesktopLsFile(lsPath) {
  const lst = safeLstat(lsPath);
  if (!lst) {
    return {
      lstatExists: false,
      isSymlink: false,
      danglingSymlink: false,
      inspection: { exists: false, state: 'unknown' },
    };
  }
  if (typeof lst.isSymbolicLink === 'function' && lst.isSymbolicLink()) {
    const symlinkTarget = typeof readlinkSync === 'function' ? readlinkSync(lsPath) : '';
    try {
      const resolvedPath = typeof realpathSync === 'function' ? realpathSync(lsPath) : lsPath;
      return {
        lstatExists: true,
        isSymlink: true,
        danglingSymlink: false,
        symlinkTarget,
        resolvedPath,
        inspection: inspectAntigravityContextBinary(resolvedPath),
      };
    } catch {
      return {
        lstatExists: true,
        isSymlink: true,
        danglingSymlink: true,
        symlinkTarget,
        inspection: { exists: false, state: 'unknown' },
      };
    }
  }
  return {
    lstatExists: true,
    isSymlink: false,
    danglingSymlink: false,
    resolvedPath: lsPath,
    inspection: inspectAntigravityContextBinary(lsPath),
  };
}

function readMetaJsonFile(metaPath) {
  if (!existsSync(metaPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeMetaJsonFile(metaPath, meta) {
  const tmpPath = `${metaPath}.tmp-${process.pid || 0}-${Date.now()}`;
  try {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
    safeRename(tmpPath, metaPath);
  } catch {
    safeUnlink(tmpPath);
  }
}

function hasNativeExecutableMagic(filePath) {
  if (typeof openSync !== 'function' || typeof readSync !== 'function' || typeof closeSync !== 'function') {
    return false;
  }
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const hdr = Buffer.alloc(4);
    const n = readSync(fd, hdr, 0, 4, 0);
    if (n < 2) return false;
    if (hdr[0] === 0x4d && hdr[1] === 0x5a) return true; // MZ (PE)
    if (n < 4) return false;
    const magicBE = hdr.readUInt32BE(0);
    return (
      magicBE === 0xcffaedfe ||
      magicBE === 0xfeedfacf ||
      magicBE === 0xcefaedfe ||
      magicBE === 0xfeedface ||
      magicBE === 0xcafebabe ||
      magicBE === 0x7f454c46
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  }
}

function sweepUnlockedOldDesktopBinaries(binDir) {
  try {
    if (!existsSync(binDir)) return;
    for (const name of readdirSync(binDir)) {
      const entryName = typeof name === 'string' ? name : name?.name || '';
      if (!entryName.includes('.metabot-old-')) continue;
      try {
        safeUnlink(join(binDir, entryName));
      } catch {
        // Windows 运行中进程仍持有映像节锁，待旧进程退出后自动清理
      }
    }
  } catch {
    // 忽略扫描异常
  }
}

function swapStandaloneBinaryAtomically(targetLsPath, stagedLsPath) {
  const binDir = dirname(targetLsPath);
  const ext = ctxWinExtname(targetLsPath);
  const stem = ctxWinStripExt(basename(targetLsPath), ext);
  const oldHoldPath = join(binDir, `.${stem}.metabot-old-${process.pid || 0}-${Date.now()}${ext}`);
  let movedOld = false;

  const existingStat = safeLstat(targetLsPath);
  if (existingStat) {
    if (existingStat.isSymbolicLink?.()) {
      safeUnlink(targetLsPath);
    } else {
      safeRename(targetLsPath, oldHoldPath);
      movedOld = true;
    }
  }

  try {
    safeRename(stagedLsPath, targetLsPath);
  } catch (swapErr) {
    if (movedOld && !existsSync(targetLsPath) && existsSync(oldHoldPath)) {
      try {
        safeRename(oldHoldPath, targetLsPath);
      } catch {
        // 忽略回滚异常
      }
    }
    throw swapErr;
  }

  if (movedOld && existsSync(oldHoldPath)) {
    try {
      safeUnlink(oldHoldPath);
    } catch {
      // Windows NTFS 保持旧进程映像锁，退出后自动清理
    }
  }
  sweepUnlockedOldDesktopBinaries(binDir);
}

// --- macOS `.app` 整包签名与原子替换辅助函数 ---

function isMachORegularFile(filePath) {
  if (typeof openSync !== 'function' || typeof readSync !== 'function' || typeof closeSync !== 'function') {
    return false;
  }
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const hdr = Buffer.alloc(8);
    const bytesRead = readSync(fd, hdr, 0, 8, 0);
    if (bytesRead < 4) return false;
    const magic = hdr.readUInt32BE(0);
    if (magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xfeedface || magic === 0xcefaedfe) {
      return true;
    }
    if ((magic === 0xcafebabe || magic === 0xbebafeca) && bytesRead >= 8) {
      const narch = magic === 0xcafebabe ? hdr.readUInt32BE(4) : hdr.readUInt32LE(4);
      return narch >= 1 && narch <= 8;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  }
}

function isBundleMainExecutableParts(parts) {
  if (parts.length >= 3 && parts[parts.length - 2] === 'MacOS' && parts[parts.length - 3] === 'Contents') {
    return true;
  }
  if (parts.length >= 4 && parts[parts.length - 3] === 'Versions') {
    const fwDir = parts[parts.length - 4];
    if (fwDir.endsWith('.framework')) {
      const fwName = fwDir.slice(0, -'.framework'.length);
      if (parts[parts.length - 1] === fwName) return true;
    }
  }
  return false;
}

function collectDesktopSignableTargets(appRoot) {
  const items = [];
  const walk = (dir, relParts) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink?.()) continue;
      const full = join(dir, ent.name);
      const nextParts = [...relParts, ent.name];
      const rel = nextParts.join('/');
      if (ent.isDirectory?.()) {
        if (ent.name === '_CodeSignature') continue;
        walk(full, nextParts);
        if (ent.name.endsWith('.app') || ent.name.endsWith('.framework') || ent.name.endsWith('.xpc')) {
          items.push({ rel, kind: 'bundle', depth: nextParts.length });
        }
      } else if (ent.isFile?.()) {
        if (!isBundleMainExecutableParts(nextParts) && isMachORegularFile(full)) {
          items.push({ rel, kind: 'macho', depth: nextParts.length });
        }
      }
    }
  };
  walk(appRoot, []);
  items.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    if (a.kind !== b.kind) return a.kind === 'macho' ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });
  items.push({ rel: '', kind: 'root-app', depth: 0 });
  return items;
}

async function readCodesignDescriptor(targetPath) {
  if (process.platform !== 'darwin' || typeof execFile !== 'function') return {};
  const [dvStderr, entStdout] = await Promise.all([
    new Promise((resolve) => {
      execFile('codesign', ['-dvv', targetPath], { timeout: 10_000 }, (_err, _out, stderr) => {
        resolve(String(stderr ?? ''));
      });
    }),
    new Promise((resolve) => {
      execFile('codesign', ['-d', '--entitlements', '-', '--xml', targetPath], { timeout: 10_000 }, (err, out) => {
        resolve(err ? '' : String(out ?? '').trim());
      });
    }),
  ]);
  const idMatch = /^Identifier=(.+)$/m.exec(dvStderr);
  const teamMatch = /^TeamIdentifier=(.+)$/m.exec(dvStderr);
  const identifier = idMatch?.[1]?.trim();
  const rawTeam = teamMatch?.[1]?.trim();
  const teamIdentifier = rawTeam && rawTeam !== 'not set' ? rawTeam : undefined;
  const entitlementsXml =
    entStdout.includes('<plist') && (entStdout.includes('<dict>') || entStdout.includes('<dict/>'))
      ? entStdout
      : undefined;
  return { identifier, teamIdentifier, entitlementsXml };
}

function injectDisableLibraryValidationXml(xml) {
  if (xml.includes('com.apple.security.cs.disable-library-validation')) return xml;
  const entry = '<key>com.apple.security.cs.disable-library-validation</key><true/>';
  const closeIdx = xml.lastIndexOf('</dict>');
  if (closeIdx !== -1) return `${xml.slice(0, closeIdx)}${entry}${xml.slice(closeIdx)}`;
  if (xml.includes('<dict/>')) return xml.replace('<dict/>', `<dict>${entry}</dict>`);
  return xml;
}

async function verifyAppBundleSignatureStrict(appPath) {
  if (process.platform !== 'darwin' || typeof execFile !== 'function') return { ok: true };
  return new Promise((resolve) => {
    execFile('codesign', ['--verify', '--deep', '--strict', appPath], { timeout: 60_000 }, (err, _out, stderr) => {
      if (!err) resolve({ ok: true });
      else resolve({ ok: false, detail: String(stderr || err.message || err).trim() });
    });
  });
}

async function isGoogleOfficialAppBundle(appPath) {
  const desc = await readCodesignDescriptor(appPath);
  if (desc.teamIdentifier !== GOOGLE_ANTIGRAVITY_TEAM_ID) return false;
  const strictRes = await verifyAppBundleSignatureStrict(appPath);
  return strictRes.ok;
}

async function cloneAppBundle(srcApp, dstApp) {
  rmSync(dstApp, { recursive: true, force: true });
  mkdirSync(dirname(dstApp), { recursive: true });
  if (process.platform === 'darwin' && typeof execFile === 'function') {
    const cowOk = await new Promise((resolve) => {
      execFile('cp', ['-cR', srcApp, dstApp], { timeout: 60_000 }, (err) => resolve(!err));
    });
    if (cowOk) return;
    rmSync(dstApp, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      execFile('cp', ['-pR', srcApp, dstApp], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()));
    });
    return;
  }
  cpSync(srcApp, dstApp, { recursive: true, verbatimSymlinks: true });
}

async function signStagedDesktopAppBundle(stageAppPath, officialRefAppPath, scratchParentDir) {
  const signingIdentity = process.env?.ANTIGRAVITY_CODESIGN_IDENTITY?.trim() || '-';
  const isAdHoc = signingIdentity === '-';
  const targets = collectDesktopSignableTargets(stageAppPath);
  const entScratchDir = join(scratchParentDir, `.entitlements-tmp-${process.pid || 0}-${Date.now()}`);
  mkdirSync(entScratchDir, { recursive: true, mode: 0o700 });
  try {
    let idx = 0;
    for (const item of targets) {
      idx += 1;
      const stageTarget = item.rel ? join(stageAppPath, ...item.rel.split('/')) : stageAppPath;
      const origTarget = item.rel ? join(officialRefAppPath, ...item.rel.split('/')) : officialRefAppPath;
      const desc = existsSync(origTarget)
        ? await readCodesignDescriptor(origTarget)
        : await readCodesignDescriptor(stageTarget);
      let entXml = desc.entitlementsXml;
      const needsExemption =
        isAdHoc &&
        (Boolean(entXml) || item.rel.endsWith('.app') || item.rel.endsWith('.xpc') || item.kind === 'root-app');
      if (needsExemption) {
        entXml = entXml
          ? injectDisableLibraryValidationXml(entXml)
          : [
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
              '<plist version="1.0"><dict>',
              '<key>com.apple.security.cs.disable-library-validation</key><true/>',
              '</dict></plist>',
            ].join('');
      }
      const signArgs = ['-f', '-s', signingIdentity, '--options', 'runtime'];
      if (desc.identifier) signArgs.push('-i', desc.identifier);
      if (entXml) {
        const entFile = join(entScratchDir, `ent-${idx}.plist`);
        writeFileSync(entFile, entXml, { mode: 0o600 });
        signArgs.push('--entitlements', entFile);
      }
      signArgs.push(stageTarget);
      await new Promise((resolve, reject) => {
        execFile('codesign', signArgs, { timeout: 45_000 }, (err, _out, stderr) => {
          if (err) reject(new Error(`签名失败 (${item.rel || basename(stageAppPath)}): ${String(stderr || err.message).trim()}`));
          else resolve();
        });
      });
    }
  } finally {
    rmSync(entScratchDir, { recursive: true, force: true });
  }
}

function swapAppBundleAtomically(targetAppPath, stagedAppPath) {
  const parentDir = dirname(targetAppPath);
  const oldHoldApp = join(parentDir, `.Antigravity.metabot-old-${process.pid || 0}-${Date.now()}.app`);
  rmSync(oldHoldApp, { recursive: true, force: true });
  safeRename(targetAppPath, oldHoldApp);
  try {
    safeRename(stagedAppPath, targetAppPath);
  } catch (swapErr) {
    if (!existsSync(targetAppPath) && existsSync(oldHoldApp)) {
      try {
        safeRename(oldHoldApp, targetAppPath);
      } catch {
        // 忽略回滚异常
      }
    }
    throw swapErr;
  }
  rmSync(oldHoldApp, { recursive: true, force: true });
}

// --- 运行中 language_server(.exe) 进程与磁盘一致性核验 ---

function isCachedPidStillAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof process?.kill !== 'function') {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function inspectRunningDesktopLanguageServer(layout, options = {}) {
  if (!layout?.lsPath || typeof execFile !== 'function') {
    return { running: false, matchesDisk: true };
  }
  if (typeof options.inspectRunningFn === 'function') {
    return options.inspectRunningFn(layout);
  }
  if (isTestSandboxEnv() && !options.allowProcessProbeInTest) {
    return { running: false, matchesDisk: true };
  }

  const platform = options.platform || process.platform;
  const lsPath = layout.lsPath;

  if (platform === 'win32') {
    if (!existsSync(lsPath)) return { running: false, matchesDisk: false };
    sweepUnlockedOldDesktopBinaries(layout.binDir);

    let lsStat = null;
    let diskChangeMs = 0;
    let hasLockedOldBinary = false;
    try {
      lsStat = statSync(lsPath);
      diskChangeMs = Math.max(Number(lsStat.mtimeMs || 0), Number(lsStat.ctimeMs || lsStat.mtimeMs || 0));
      hasLockedOldBinary = readdirSync(layout.binDir).some((n) => String(n).includes('.metabot-old-'));
    } catch {
      return { running: false, matchesDisk: false };
    }

    const probeKey = `win32:${lsPath}:${Number(lsStat.size || 0)}:${Number(lsStat.mtimeMs || 0)}:${Number(lsStat.ctimeMs || 0)}:${hasLockedOldBinary ? 1 : 0}`;
    if (
      !options.forceProcessProbe &&
      ctxWinRunningProbeCache.key === probeKey &&
      ctxWinRunningProbeCache.result
    ) {
      const ageMs = Date.now() - ctxWinRunningProbeCache.ts;
      if (
        ctxWinRunningProbeCache.pid > 0 &&
        isCachedPidStillAlive(ctxWinRunningProbeCache.pid) &&
        ageMs < 60_000
      ) {
        return ctxWinRunningProbeCache.result;
      }
      if (ctxWinRunningProbeCache.pid === 0 && ageMs < 15_000) {
        return ctxWinRunningProbeCache.result;
      }
    }

    const cacheRunningProbe = (pid, resObj) => {
      ctxWinRunningProbeCache.key = probeKey;
      ctxWinRunningProbeCache.ts = Date.now();
      ctxWinRunningProbeCache.pid = Number.isInteger(pid) && pid > 0 ? pid : 0;
      ctxWinRunningProbeCache.result = resObj;
      return resObj;
    };

    const tasklistOut = await new Promise((resolve) => {
      execFile(
        'tasklist.exe',
        ['/FI', `IMAGENAME eq ${layout.lsFilename}`, '/FO', 'CSV', '/NH'],
        { timeout: 2_000, windowsHide: true },
        (err, out) => resolve(err ? '' : String(out ?? '').trim())
      );
    });
    if (tasklistOut && !tasklistOut.toLowerCase().includes(layout.lsFilename.toLowerCase())) {
      return cacheRunningProbe(0, { running: false, matchesDisk: true });
    }

    let currentDiskSha = '';
    try {
      currentDiskSha = computeContextFileSha256(lsPath);
    } catch {
      return { running: false, matchesDisk: false };
    }

    const psOut = await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-Process -Name 'language_server*' -ErrorAction SilentlyContinue | Select-Object Id, Path, @{Name='StartMs';Expression={if ($_.StartTime) {([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds()} else {$null}}} | ConvertTo-Json -Compress",
        ],
        { timeout: 4_000, windowsHide: true },
        (err, out) => resolve(err ? '' : String(out ?? '').trim())
      );
    });
    if (!psOut) return { running: false, matchesDisk: true };

    try {
      const parsed = JSON.parse(psOut);
      const list = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).sort(
        (a, b) => (Number(b?.StartMs) || 0) - (Number(a?.StartMs) || 0)
      );
      const normDir = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const targetBinLower = normDir(layout.binDir);
      const targetLsLower = normDir(lsPath);
      for (const proc of list) {
        if (typeof proc?.Path !== 'string' || !proc.Path.trim()) continue;
        const procPath = proc.Path.trim();
        if (normDir(dirname(procPath)) === targetBinLower) {
          const pid = typeof proc.Id === 'number' ? proc.Id : undefined;
          const samePath = normDir(procPath) === targetLsLower;
          const startedAfterDiskSwap =
            typeof proc.StartMs === 'number' && Number.isFinite(proc.StartMs)
              ? proc.StartMs >= diskChangeMs - 1_000
              : !hasLockedOldBinary;
          if (pid && samePath && startedAfterDiskSwap && currentDiskSha && !ctxWinRunningImageShaByPid.has(pid)) {
            ctxWinRunningImageShaByPid.set(pid, currentDiskSha);
          }
          const knownPidSha = pid ? ctxWinRunningImageShaByPid.get(pid) : undefined;
          const matchesByKnownSha = Boolean(knownPidSha && currentDiskSha && knownPidSha === currentDiskSha);
          return cacheRunningProbe(pid, {
            running: true,
            pid,
            matchesDisk: (samePath && startedAfterDiskSwap) || matchesByKnownSha,
          });
        }
      }
    } catch {
      // 忽略解析异常
    }
    return cacheRunningProbe(0, { running: false, matchesDisk: true });
  }

  if (platform === 'darwin') {
    let diskRealPath = lsPath;
    let diskInode = 0;
    try {
      diskRealPath = typeof realpathSync === 'function' ? realpathSync(lsPath) : lsPath;
      diskInode = Number(statSync(diskRealPath).ino || 0);
    } catch {
      return { running: false, matchesDisk: false };
    }
    const psOut = await new Promise((resolve) => {
      execFile('ps', ['-axo', 'pid=,command='], { timeout: 3_000 }, (err, out) =>
        resolve(err ? '' : String(out ?? ''))
      );
    });
    let targetPid;
    for (const rawLine of psOut.split(/\r?\n/)) {
      const m = /^(\d+)\s+(.+)$/.exec(rawLine.trim());
      if (!m) continue;
      if (m[2] === lsPath || m[2].startsWith(`${lsPath} `)) {
        targetPid = Number(m[1]);
        break;
      }
    }
    if (!targetPid) return { running: false, matchesDisk: true };
    const lsofBin = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
    const lsofOut = await new Promise((resolve) => {
      execFile(lsofBin, ['-a', '-d', 'txt', '-p', String(targetPid), '-Fni'], { timeout: 3_000 }, (err, out) =>
        resolve(err ? '' : String(out ?? ''))
      );
    });
    let pendingInode;
    let activeTxtPath;
    let activeInode;
    for (const rawLine of lsofOut.split(/\r?\n/)) {
      if (rawLine === 'ftxt') {
        pendingInode = undefined;
      } else if (rawLine.startsWith('i')) {
        const parsedInode = Number(rawLine.slice(1).trim());
        if (Number.isFinite(parsedInode) && parsedInode > 0) pendingInode = parsedInode;
      } else if (rawLine.startsWith('n/')) {
        const p = rawLine.slice(1).trim();
        if (p === lsPath || p === diskRealPath || basename(p).startsWith('language_server')) {
          activeTxtPath = p;
          activeInode = pendingInode;
          break;
        }
      }
    }
    if (!activeTxtPath) return { running: true, pid: targetPid, matchesDisk: true };
    return {
      running: true,
      pid: targetPid,
      matchesDisk: activeInode !== undefined && diskInode > 0 ? activeInode === diskInode : activeTxtPath === diskRealPath,
    };
  }

  return { running: false, matchesDisk: true };
}

// --- 切换执行逻辑（Windows/Linux standalone + macOS bundle + 独立 agy CLI） ---

async function switchStandaloneDesktopLocked(targetMode, layout, options = {}) {
  const { appPath, binDir, lsFilename, lsPath } = layout;
  const syncDir = resolveContextSyncDir(options);
  const officialBackupPath = join(syncDir, `${lsFilename}.official`);
  const metaPath = join(syncDir, 'context-meta.json');
  const appVersion = readDesktopAppVersionSync(appPath);

  const lsInfo = inspectDesktopLsFile(lsPath);
  if (!lsInfo.lstatExists) {
    return { ok: true, installed: false, mode: targetMode };
  }

  try {
    mkdirSync(syncDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, installed: true, mode: targetMode, error: `创建备份托管目录失败：${err?.message || err}` };
  }

  sweepUnlockedOldDesktopBinaries(binDir);
  ctxWinBinaryInspectionCache.delete(lsPath);
  if (lsInfo.resolvedPath) ctxWinBinaryInspectionCache.delete(lsInfo.resolvedPath);
  ctxWinBinaryInspectionCache.delete(officialBackupPath);

  if (!lsInfo.isSymlink) {
    if (lsInfo.inspection.state === 'official-256k') {
      const dotOrigPath = `${lsPath}.orig`;
      let hasValidDotOrig = false;
      if (existsSync(dotOrigPath)) {
        try {
          if (statSync(dotOrigPath).size === statSync(lsPath).size) {
            const origInsp = inspectAntigravityContextBinary(dotOrigPath);
            hasValidDotOrig =
              origInsp.state === 'official-256k' &&
              origInsp.patchOffset === lsInfo.inspection.patchOffset &&
              origInsp.patternId === lsInfo.inspection.patternId;
          }
        } catch {
          hasValidDotOrig = false;
        }
      }
      const activeSha = computeContextFileSha256(lsPath);
      const bkValid =
        existsSync(officialBackupPath) &&
        inspectAntigravityContextBinary(officialBackupPath).state === 'official-256k';
      const bkSha = bkValid ? computeContextFileSha256(officialBackupPath) : '';
      if (!bkValid || bkSha !== activeSha) {
        const seedSource = !bkValid && hasValidDotOrig ? dotOrigPath : lsPath;
        const tmpBk = `${officialBackupPath}.tmp-${process.pid || 0}-${Date.now()}`;
        try {
          safeCopyFile(seedSource, tmpBk);
          safeChmod(tmpBk, 0o755);
          safeRename(tmpBk, officialBackupPath);
          ctxWinBinaryInspectionCache.delete(officialBackupPath);
        } catch (err) {
          safeUnlink(tmpBk);
          return { ok: false, installed: true, mode: targetMode, error: `创建官方备份失败：${err?.message || err}` };
        }
      }
    } else if (lsInfo.inspection.state === 'unknown') {
      if (targetMode === '256k') {
        return { ok: true, installed: true, mode: '256k', appVersion };
      }
      return {
        ok: false,
        installed: true,
        mode: targetMode,
        error: `当前 ${lsFilename} 特征未识别，安全保持官方 256K`,
      };
    } else if (!existsSync(officialBackupPath)) {
      const dotOrigPath = `${lsPath}.orig`;
      if (existsSync(dotOrigPath)) {
        try {
          if (statSync(dotOrigPath).size === statSync(lsPath).size) {
            const origInsp = inspectAntigravityContextBinary(dotOrigPath);
            if (
              origInsp.state === 'official-256k' &&
              origInsp.patchOffset === lsInfo.inspection.patchOffset &&
              origInsp.patternId === lsInfo.inspection.patternId
            ) {
              const tmpBk = `${officialBackupPath}.tmp-${process.pid || 0}-${Date.now()}`;
              safeCopyFile(dotOrigPath, tmpBk);
              safeChmod(tmpBk, 0o755);
              safeRename(tmpBk, officialBackupPath);
              ctxWinBinaryInspectionCache.delete(officialBackupPath);
            }
          }
        } catch {
          // 忽略 .orig 读取异常，交由后续缺失备份校验报错
        }
      }
    }
  }

  const syncMeta = (mode, officialSha) => {
    if (!officialSha) return;
    const prev = readMetaJsonFile(metaPath);
    writeMetaJsonFile(metaPath, {
      version: appVersion ?? prev?.version,
      officialSha256: officialSha,
      mode,
      ...(prev?.pendingUpgradeNotice ? { pendingUpgradeNotice: prev.pendingUpgradeNotice } : {}),
    });
  };

  if (targetMode === '256k') {
    const bkInspect = inspectAntigravityContextBinary(officialBackupPath);
    const activeSha = !lsInfo.isSymlink ? computeContextFileSha256(lsPath) : '';
    const officialSha =
      bkInspect.exists && bkInspect.state === 'official-256k' ? computeContextFileSha256(officialBackupPath) : '';
    if (!lsInfo.isSymlink && lsInfo.inspection.state === 'official-256k' && (!officialSha || activeSha === officialSha)) {
      syncMeta('256k', activeSha);
      return { ok: true, installed: true, mode: '256k', appVersion };
    }
    if (!bkInspect.exists || bkInspect.state !== 'official-256k' || !officialSha) {
      return { ok: false, installed: true, mode: '256k', error: '未找到官方原版备份，已拒绝覆盖' };
    }
    if (!lsInfo.isSymlink && lsInfo.inspection.patternId && bkInspect.patternId !== lsInfo.inspection.patternId) {
      return { ok: false, installed: true, mode: '256k', error: '官方备份版本代数不一致，已拒绝覆盖' };
    }
    const ext = ctxWinExtname(lsFilename);
    const stem = ctxWinStripExt(lsFilename, ext);
    const stagedRestorePath = join(binDir, `.${stem}.metabot-restore-${process.pid || 0}-${Date.now()}${ext}`);
    try {
      safeCopyFile(officialBackupPath, stagedRestorePath);
      safeChmod(stagedRestorePath, 0o755);
      swapStandaloneBinaryAtomically(lsPath, stagedRestorePath);
      ctxWinBinaryInspectionCache.delete(lsPath);
      const postSha = computeContextFileSha256(lsPath);
      if (postSha !== officialSha || inspectAntigravityContextBinary(lsPath).state !== 'official-256k') {
        return { ok: false, installed: true, mode: '256k', error: '还原后 SHA-256 复核不一致' };
      }
      syncMeta('256k', officialSha);
      return { ok: true, installed: true, mode: '256k', appVersion };
    } catch (err) {
      safeUnlink(stagedRestorePath);
      return { ok: false, installed: true, mode: '256k', error: `还原官方原版失败：${err?.message || err}` };
    }
  }

  const bkInspect = inspectAntigravityContextBinary(officialBackupPath);
  if (!bkInspect.exists || bkInspect.state !== 'official-256k') {
    return { ok: false, installed: true, mode: targetMode, error: '缺少同版本官方 256K 原版备份' };
  }
  if (!lsInfo.isSymlink && lsInfo.inspection.patternId && bkInspect.patternId !== lsInfo.inspection.patternId) {
    return { ok: false, installed: true, mode: targetMode, error: '原版备份与当前应用特征代数不一致' };
  }

  const targetSpec = resolveContextModeSpec(targetMode);
  const officialSha = computeContextFileSha256(officialBackupPath);
  const prevMeta = readMetaJsonFile(metaPath);
  if (
    !lsInfo.isSymlink &&
    lsInfo.inspection.state === targetSpec.expectedBinaryState &&
    prevMeta?.officialSha256 === officialSha
  ) {
    syncMeta(targetMode, officialSha);
    return { ok: true, installed: true, mode: targetMode, appVersion };
  }

  const rawOfficial = readFileSync(officialBackupPath);
  const officialBuf = Buffer.isBuffer(rawOfficial) ? rawOfficial : Buffer.from(String(rawOfficial), 'utf8');
  const patchedBuf = buildPatchedClampBuffer(officialBuf, targetMode);
  if (!patchedBuf) {
    return { ok: false, installed: true, mode: targetMode, error: '目标指令特征校验未通过，保持官方原版' };
  }

  const ext = ctxWinExtname(lsFilename);
  const stem = ctxWinStripExt(lsFilename, ext);
  const stagedLsPath = join(binDir, `.${stem}.metabot-stage-${process.pid || 0}-${Date.now()}${ext}`);
  try {
    writeFileSync(stagedLsPath, patchedBuf, { mode: 0o755 });
    safeChmod(stagedLsPath, 0o755);
    ctxWinBinaryInspectionCache.delete(stagedLsPath);
    if (inspectAntigravityContextBinary(stagedLsPath).state !== targetSpec.expectedBinaryState) {
      throw new Error(`生成的 ${targetMode.toUpperCase()} 二进制复核未通过`);
    }

    if (typeof options.desktopVerifyExecFn === 'function') {
      const ok = await options.desktopVerifyExecFn(stagedLsPath);
      if (!ok) throw new Error('补丁二进制未通过启动预检');
    } else if (!isTestSandboxEnv() && hasNativeExecutableMagic(stagedLsPath) && typeof execFile === 'function') {
      const stampOk = await new Promise((resolve) => {
        execFile(stagedLsPath, ['--stamp'], { timeout: 10_000, windowsHide: true }, (err) => resolve(!err));
      });
      if (!stampOk) throw new Error(`${lsFilename} --stamp 启动预检未通过`);
    }

    swapStandaloneBinaryAtomically(lsPath, stagedLsPath);
    ctxWinBinaryInspectionCache.delete(lsPath);
    syncMeta(targetMode, officialSha);
    return { ok: true, installed: true, mode: targetMode, appVersion };
  } catch (err) {
    safeUnlink(stagedLsPath);
    return { ok: false, installed: true, mode: targetMode, error: `切换失败：${err?.message || err}` };
  }
}

async function switchMacBundleDesktopLocked(targetMode, layout, options = {}) {
  const { appPath, lsPath } = layout;
  const syncDir = resolveContextSyncDir(options);
  const officialAppBackupPath = join(syncDir, 'Antigravity.official.app');
  const officialBackupPath = join(officialAppBackupPath, 'Contents', 'Resources', 'bin', 'language_server');
  const metaPath = join(syncDir, 'context-meta.json');
  const appVersion = readDesktopAppVersionSync(appPath);

  const lsInfo = inspectDesktopLsFile(lsPath);
  if (!lsInfo.lstatExists) return { ok: true, installed: false, mode: targetMode };

  mkdirSync(syncDir, { recursive: true, mode: 0o700 });
  ctxWinBinaryInspectionCache.delete(lsPath);
  ctxWinBinaryInspectionCache.delete(officialBackupPath);

  if (!lsInfo.isSymlink) {
    if (lsInfo.inspection.state === 'official-256k') {
      const activeSha = computeContextFileSha256(lsPath);
      const backupValid =
        existsSync(officialBackupPath) &&
        inspectAntigravityContextBinary(officialBackupPath).state === 'official-256k' &&
        computeContextFileSha256(officialBackupPath) === activeSha;
      if (!backupValid) {
        if (!options.codesignFn && process.platform === 'darwin' && !isTestSandboxEnv()) {
          const googleOfficial = await isGoogleOfficialAppBundle(appPath);
          if (!googleOfficial) {
            return {
              ok: false,
              installed: true,
              mode: targetMode,
              error: '当前 Antigravity.app 未通过 Google 官方原始签名核验且无同版本备份',
            };
          }
        }
        const tmpBkApp = join(syncDir, `.Antigravity.official.tmp-${process.pid || 0}-${Date.now()}.app`);
        const oldBkApp = join(syncDir, `.Antigravity.official.old-${process.pid || 0}-${Date.now()}.app`);
        try {
          await cloneAppBundle(appPath, tmpBkApp);
          if (existsSync(officialAppBackupPath)) safeRename(officialAppBackupPath, oldBkApp);
          safeRename(tmpBkApp, officialAppBackupPath);
          rmSync(oldBkApp, { recursive: true, force: true });
          ctxWinBinaryInspectionCache.delete(officialBackupPath);
        } catch (err) {
          rmSync(tmpBkApp, { recursive: true, force: true });
          if (!existsSync(officialAppBackupPath) && existsSync(oldBkApp)) {
            try {
              safeRename(oldBkApp, officialAppBackupPath);
            } catch {
              // 忽略回滚异常
            }
          }
          return { ok: false, installed: true, mode: targetMode, error: `创建整包快照失败：${err?.message || err}` };
        }
      }
    } else if (lsInfo.inspection.state === 'unknown') {
      if (targetMode === '256k') return { ok: true, installed: true, mode: '256k', appVersion };
      return { ok: false, installed: true, mode: targetMode, error: '当前 language_server 特征未识别，保持官方 256K' };
    }
  }

  const syncMeta = (mode, officialSha) => {
    if (!officialSha) return;
    const prev = readMetaJsonFile(metaPath);
    writeMetaJsonFile(metaPath, {
      version: appVersion ?? prev?.version,
      officialSha256: officialSha,
      mode,
      ...(prev?.pendingUpgradeNotice ? { pendingUpgradeNotice: prev.pendingUpgradeNotice } : {}),
    });
  };

  if (targetMode === '256k') {
    const alreadyOfficial =
      !lsInfo.isSymlink &&
      lsInfo.inspection.state === 'official-256k' &&
      (options.codesignFn || process.platform !== 'darwin' || isTestSandboxEnv()
        ? true
        : await isGoogleOfficialAppBundle(appPath));
    if (alreadyOfficial) {
      const sha = computeContextFileSha256(lsPath);
      syncMeta('256k', sha);
      return { ok: true, installed: true, mode: '256k', appVersion };
    }
    const bkInspect = inspectAntigravityContextBinary(officialBackupPath);
    if (!bkInspect.exists || bkInspect.state !== 'official-256k') {
      return { ok: false, installed: true, mode: '256k', error: '未找到官方整包快照备份' };
    }
    if (!lsInfo.isSymlink && lsInfo.inspection.patternId && bkInspect.patternId !== lsInfo.inspection.patternId) {
      return { ok: false, installed: true, mode: '256k', error: '快照备份与当前应用版本代数不一致' };
    }
    const stageRestoreApp = join(
      dirname(appPath),
      `.Antigravity.metabot-restore-${process.pid || 0}-${Date.now()}.app`
    );
    try {
      await cloneAppBundle(officialAppBackupPath, stageRestoreApp);
      if (!options.codesignFn && process.platform === 'darwin' && !isTestSandboxEnv()) {
        const strictRes = await verifyAppBundleSignatureStrict(stageRestoreApp);
        if (!strictRes.ok) throw new Error(`官方快照签名复核未通过：${strictRes.detail || 'codesign failed'}`);
      }
      swapAppBundleAtomically(appPath, stageRestoreApp);
      ctxWinBinaryInspectionCache.delete(lsPath);
      const officialSha = computeContextFileSha256(officialBackupPath);
      syncMeta('256k', officialSha);
      return { ok: true, installed: true, mode: '256k', appVersion };
    } catch (err) {
      rmSync(stageRestoreApp, { recursive: true, force: true });
      return { ok: false, installed: true, mode: '256k', error: `还原整包失败：${err?.message || err}` };
    }
  }

  const bkInspect = inspectAntigravityContextBinary(officialBackupPath);
  if (!bkInspect.exists || bkInspect.state !== 'official-256k') {
    return { ok: false, installed: true, mode: targetMode, error: '缺少同代官方 256K 整包快照' };
  }
  const targetSpec = resolveContextModeSpec(targetMode);
  const officialSha = computeContextFileSha256(officialBackupPath);
  const prevMeta = readMetaJsonFile(metaPath);
  if (
    !lsInfo.isSymlink &&
    lsInfo.inspection.state === targetSpec.expectedBinaryState &&
    prevMeta?.officialSha256 === officialSha &&
    (options.codesignFn || process.platform !== 'darwin' || isTestSandboxEnv()
      ? true
      : (await verifyAppBundleSignatureStrict(appPath)).ok)
  ) {
    syncMeta(targetMode, officialSha);
    return { ok: true, installed: true, mode: targetMode, appVersion };
  }

  const rawOfficial = readFileSync(officialBackupPath);
  const officialBuf = Buffer.isBuffer(rawOfficial) ? rawOfficial : Buffer.from(String(rawOfficial), 'utf8');
  const patchedBuf = buildPatchedClampBuffer(officialBuf, targetMode);
  if (!patchedBuf) {
    return { ok: false, installed: true, mode: targetMode, error: '目标指令特征校验未通过' };
  }

  const stageApp = join(dirname(appPath), `.Antigravity.metabot-stage-${process.pid || 0}-${Date.now()}.app`);
  const stagedLsPath = join(stageApp, 'Contents', 'Resources', 'bin', 'language_server');
  const stagedMainExecPath = join(stageApp, 'Contents', 'MacOS', 'Antigravity');

  try {
    await cloneAppBundle(officialAppBackupPath, stageApp);
    if (!options.codesignFn && process.platform === 'darwin' && !isTestSandboxEnv() && typeof execFile === 'function') {
      await new Promise((resolve) => execFile('xattr', ['-cr', stageApp], { timeout: 20_000 }, () => resolve()));
    }
    if (safeLstat(stagedLsPath)) safeUnlink(stagedLsPath);
    writeFileSync(stagedLsPath, patchedBuf, { mode: 0o755 });
    safeChmod(stagedLsPath, 0o755);

    if (options.codesignFn) {
      await options.codesignFn(stagedLsPath);
    } else if (process.platform === 'darwin' && !isTestSandboxEnv()) {
      await signStagedDesktopAppBundle(stageApp, officialAppBackupPath, syncDir);
    }

    ctxWinBinaryInspectionCache.delete(stagedLsPath);
    if (inspectAntigravityContextBinary(stagedLsPath).state !== targetSpec.expectedBinaryState) {
      throw new Error(`生成的 ${targetMode.toUpperCase()} 二进制复核未通过`);
    }

    if (options.desktopVerifyExecFn) {
      const ok = await options.desktopVerifyExecFn(stagedLsPath);
      if (!ok) throw new Error('补丁包未通过启动预检');
    } else if (!options.codesignFn && process.platform === 'darwin' && !isTestSandboxEnv()) {
      const gate1 = await verifyAppBundleSignatureStrict(stageApp);
      if (!gate1.ok) throw new Error(`整包签名校验未通过 (Gate 1): ${gate1.detail || 'codesign failed'}`);
      const gate2Ok = await new Promise((resolve) =>
        execFile(stagedLsPath, ['--stamp'], { timeout: 10_000 }, (err) => resolve(!err))
      );
      if (!gate2Ok) throw new Error('language_server --stamp 预检未通过 (Gate 2)');
      if (existsSync(stagedMainExecPath)) {
        const gate3Ok = await new Promise((resolve) =>
          execFile(
            stagedMainExecPath,
            ['-e', 'process.exit(0)'],
            { timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
            (err) => resolve(!err)
          )
        );
        if (!gate3Ok) throw new Error('主程序框架加载预检未通过 (Gate 3)');
      }
    }

    swapAppBundleAtomically(appPath, stageApp);
    ctxWinBinaryInspectionCache.delete(lsPath);
    syncMeta(targetMode, officialSha);
    return { ok: true, installed: true, mode: targetMode, appVersion };
  } catch (err) {
    rmSync(stageApp, { recursive: true, force: true });
    return { ok: false, installed: true, mode: targetMode, error: `切换失败：${err?.message || err}` };
  }
}

async function switchStandaloneAgyCliIfPresent(targetMode, options = {}) {
  const executablePath = resolveStandaloneAgyExecutable(options);
  if (!executablePath || !existsSync(executablePath)) return { ok: true, installed: false };

  const officialBackupPath = `${executablePath}.official`;
  ctxWinBinaryInspectionCache.delete(executablePath);
  ctxWinBinaryInspectionCache.delete(officialBackupPath);
  for (const m of PATCHED_CONTEXT_MODES) {
    ctxWinBinaryInspectionCache.delete(`${executablePath}-${m}`);
  }

  const removeArtifactsExcept = (keepMode) => {
    for (const m of PATCHED_CONTEXT_MODES) {
      if (m === keepMode) continue;
      const p = `${executablePath}-${m}`;
      if (existsSync(p)) safeUnlink(p);
      ctxWinBinaryInspectionCache.delete(p);
    }
  };

  const activeInspection = inspectAntigravityContextBinary(executablePath);
  if (activeInspection.state === 'official-256k') {
    const activeSha = computeContextFileSha256(executablePath);
    const backupValid =
      existsSync(officialBackupPath) &&
      inspectAntigravityContextBinary(officialBackupPath).state === 'official-256k' &&
      computeContextFileSha256(officialBackupPath) === activeSha;
    if (!backupValid) {
      const tmpBk = `${officialBackupPath}.tmp-${process.pid || 0}-${Date.now()}`;
      safeCopyFile(executablePath, tmpBk);
      safeChmod(tmpBk, 0o755);
      safeRename(tmpBk, officialBackupPath);
      ctxWinBinaryInspectionCache.delete(officialBackupPath);
    }
  }

  if (targetMode === '256k') {
    if (activeInspection.state === 'official-256k' || activeInspection.state === 'unknown') {
      removeArtifactsExcept(null);
      return { ok: true, installed: true };
    }
    const bkInspect = inspectAntigravityContextBinary(officialBackupPath);
    if (!bkInspect.exists || bkInspect.state !== 'official-256k' || bkInspect.patternId !== activeInspection.patternId) {
      return { ok: false, installed: true, error: '未找到匹配的 agy 官方原版备份' };
    }
    const tmpRestore = `${executablePath}.restore-${process.pid || 0}-${Date.now()}`;
    try {
      safeCopyFile(officialBackupPath, tmpRestore);
      safeChmod(tmpRestore, 0o755);
      swapStandaloneBinaryAtomically(executablePath, tmpRestore);
      ctxWinBinaryInspectionCache.delete(executablePath);
      removeArtifactsExcept(null);
      return { ok: true, installed: true };
    } catch (err) {
      safeUnlink(tmpRestore);
      return { ok: false, installed: true, error: `还原 agy 失败：${err?.message || err}` };
    }
  }

  if (activeInspection.state === 'unknown') {
    return { ok: true, installed: true };
  }
  const bkInspect = inspectAntigravityContextBinary(officialBackupPath);
  if (!bkInspect.exists || bkInspect.state !== 'official-256k' || bkInspect.patternId !== activeInspection.patternId) {
    return { ok: false, installed: true, error: '未找到同版本 agy 官方原版备份' };
  }
  const rawOfficial = readFileSync(officialBackupPath);
  const officialBuf = Buffer.isBuffer(rawOfficial) ? rawOfficial : Buffer.from(String(rawOfficial), 'utf8');
  const patchedBuf = buildPatchedClampBuffer(officialBuf, targetMode);
  if (!patchedBuf) return { ok: false, installed: true, error: 'agy 特征校验未通过' };

  const targetArtifactPath = `${executablePath}-${targetMode}`;
  const tmpPatched = `${targetArtifactPath}.tmp-${process.pid || 0}-${Date.now()}`;
  const tmpActive = `${executablePath}.tmp-${process.pid || 0}-${Date.now()}`;
  try {
    writeFileSync(tmpPatched, patchedBuf, { mode: 0o755 });
    safeChmod(tmpPatched, 0o755);
    if (options.codesignFn) {
      await options.codesignFn(tmpPatched);
    } else if (process.platform === 'darwin' && !isTestSandboxEnv() && typeof execFile === 'function') {
      await new Promise((resolve, reject) =>
        execFile('codesign', ['-f', '-s', '-', tmpPatched], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()))
      );
    }
    safeRename(tmpPatched, targetArtifactPath);
    safeCopyFile(targetArtifactPath, tmpActive);
    safeChmod(tmpActive, 0o755);
    swapStandaloneBinaryAtomically(executablePath, tmpActive);
    ctxWinBinaryInspectionCache.delete(executablePath);
    removeArtifactsExcept(targetMode);
    return { ok: true, installed: true };
  } catch (err) {
    safeUnlink(tmpPatched);
    safeUnlink(tmpActive);
    return { ok: false, installed: true, error: `切换 agy 失败：${err?.message || err}` };
  }
}

function withContextSwitchLock(taskFn) {
  const next = ctxWinRuntimeState.switchQueue.then(taskFn, taskFn);
  ctxWinRuntimeState.switchQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * 获取当前上下文压缩水位状态快照（默认带 3 秒轻量缓存，切换后立即刷新）。
 */
export async function getContextWindowControlSnapshot(options = {}) {
  const now = Date.now();
  const hasCustomOpts = Boolean(
    options.desktopAppPath !== undefined ||
      options.desktopSyncDir !== undefined ||
      options.policyFilePath !== undefined ||
      options.agyExecutablePath !== undefined
  );
  if (
    !options.forceRefresh &&
    !hasCustomOpts &&
    ctxWinRuntimeState.snapshotCache &&
    now - ctxWinRuntimeState.snapshotTs < SNAPSHOT_TTL_MS
  ) {
    return ctxWinRuntimeState.snapshotCache;
  }

  const appPath = resolveAntigravityDesktopAppPath(options);
  const agyPath = resolveStandaloneAgyExecutable(options);
  const policyRecord = readContextPolicyRecord(options);

  if (!appPath && !agyPath) {
    const emptySnap = {
      supported: false,
      installed: false,
      mode: policyRecord?.mode || '256k',
      diskMode: 'unknown',
      targetTokens: resolveContextModeSpec(policyRecord?.mode || '256k').checkpointLimit,
      binaryState: 'unknown',
      officialBackupExists: false,
      appVersion: null,
      needsRestart: false,
      runningMatchesDisk: true,
      lastError: ctxWinRuntimeState.lastError,
    };
    if (!hasCustomOpts) {
      ctxWinRuntimeState.snapshotCache = emptySnap;
      ctxWinRuntimeState.snapshotTs = now;
    }
    return emptySnap;
  }

  let binaryState = 'unknown';
  let officialBackupExists = false;
  let appVersion = null;
  let runningStatus = { running: false, matchesDisk: true };

  if (appPath) {
    const layout = resolveDesktopLayout(appPath, options.platform || process.platform);
    const syncDir = resolveContextSyncDir(options);
    const officialBackupPath =
      layout.kind === 'macos-bundle'
        ? join(syncDir, 'Antigravity.official.app', 'Contents', 'Resources', 'bin', 'language_server')
        : join(syncDir, `${layout.lsFilename}.official`);
    const lsInfo = inspectDesktopLsFile(layout.lsPath);
    if (!lsInfo.lstatExists) {
      const missingSnap = {
        supported: false,
        installed: false,
        mode: policyRecord?.mode || '256k',
        diskMode: 'unknown',
        targetTokens: resolveContextModeSpec(policyRecord?.mode || '256k').checkpointLimit,
        binaryState: 'unknown',
        officialBackupExists: false,
        appVersion: null,
        needsRestart: false,
        runningMatchesDisk: true,
        lastError: ctxWinRuntimeState.lastError,
      };
      if (!hasCustomOpts) {
        ctxWinRuntimeState.snapshotCache = missingSnap;
        ctxWinRuntimeState.snapshotTs = now;
      }
      return missingSnap;
    }
    binaryState = lsInfo.inspection.state;
    officialBackupExists =
      existsSync(officialBackupPath) &&
      inspectAntigravityContextBinary(officialBackupPath).state === 'official-256k';
    appVersion = readDesktopAppVersionSync(appPath) || null;
    runningStatus = await inspectRunningDesktopLanguageServer(layout, options);
  } else if (agyPath) {
    const agyInsp = inspectAntigravityContextBinary(agyPath);
    binaryState = agyInsp.state;
    const agyBk = `${agyPath}.official`;
    officialBackupExists =
      existsSync(agyBk) && inspectAntigravityContextBinary(agyBk).state === 'official-256k';
  }

  const diskMode = binaryStateToMode(binaryState);
  const mode = policyRecord?.mode || (diskMode !== 'unknown' ? diskMode : '256k');
  const spec = resolveContextModeSpec(mode);
  const supported = binaryState !== 'unknown' || officialBackupExists;
  const needsRestart = Boolean(
    runningStatus.running && (!runningStatus.matchesDisk || (diskMode !== 'unknown' && diskMode !== mode))
  );

  const snapshot = {
    supported,
    installed: true,
    mode,
    diskMode,
    targetTokens: spec.checkpointLimit,
    binaryState,
    officialBackupExists,
    appVersion,
    needsRestart,
    runningMatchesDisk: Boolean(runningStatus.matchesDisk),
    lastError: ctxWinRuntimeState.lastError,
  };

  if (!hasCustomOpts) {
    ctxWinRuntimeState.snapshotCache = snapshot;
    ctxWinRuntimeState.snapshotTs = Date.now();
  }
  return snapshot;
}

/**
 * 一键切换上下文压缩水位（`256k` | `512k` | `768k` | `1m`），同步桌面端、CLI 与全局策略文件。
 */
export async function switchContextWindowMode(rawMode, options = {}) {
  const targetMode = normalizeContextWindowMode(rawMode);
  if (!targetMode) {
    return {
      ok: false,
      error: '无效的上下文水位档位（可选 256k / 512k / 768k / 1m）',
      contextWindowControl: await getContextWindowControlSnapshot({ ...options, forceRefresh: true }),
    };
  }

  return withContextSwitchLock(async () => {
    const appPath = resolveAntigravityDesktopAppPath(options);
    const agyPath = resolveStandaloneAgyExecutable(options);
    if (!appPath && !agyPath) {
      const errMsg = '未检测到本机 Antigravity 安装目录';
      ctxWinRuntimeState.lastError = errMsg;
      return {
        ok: false,
        error: errMsg,
        contextWindowControl: await getContextWindowControlSnapshot({ ...options, forceRefresh: true }),
      };
    }

    let desktopRes = { ok: true, installed: false };
    if (appPath) {
      const layout = resolveDesktopLayout(appPath, options.platform || process.platform);
      desktopRes =
        layout.kind === 'macos-bundle'
          ? await switchMacBundleDesktopLocked(targetMode, layout, options)
          : await switchStandaloneDesktopLocked(targetMode, layout, options);
      if (!desktopRes.ok) {
        ctxWinRuntimeState.lastError = desktopRes.error || '桌面端上下文水位切换失败';
        return {
          ok: false,
          error: ctxWinRuntimeState.lastError,
          contextWindowControl: await getContextWindowControlSnapshot({ ...options, forceRefresh: true }),
        };
      }
    }

    if (agyPath) {
      const cliRes = await switchStandaloneAgyCliIfPresent(targetMode, options);
      if (!cliRes.ok && !desktopRes.installed) {
        ctxWinRuntimeState.lastError = cliRes.error || 'agy CLI 上下文水位切换失败';
        return {
          ok: false,
          error: ctxWinRuntimeState.lastError,
          contextWindowControl: await getContextWindowControlSnapshot({ ...options, forceRefresh: true }),
        };
      }
    }

    writeContextPolicyRecord(targetMode, {
      ...options,
      updatedBy: options.updatedBy || 'usage-monitor',
    });
    ctxWinRuntimeState.lastError = null;
    ctxWinRuntimeState.snapshotCache = null;
    ctxWinRuntimeState.snapshotTs = 0;
    ctxWinFileSha256Cache.clear();
    ctxWinRunningProbeCache.key = '';
    ctxWinRunningProbeCache.ts = 0;
    ctxWinRunningProbeCache.pid = 0;
    ctxWinRunningProbeCache.result = null;

    const contextWindowControl = await getContextWindowControlSnapshot({ ...options, forceRefresh: true });
    return {
      ok: true,
      mode: targetMode,
      contextWindowControl,
    };
  });
}

/**
 * Sidecar 启动时静默自检对齐：
 * 仅当磁盘已存在全局策略文件（用户主动选择过档位）且桌面端或 CLI 因升级回退到不一致状态时，自动更新备份并重适配。
 */
export async function ensureContextWindowAlignedOnBoot(options = {}) {
  const policyRecord = readContextPolicyRecord(options);
  if (!policyRecord?.mode) {
    return null;
  }
  const snap = await getContextWindowControlSnapshot({ ...options, forceRefresh: true });
  if (!snap.installed || !snap.supported) {
    return snap;
  }
  if (snap.diskMode !== policyRecord.mode || !snap.officialBackupExists) {
    const res = await switchContextWindowMode(policyRecord.mode, {
      ...options,
      updatedBy: policyRecord.updatedBy || 'usage-monitor-autosync',
    });
    return res.contextWindowControl;
  }
  return snap;
}

export function clearContextWindowCachesForTests() {
  ctxWinBinaryInspectionCache.clear();
  ctxWinDynamicOffsetHints.clear();
  ctxWinRunningImageShaByPid.clear();
  ctxWinFileSha256Cache.clear();
  ctxWinRunningProbeCache.key = '';
  ctxWinRunningProbeCache.ts = 0;
  ctxWinRunningProbeCache.pid = 0;
  ctxWinRunningProbeCache.result = null;
  ctxWinRuntimeState.snapshotCache = null;
  ctxWinRuntimeState.snapshotTs = 0;
  ctxWinRuntimeState.lastError = null;
}
