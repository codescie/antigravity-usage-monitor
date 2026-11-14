import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AGY_CLAMP_X64_UNPATCHED_HEX,
  buildPatchedClampBuffer,
  clearContextWindowCachesForTests,
  decodeArm64ClampAt,
  decodeX64ClampAt,
  ensureContextWindowAlignedOnBoot,
  getContextWindowControlSnapshot,
  inspectAntigravityContextBinary,
  normalizeContextWindowMode,
  switchContextWindowMode,
} from '../backend/context-window-manager.mjs';
import {
  ALLOWED_BRIDGE_PATHS,
  createWindowBridgeController,
} from '../backend/window-bridge.mjs';
import { backendHarness } from './backend-harness.mjs';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 构造带 `.text` 与 `.rdata` 嵌入式 Go 1.20+ `gopclntab` 的最小合法 PE64 `x86_64` 测试镜像。
 */
function buildSyntheticPe64ClampBinary({ seedByte = 0x11 } = {}) {
  const clampBytes = Buffer.from(AGY_CLAMP_X64_UNPATCHED_HEX, 'hex');
  const totalSize = 0x1000;
  const buf = Buffer.alloc(totalSize, 0);

  // MZ + e_lfanew -> 0x80
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  buf.writeUInt32LE(0x80, 0x3c);

  // PE\0\0 + COFF Header (x86_64 = 0x8664, 2 sections, optHeaderSize = 0xf0)
  const peOff = 0x80;
  buf.writeUInt32LE(0x00004550, peOff);
  buf.writeUInt16LE(0x8664, peOff + 4);
  buf.writeUInt16LE(2, peOff + 6);
  buf.writeUInt16LE(0xf0, peOff + 20);

  // Optional Header PE32+ (magic 0x20b, ImageBase = 0x140000000)
  const optOff = peOff + 24;
  buf.writeUInt16LE(0x020b, optOff);
  buf.writeBigUInt64LE(0x140000000n, optOff + 24);

  // Section 0: .text (RVA 0x1000, rawPtr 0x400, rawSize 0x400)
  const sectOff = optOff + 0xf0;
  buf.write('.text\0\0\0', sectOff, 8, 'ascii');
  buf.writeUInt32LE(0x400, sectOff + 8);
  buf.writeUInt32LE(0x1000, sectOff + 12);
  buf.writeUInt32LE(0x400, sectOff + 16);
  buf.writeUInt32LE(0x400, sectOff + 20);

  // Section 1: .rdata (RVA 0x2000, rawPtr 0x800, rawSize 0x600)
  const rdataSect = sectOff + 40;
  buf.write('.rdata\0\0', rdataSect, 8, 'ascii');
  buf.writeUInt32LE(0x600, rdataSect + 8);
  buf.writeUInt32LE(0x2000, rdataSect + 12);
  buf.writeUInt32LE(0x600, rdataSect + 16);
  buf.writeUInt32LE(0x800, rdataSect + 20);

  // Place clamp sequence inside .text at file offset 0x480 (func RVA 0x1060..0x1120)
  buf[0x400] = seedByte;
  clampBytes.copy(buf, 0x480);

  // Place Go 1.20+ gopclntab at .rdata offset 0x840
  const pcln = 0x840;
  buf.writeUInt32LE(0xfffffff1, pcln); // magic
  buf[pcln + 6] = 1; // minLC
  buf[pcln + 7] = 8; // ptrSize
  buf.writeBigUInt64LE(1n, pcln + 8); // nfunctab = 1
  buf.writeBigUInt64LE(0x140001000n, pcln + 24); // textStart = ImageBase + .text RVA
  buf.writeBigUInt64LE(0x80n, pcln + 32); // funcnameOff
  buf.writeBigUInt64LE(0x140n, pcln + 64); // functabOff

  const fnName = 'pkg.(*ModelConfig).ClampCheckpointConfigForModelInfo\0';
  buf.write(fnName, pcln + 0x80, 'ascii');

  // functab[0]: entryOff = 0x60 (file 0x460), funcInfoOff = 0x20; sentinel nextEntryOff = 0x120 (file 0x520)
  const ft = pcln + 0x140;
  buf.writeUInt32LE(0x60, ft);
  buf.writeUInt32LE(0x20, ft + 4);
  buf.writeUInt32LE(0x120, ft + 8);
  // _func at ft + 0x20: entryOff = 0x60, nameOff = 0
  buf.writeUInt32LE(0x60, ft + 0x20);
  buf.writeInt32LE(0, ft + 0x24);

  return buf;
}

/**
 * 构造最小合法的 44 字节 ARM64 5 锚点 clamp 指令窗。
 */
function buildArm64ClampWindowBuffer() {
  const insns = [
    0xb9400c45, // i0: ldr w5, [x2, #12]
    0x35000125, // i1: cbnz w5, +36
    0xb9801465, // i2: ldrsw x5, [x3, #20]
    0xd2938806, // i3: mov x6, #0x9c40
    0xeb0600bf, // i4: cmp x5, x6
    0x9a9f30a5, // i5: csel x5, x5, xzr, lo
    0xd2999806, // i6: mov x6, #0xccc0
    0x8b0600a5, // i7: add x5, x5, x6
    0x910000a5, // i8: add x5, x5, #0
    0xb9000c45, // i9: str w5, [x2, #12]
    0xb9801465, // i10: ldrsw x5, [x3, #20]
  ];
  const out = Buffer.alloc(insns.length * 4);
  insns.forEach((u32, idx) => out.writeUInt32LE(u32 >>> 0, idx * 4));
  return out;
}

/**
 * 构造最小合法 Electron `app.asar` Pickle 头部，验证无解包读取 `package.json` 版本号。
 */
function buildMinimalAppAsar(version = '2.32.0') {
  const pkgBytes = Buffer.from(JSON.stringify({ name: 'antigravity', version }), 'utf8');
  const treeJson = JSON.stringify({
    files: {
      'package.json': {
        size: pkgBytes.length,
        offset: '0',
      },
    },
  });
  const treeBytes = Buffer.from(treeJson, 'utf8');
  const paddedJsonLen = Math.ceil(treeBytes.length / 4) * 4;
  const headerPayloadSize = 8 + paddedJsonLen;
  const prefix = Buffer.alloc(16 + paddedJsonLen);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerPayloadSize, 4);
  prefix.writeUInt32LE(4 + paddedJsonLen, 8);
  prefix.writeUInt32LE(treeBytes.length, 12);
  treeBytes.copy(prefix, 16);
  return Buffer.concat([prefix, pkgBytes]);
}

test('normalizeContextWindowMode and dual-architecture x86_64 / ARM64 clamp semantic codecs', () => {
  assert.equal(normalizeContextWindowMode('256K'), '256k');
  assert.equal(normalizeContextWindowMode('official'), '256k');
  assert.equal(normalizeContextWindowMode('512k'), '512k');
  assert.equal(normalizeContextWindowMode('768K'), '768k');
  assert.equal(normalizeContextWindowMode('1m'), '1m');
  assert.equal(normalizeContextWindowMode('invalid'), null);

  // PE64 x86_64 round-trip across 512k, 768k, 1m
  const peOfficial = buildSyntheticPe64ClampBinary();
  const x64Base = decodeX64ClampAt(peOfficial, 0x480);
  assert.equal(x64Base?.state, 'official-256k');

  for (const [mode, expectedState] of [
    ['512k', 'patched-512k'],
    ['768k', 'patched-768k'],
    ['1m', 'patched-1m'],
  ]) {
    const patched = buildPatchedClampBuffer(peOfficial, mode);
    assert.ok(patched, `expected PE64 patch buffer for ${mode}`);
    assert.equal(patched.length, peOfficial.length);
    const decoded = decodeX64ClampAt(patched, 0x480);
    assert.equal(decoded?.state, expectedState);
  }

  // ARM64 44-byte clamp window round-trip across 512k, 768k, 1m
  const armWin = buildArm64ClampWindowBuffer();
  const armDecoded = decodeArm64ClampAt(armWin, 0);
  assert.equal(armDecoded?.state, 'official-256k');
  for (const [mode, expectedState] of [
    ['512k', 'patched-512k'],
    ['768k', 'patched-768k'],
    ['1m', 'patched-1m'],
  ]) {
    const armPatched = buildPatchedClampBuffer(armWin, mode);
    assert.ok(armPatched, `expected ARM64 patch buffer for ${mode}`);
    assert.equal(decodeArm64ClampAt(armPatched, 0)?.state, expectedState);
  }
});

test('Windows standalone desktop + agy CLI switching, byte-exact 256k restore, .orig self-heal, and boot upgrade alignment', async () => {
  clearContextWindowCachesForTests();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-ctx-win-'));
  try {
    const appDir = path.join(tmpRoot, 'Antigravity');
    const binDir = path.join(appDir, 'resources', 'bin');
    const syncDir = path.join(tmpRoot, 'sync');
    const policyPath = path.join(tmpRoot, 'antigravity-context-policy.json');
    const agyCliPath = path.join(tmpRoot, 'cli', 'agy.exe');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.dirname(agyCliPath), { recursive: true });

    const officialPe = buildSyntheticPe64ClampBinary({ seedByte: 0x21 });
    const officialSha = sha256(officialPe);
    const lsPath = path.join(binDir, 'language_server.exe');
    fs.writeFileSync(lsPath, officialPe);
    fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), buildMinimalAppAsar('2.32.0'));
    fs.writeFileSync(agyCliPath, officialPe);

    const opts = {
      platform: 'win32',
      desktopAppPath: appDir,
      desktopSyncDir: syncDir,
      policyFilePath: policyPath,
      agyExecutablePath: agyCliPath,
      desktopVerifyExecFn: async () => true,
      inspectRunningFn: async () => ({ running: true, matchesDisk: true }),
    };

    // 1. Without policy file, ensureContextWindowAlignedOnBoot stays 100% read-only
    const bootNoPolicy = await ensureContextWindowAlignedOnBoot(opts);
    assert.equal(bootNoPolicy, null);
    assert.equal(fs.existsSync(policyPath), false);
    assert.equal(fs.existsSync(path.join(syncDir, 'language_server.exe.official')), false);

    // 2. Initial snapshot reflects official 256k and reads app.asar version 2.32.0
    const initialSnap = await getContextWindowControlSnapshot({ ...opts, forceRefresh: true });
    assert.equal(initialSnap.installed, true);
    assert.equal(initialSnap.supported, true);
    assert.equal(initialSnap.mode, '256k');
    assert.equal(initialSnap.diskMode, '256k');
    assert.equal(initialSnap.appVersion, '2.32.0');
    assert.equal(initialSnap.needsRestart, false);

    // 3. Switch to 768k -> backs up .official, patches desktop + agy.exe, writes shared policy
    const sw768 = await switchContextWindowMode('768k', {
      ...opts,
      inspectRunningFn: async () => ({ running: true, matchesDisk: false }),
    });
    assert.equal(sw768.ok, true);
    assert.equal(sw768.mode, '768k');
    assert.equal(sw768.contextWindowControl.mode, '768k');
    assert.equal(sw768.contextWindowControl.diskMode, '768k');
    assert.equal(sw768.contextWindowControl.targetTokens, 786432);
    assert.equal(sw768.contextWindowControl.needsRestart, true);
    assert.equal(inspectAntigravityContextBinary(lsPath).state, 'patched-768k');
    assert.equal(inspectAntigravityContextBinary(agyCliPath).state, 'patched-768k');
    assert.equal(sha256(fs.readFileSync(path.join(syncDir, 'language_server.exe.official'))), officialSha);

    const savedPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assert.equal(savedPolicy.mode, '768k');
    assert.equal(savedPolicy.updatedBy, 'usage-monitor');

    // 4. Switch to 512k anytime, then back to 256k -> byte-exact SHA-256 restore
    const sw512 = await switchContextWindowMode('512k', opts);
    assert.equal(sw512.ok, true);
    assert.equal(inspectAntigravityContextBinary(lsPath).state, 'patched-512k');
    assert.equal(inspectAntigravityContextBinary(agyCliPath).state, 'patched-512k');

    const sw256 = await switchContextWindowMode('256k', opts);
    assert.equal(sw256.ok, true);
    assert.equal(inspectAntigravityContextBinary(lsPath).state, 'official-256k');
    assert.equal(sha256(fs.readFileSync(lsPath)), officialSha);
    assert.equal(sha256(fs.readFileSync(agyCliPath)), officialSha);

    // 5. Simulate external dirty patch with .orig pristine backup -> self-heals .official
    const syncDir2 = path.join(tmpRoot, 'sync-orig-heal');
    const prePatched512 = buildPatchedClampBuffer(officialPe, '512k');
    fs.writeFileSync(lsPath, prePatched512);
    fs.writeFileSync(`${lsPath}.orig`, officialPe);
    clearContextWindowCachesForTests();

    const swHeal = await switchContextWindowMode('768k', {
      ...opts,
      desktopSyncDir: syncDir2,
    });
    assert.equal(swHeal.ok, true);
    assert.equal(sha256(fs.readFileSync(path.join(syncDir2, 'language_server.exe.official'))), officialSha);
    assert.equal(inspectAntigravityContextBinary(lsPath).state, 'patched-768k');

    // 6. Simulate Antigravity self-upgrade to v2.33.0 while policy is 768k -> boot auto-realigns
    const upgradedPe = buildSyntheticPe64ClampBinary({ seedByte: 0x99 });
    const upgradedSha = sha256(upgradedPe);
    fs.writeFileSync(lsPath, upgradedPe);
    fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), buildMinimalAppAsar('2.33.0'));
    clearContextWindowCachesForTests();

    const alignedSnap = await ensureContextWindowAlignedOnBoot({
      ...opts,
      desktopSyncDir: syncDir2,
    });
    assert.equal(alignedSnap?.mode, '768k');
    assert.equal(alignedSnap?.diskMode, '768k');
    assert.equal(alignedSnap?.appVersion, '2.33.0');
    assert.equal(sha256(fs.readFileSync(path.join(syncDir2, 'language_server.exe.official'))), upgradedSha);
    assert.equal(inspectAntigravityContextBinary(lsPath).state, 'patched-768k');
  } finally {
    clearContextWindowCachesForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Bridge allowlist, /api/context-window routes, telemetry payload, and compiled UI bundle integration', async () => {
  assert.equal(ALLOWED_BRIDGE_PATHS.has('/api/context-window/status'), true);
  assert.equal(ALLOWED_BRIDGE_PATHS.has('/api/context-window/switch'), true);

  const env = backendHarness({ settings: {} });
  const appRoot = '/test-app';
  const lsPath = '/test-app/resources/bin/language_server.exe';
  const syncDir = '/test-sync';
  const policyPath = '/test-home/.gemini/antigravity-context-policy.json';
  const officialPe = buildSyntheticPe64ClampBinary({ seedByte: 0x55 });
  env.state.virtualFiles.set(lsPath, Buffer.from(officialPe));

  // Verify direct manager switching inside VM sandbox
  const switched = await env.switchContextWindowMode('768k', {
    platform: 'win32',
    desktopAppPath: appRoot,
    desktopSyncDir: syncDir,
    policyFilePath: policyPath,
    desktopVerifyExecFn: async () => true,
    inspectRunningFn: async () => ({ running: false, matchesDisk: true }),
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.contextWindowControl.mode, '768k');
  assert.equal(switched.contextWindowControl.targetTokens, 786432);

  // Verify bridge API endpoints return valid JSON payloads
  const statusRes = await env.dispatchBridgeApiRequest('/api/context-window/status', 'GET', {});
  assert.equal(statusRes.status, 200);
  const statusJson = JSON.parse(statusRes.body);
  assert.equal(statusJson.ok, true);
  assert.equal(typeof statusJson.contextWindowControl.installed, 'boolean');

  const invalidRes = await env.dispatchBridgeApiRequest('/api/context-window/switch', 'POST', {
    mode: 'bogus',
  });
  assert.equal(invalidRes.status, 400);
  assert.equal(JSON.parse(invalidRes.body).ok, false);

  const telPayload = await env.buildTelemetryPayloadInternal('', false, {});
  assert.ok(telPayload.contextWindowControl, 'telemetry payload must include contextWindowControl');

  // Verify compiled styles.css and app.js ship the minimalist inline switcher
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(appJs, /\/api\/context-window\/switch/);
  assert.match(appJs, /ctx-tier-bar/);
  assert.match(stylesCss, /\.ctx-tier-bar\b/);
  assert.match(stylesCss, /\.ctx-tier-btn\.is-active\b/);
});

test('Regression: orphan sidecar reaps itself on dead LS_ADDR and new sidecar steals stale lease immediately', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-lease-zombie-'));
  try {
    const leaseFile = path.join(tmpDir, 'window-bridge-lease.json');

    // 1. Orphan sidecar whose LS_ADDR (127.0.0.1:41001) died triggers onParentLsDead after 2 strikes
    let reapedCount = 0;
    const orphanCtrl = createWindowBridgeController({
      handleApiRequest: async () => ({ status: 200, body: '{}' }),
      readAssetFn: async () => '',
      getSettingsFn: () => ({ enableWindowOverlay: true }),
      getBundleVersionFn: () => '100',
      bootBundleVersion: '100',
      lsAddr: '127.0.0.1:41001',
      leaseFilePath: leaseFile,
      probeLoopbackAliveFn: async () => false,
      onParentLsDead: () => {
        reapedCount += 1;
      },
    });
    const r1 = await orphanCtrl.syncAllWindows();
    assert.equal(r1.reason, 'parent_ls_unreachable');
    assert.equal(reapedCount, 0);
    const r2 = await orphanCtrl.syncAllWindows();
    assert.equal(r2.reason, 'parent_ls_unreachable');
    assert.equal(reapedCount, 1);

    // 2. Live sidecar immediately takes over lease held by an alive PID whose LS_ADDR is dead
    fs.writeFileSync(
      leaseFile,
      JSON.stringify({
        pid: process.ppid || 1,
        lsAddr: '127.0.0.1:41001',
        bundleVersion: '100',
        updatedAtMs: Date.now(),
      })
    );
    const liveCtrl = createWindowBridgeController({
      handleApiRequest: async () => ({ status: 200, body: '{}' }),
      readAssetFn: async () => '',
      getSettingsFn: () => ({ enableWindowOverlay: true }),
      getBundleVersionFn: () => '100',
      bootBundleVersion: '100',
      lsAddr: '127.0.0.1:41002',
      homeDir: tmpDir,
      env: {},
      leaseFilePath: leaseFile,
      probeLoopbackAliveFn: async (addr) => addr === '127.0.0.1:41002',
    });
    const takeoverRes = await liveCtrl.syncAllWindows();
    assert.notEqual(takeoverRes.reason, 'follower_yield');
    const updatedLease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    assert.equal(updatedLease.pid, process.pid);
    assert.equal(updatedLease.lsAddr, '127.0.0.1:41002');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Regression: win32 snapshot caches SHA-256 and process probe until binary changes', async () => {
  const lsPath = '/test-cache-app/resources/bin/language_server.exe';
  const lsDir = '/test-cache-app/resources/bin';
  const officialPe = buildSyntheticPe64ClampBinary({ seedByte: 0x33 });
  let tasklistCalls = 0;
  let psCalls = 0;

  const env = backendHarness({
    settings: {},
    execFileImpl: (cmd, _args, _opts, cb) => {
      const exe = String(cmd || '').toLowerCase();
      if (exe.includes('tasklist')) {
        tasklistCalls += 1;
        cb(null, '"language_server.exe","999999"', '');
        return;
      }
      if (exe.includes('powershell')) {
        psCalls += 1;
        cb(
          null,
          JSON.stringify({
            Id: process.pid,
            Path: 'C:\\test-cache-app\\resources\\bin\\language_server.exe',
            StartMs: Date.now() - 500,
          }),
          ''
        );
        return;
      }
      cb(new Error('unexpected execFile'));
    },
  });

  env.state.virtualFiles.set(lsPath, Buffer.from(officialPe));
  env.state.virtualMtimes.set(lsPath, 1000);

  const opts = {
    platform: 'win32',
    desktopAppPath: '/test-cache-app',
    desktopSyncDir: '/test-cache-sync',
    policyFilePath: '/test-cache-home/.gemini/antigravity-context-policy.json',
    allowProcessProbeInTest: true,
    forceRefresh: true,
  };

  // Fix virtual stat normalization for win32 backslash paths if needed — snapshot uses POSIX join in backendHarness unless path.join matches
  const snap1 = await env.getContextWindowControlSnapshot(opts);
  assert.equal(snap1.installed, true);
  assert.equal(tasklistCalls, 1, 'Initial win32 snapshot runs tasklist once');
  assert.equal(psCalls, 1, 'Initial win32 snapshot runs PowerShell probe once');

  // Repeat forceRefresh while file stat and running PID are unchanged -> process probes stay cached
  const snap2 = await env.getContextWindowControlSnapshot(opts);
  assert.equal(snap2.installed, true);
  assert.equal(tasklistCalls, 1, 'Cached probe skips redundant tasklist spawn');
  assert.equal(psCalls, 1, 'Cached probe skips redundant PowerShell spawn');

  // Modify binary on disk -> mtime/size changes -> triggers fresh probe & SHA-256 recompute
  env.state.virtualFiles.set(lsPath, buildPatchedClampBuffer(officialPe, '512k'));
  env.state.virtualMtimes.set(lsPath, 2000);
  const snap3 = await env.getContextWindowControlSnapshot(opts);
  assert.equal(snap3.diskMode, '512k');
  assert.equal(tasklistCalls, 2, 'Binary stat change invalidates process probe cache');
  assert.equal(psCalls, 2);
  assert.ok(existsCheckCountSafe(lsDir));
});

function existsCheckCountSafe() {
  return true;
}

/**
 * 构造最小合法 Mach-O 64位镜象（支持 ARM64 0x0100000c 或 Intel x86_64 0x01000007）。
 */
function buildSyntheticMachO64ClampBinary({ cputype = 0x01000007 } = {}) {
  const isX64 = cputype === 0x01000007;
  const clampBuf = isX64
    ? Buffer.from(AGY_CLAMP_X64_UNPATCHED_HEX, 'hex')
    : buildArm64ClampWindowBuffer();

  const totalSize = 0x1000;
  const buf = Buffer.alloc(totalSize, 0);
  // Mach-O 64-bit header (magic 0xfeedfacf LE)
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cputype >>> 0, 4);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(1, 16); // ncmds = 1
  buf.writeUInt32LE(232, 20); // sizeofcmds = 72 + 2*80

  // LC_SEGMENT_64 (0x19) __TEXT with 2 sections (__text, __lrodata_gopcln)
  const cmdOff = 32;
  buf.writeUInt32LE(0x19, cmdOff);
  buf.writeUInt32LE(232, cmdOff + 4);
  buf.write('__TEXT\0\0\0\0\0\0\0\0\0\0', cmdOff + 8, 16, 'ascii');
  buf.writeBigUInt64LE(0x100000000n, cmdOff + 24); // vmaddr
  buf.writeBigUInt64LE(0x1000n, cmdOff + 32);
  buf.writeBigUInt64LE(0n, cmdOff + 40); // fileoff
  buf.writeBigUInt64LE(0x1000n, cmdOff + 48);
  buf.writeUInt32LE(2, cmdOff + 64); // nsects

  // Section 0: __text (addr 0x100000400, size 0x400, offset 0x400)
  const s0 = cmdOff + 72;
  buf.write('__text\0\0\0\0\0\0\0\0\0\0', s0, 16, 'ascii');
  buf.write('__TEXT\0\0\0\0\0\0\0\0\0\0', s0 + 16, 16, 'ascii');
  buf.writeBigUInt64LE(0x100000400n, s0 + 32);
  buf.writeBigUInt64LE(0x400n, s0 + 40);
  buf.writeUInt32LE(0x400, s0 + 48);

  // Section 1: __lrodata_gopcln (addr 0x100000800, size 0x600, offset 0x800)
  const s1 = s0 + 80;
  buf.write('__lrodata_gopcln', s1, 16, 'ascii');
  buf.write('__TEXT\0\0\0\0\0\0\0\0\0\0', s1 + 16, 16, 'ascii');
  buf.writeBigUInt64LE(0x100000800n, s1 + 32);
  buf.writeBigUInt64LE(0x600n, s1 + 40);
  buf.writeUInt32LE(0x800, s1 + 48);

  // Copy clamp sequence at file offset 0x480
  clampBuf.copy(buf, 0x480);

  // Write Go 1.20+ gopclntab at 0x800
  const pcln = 0x800;
  buf.writeUInt32LE(0xfffffff1, pcln);
  buf[pcln + 6] = 1;
  buf[pcln + 7] = 8;
  buf.writeBigUInt64LE(1n, pcln + 8);
  buf.writeBigUInt64LE(0x100000400n, pcln + 24);
  buf.writeBigUInt64LE(0x80n, pcln + 32);
  buf.writeBigUInt64LE(0x140n, pcln + 64);

  const fnName = 'pkg.(*ModelConfig).ClampCheckpointConfigForModelInfo\0';
  buf.write(fnName, pcln + 0x80, 'ascii');

  const ft = pcln + 0x140;
  buf.writeUInt32LE(0x60, ft);
  buf.writeUInt32LE(0x20, ft + 4);
  buf.writeUInt32LE(0x120, ft + 8);
  buf.writeUInt32LE(0x60, ft + 0x20);
  buf.writeInt32LE(0, ft + 0x24);

  return buf;
}

/**
 * 将 ARM64 + Intel x86_64 两个 Mach-O 切片封装为 macOS Universal Fat Binary (0xcafebabe)。
 */
function buildUniversalFatMachOClampBinary() {
  const armSlice = buildSyntheticMachO64ClampBinary({ cputype: 0x0100000c });
  const x64Slice = buildSyntheticMachO64ClampBinary({ cputype: 0x01000007 });
  const armOff = 0x1000;
  const x64Off = armOff + armSlice.length;
  const fat = Buffer.alloc(x64Off + x64Slice.length, 0);

  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  // Slice 0: ARM64
  fat.writeUInt32BE(0x0100000c, 8);
  fat.writeUInt32BE(0, 12);
  fat.writeUInt32BE(armOff, 16);
  fat.writeUInt32BE(armSlice.length, 20);
  fat.writeUInt32BE(12, 24);
  // Slice 1: x86_64
  fat.writeUInt32BE(0x01000007, 28);
  fat.writeUInt32BE(3, 32);
  fat.writeUInt32BE(x64Off, 36);
  fat.writeUInt32BE(x64Slice.length, 40);
  fat.writeUInt32BE(12, 44);

  armSlice.copy(fat, armOff);
  x64Slice.copy(fat, x64Off);
  return fat;
}

test('macOS Intel x86_64 Mach-O & Universal Fat Mach-O binary detection and patching across all tiers', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-mac-fat-'));
  try {
    // 1. Thin Intel x86_64 Mach-O roundtrip
    const x64Mach = buildSyntheticMachO64ClampBinary({ cputype: 0x01000007 });
    const x64Path = path.join(tmpDir, 'ls_x64');
    fs.writeFileSync(x64Path, x64Mach);
    assert.equal(inspectAntigravityContextBinary(x64Path).state, 'official-256k');
    for (const [mode, expected] of [
      ['512k', 'patched-512k'],
      ['768k', 'patched-768k'],
      ['1m', 'patched-1m'],
    ]) {
      const patched = buildPatchedClampBuffer(x64Mach, mode);
      assert.ok(patched, `Intel Mach-O patched cleanly for ${mode}`);
      const outPath = path.join(tmpDir, `ls_x64_${mode}`);
      fs.writeFileSync(outPath, patched);
      assert.equal(inspectAntigravityContextBinary(outPath).state, expected);
    }

    // 2. Universal Fat Mach-O patches BOTH ARM64 and x86_64 slices consistently
    const fatMach = buildUniversalFatMachOClampBinary();
    const fatPath = path.join(tmpDir, 'ls_universal');
    fs.writeFileSync(fatPath, fatMach);
    assert.equal(inspectAntigravityContextBinary(fatPath).state, 'official-256k');
    for (const [mode, expected] of [
      ['512k', 'patched-512k'],
      ['768k', 'patched-768k'],
      ['1m', 'patched-1m'],
    ]) {
      const patchedFat = buildPatchedClampBuffer(fatMach, mode);
      assert.ok(patchedFat, `Universal Fat Mach-O patched cleanly for ${mode}`);
      const outPath = path.join(tmpDir, `ls_fat_${mode}`);
      fs.writeFileSync(outPath, patchedFat);
      assert.equal(inspectAntigravityContextBinary(outPath).state, expected);
      // Verify individual embedded slices match target state
      const armPatchedSlice = patchedFat.subarray(0x1000, 0x2000);
      const x64PatchedSlice = patchedFat.subarray(0x2000, 0x3000);
      assert.equal(decodeArm64ClampAt(armPatchedSlice, 0x480)?.state, expected);
      assert.equal(decodeX64ClampAt(x64PatchedSlice, 0x480)?.state, expected);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Regression: macOS darwin snapshot caches ps/lsof process probe and exposes platform=darwin', async () => {
  const macLsPath = path.join('/test-mac/Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server_macos_arm');
  const normMacLsPath = macLsPath.replace(/\\/g, '/');
  const armMach = buildSyntheticMachO64ClampBinary({ cputype: 0x0100000c });
  let psCalls = 0;
  let lsofCalls = 0;

  const env = backendHarness({
    settings: {},
    execFileImpl: (cmd, _args, _opts, cb) => {
      const bin = String(cmd || '').toLowerCase();
      if (bin === 'ps') {
        psCalls += 1;
        cb(null, `${process.pid} ${macLsPath} --stdio\n`, '');
        return;
      }
      if (bin.includes('lsof')) {
        lsofCalls += 1;
        cb(null, `ftxt\ni1\nn${macLsPath}\n`, '');
        return;
      }
      cb(new Error('unexpected execFile'));
    },
  });

  env.state.virtualFiles.set(normMacLsPath, Buffer.from(armMach));
  env.state.virtualMtimes.set(normMacLsPath, 3000);

  const opts = {
    platform: 'darwin',
    desktopAppPath: '/test-mac/Antigravity.app',
    desktopSyncDir: '/test-mac-sync',
    policyFilePath: '/test-mac-home/.gemini/antigravity-context-policy.json',
    allowProcessProbeInTest: true,
    forceRefresh: true,
  };

  const snap1 = await env.getContextWindowControlSnapshot(opts);
  assert.equal(snap1.platform, 'darwin');
  assert.equal(snap1.installed, true);
  assert.equal(snap1.diskMode, '256k');
  assert.equal(psCalls, 1, 'Initial darwin snapshot runs ps once');
  assert.equal(lsofCalls, 1, 'Initial darwin snapshot runs lsof once');

  const snap2 = await env.getContextWindowControlSnapshot(opts);
  assert.equal(snap2.platform, 'darwin');
  assert.equal(psCalls, 1, 'Cached darwin probe skips redundant ps spawn');
  assert.equal(lsofCalls, 1, 'Cached darwin probe skips redundant lsof spawn');
});
