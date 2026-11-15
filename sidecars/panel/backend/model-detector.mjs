/**
 * @fileoverview Antigravity 偏好设置「模型检测」后端编排服务。
 *
 * 职责边界：
 * 1. 指纹库管理与增量热更新：优先加载 `DATA_DIR/model-detector/bank/`，回退至内置 `vendor/seed-bank.zip`，
 *    支持定时与手动从 `https://modeldial.com/fingerprint-v1/asset-manifest.json` 增量校验 SHA-256 更新；
 * 2. 反重力模型目录实时同步：直接从宿主 `GetUserStatus` (`clientModelConfigs` + `clientModelSorts`) 提取当前账号可用的全部反重力模型，
 *    当宿主新增或更新模型时自动同步；严格限制仅允许检测反重力环境下的模型；
 * 3. 当前窗口模型自动跟随与探针强隔离：综合主窗口模型选择器实时提示、当前活跃非探针会话最近步骤模型 (`modelKey`)
 *    与宿主默认选中配置 (`defaultOverrideModelConfig`)，默认锁定当前窗口模型，且绝不被后台探针会话污染；
 * 4. 极速零工具探针与自适应流式守护：
 *    - 通过插件内置极简隐藏代理 (`--profile=model-detector-probe`，零工具 Schema、零思维链复述) 消除 3w+ 思考词拖慢；
 *    - 默认启用「极速同权」路由：当所选为同一基座模型的 `High`/`XHigh`/`Medium` 思考档位且存在健康的同基座 `Low` 档位时，
 *      自动通过同权轻思考通道采样（耗时从 120s-190s 降至 8s-18s，节省约 95% 思考配额），同时支持切换「原档直测」；
 *    - 配备基于流式活性的自适应超时续期、2/3 多数派容错结算，以及完成后记账归档 + 自动取消/清理临时探针会话。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import { extractModelSteps } from '../speed-metrics.mjs';
import {
  BRAIN_DIR,
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  DATA_DIR,
  HERE,
  LS_ADDR,
  loadJson,
  saveJson,
  trajectoryCache,
} from './config.mjs';
import {
  resolveAntigravityDesktopAppPath,
  resolveStandaloneAgyExecutable,
} from './context-window-manager.mjs';
import { callLsRpc } from './ls-rpc.mjs';
import {
  REQUIRED_BANK_ASSETS,
  buildEngineFromBuffers,
  buildFullDiagnosis,
  buildPrimaryJsonFromUnifiedBank,
  diffManifestAssets,
  generateChallengeSet,
  parseNumbers,
  readZipEntries,
  sha256Hex,
  suggestAntigravityReference,
} from './model-detector-core.mjs';

export const MODEL_DETECTOR_PROBE_TITLE_PREFIX = '[模型检测探针]';
export const MODEL_DETECTOR_PROBE_PROFILE = 'model-detector-probe';
export const CURRENT_WINDOW_MODEL_SENTINEL = '__current__';

const SEED_BANK_ZIP_FILE = join(HERE, 'vendor', 'seed-bank.zip');
const DETECTOR_DATA_DIR = join(DATA_DIR, 'model-detector');
const DETECTOR_BANK_DIR = join(DETECTOR_DATA_DIR, 'bank');
const DETECTOR_STATE_FILE = join(DETECTOR_DATA_DIR, 'state.json');
const DETECTOR_HISTORY_FILE = join(DETECTOR_DATA_DIR, 'history.json');

const MODELDIAL_BASE_URL = 'https://modeldial.com/fingerprint-v1';
const LM_DETECTOR_UPSTREAM_BASE_URL =
  'https://raw.githubusercontent.com/Ikaleio/lm-detector/main/data';
const BANK_SYNC_TTL_MS = 6 * 3600 * 1000;
const BANK_SYNC_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const MODEL_CATALOG_CACHE_TTL_MS = 2500;
const MAX_DETECTOR_HISTORY = 12;

/** 单路探针首次响应等待上限（无流式活性时） */
const PROBE_INITIAL_TIMEOUT_MS = 95_000;
/** 检测到思维链或正文字节持续增长时的单次活性续期窗口 */
const PROBE_ACTIVE_EXTENSION_MS = 65_000;
/** 单路探针绝对硬超时上限（兼容原档直测 XHigh 深度推理） */
const PROBE_MAX_WALL_MS = 240_000;
/** 当已有 2/3 探针完成采样后，留给最后 1 路慢速探针的宽限窗口 */
const PROBE_STRAGGLER_GRACE_MS = 28_000;
const PROBE_POLL_INTERVAL_MS = 450;

export const modelDetectorRuntime = {
  engine: null,
  engineError: null,
  bankSyncInFlight: null,
  isBankSyncing: false,
  lastBankAttemptMs: 0,
  healedProjectId: '',
  catalogMemo: {
    ts: 0,
    userStatus: null,
    summaries: null,
  },
  runningJob: null,
  cancelToken: null,
  activeProbeConvIds: new Set(),
};

export function isModelDetectorProbeTitle(title) {
  return String(title || '').trim().startsWith(MODEL_DETECTOR_PROBE_TITLE_PREFIX);
}

export function normalizeDetectorProbeMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'exact' ? 'exact' : 'fast';
}

/**
 * 解析带思考强度后缀（`-xhigh` / `-high` / `-medium` / `-low`）的模型基座键。
 * 注意：`gemini-pro-orchestrator` 等独立编排端点不含此类后缀，返回 `null`，绝不跨模型代测。
 *
 * @param {string} modelId
 * @returns {{ base: string, tier: string } | null}
 */
export function extractTieredModelBase(modelId) {
  const clean = String(modelId || '').trim().toLowerCase();
  const m = clean.match(/^(.+)-(xhigh|high|medium|low)$/);
  if (!m || !m[1]) return null;
  return { base: m[1], tier: m[2] };
}

/**
 * 在「极速同权」(`fast`) 模式下，若目标模型属于 `High`/`XHigh`/`Medium` 思考档位，
 * 且当前可用列表中存在同基座、有额度的轻思考档位（优先 `Low`，其次 `Medium`），
 * 自动路由至该同权轻思考档位执行无语义整数采样，大幅降低思维链延迟与 Token 消耗。
 *
 * @param {object} targetModel
 * @param {object[]} availableModels
 * @param {'fast'|'exact'} [probeMode='fast']
 */
export function resolveProbeExecutionModel(targetModel, availableModels = [], probeMode = 'fast') {
  const normalizedMode = normalizeDetectorProbeMode(probeMode);
  if (!targetModel || normalizedMode === 'exact') {
    return {
      executionModel: targetModel,
      fastTierRouted: false,
      probeMode: normalizedMode,
    };
  }

  const parsed = extractTieredModelBase(targetModel.modelId);
  if (!parsed || parsed.tier === 'low') {
    return {
      executionModel: targetModel,
      fastTierRouted: false,
      probeMode: normalizedMode,
    };
  }

  const candidateTiers = parsed.tier === 'medium' ? ['low'] : ['low', 'medium'];
  for (const tier of candidateTiers) {
    const wantedId = `${parsed.base}-${tier}`;
    const found = availableModels.find(
      (m) => String(m?.modelId || '').toLowerCase() === wantedId && !m.isQuotaExhausted
    );
    if (found && found.modelId !== targetModel.modelId) {
      return {
        executionModel: found,
        fastTierRouted: true,
        probeMode: normalizedMode,
      };
    }
  }

  return {
    executionModel: targetModel,
    fastTierRouted: false,
    probeMode: normalizedMode,
  };
}

function loadDetectorPersistState() {
  const raw = loadJson(DETECTOR_STATE_FILE, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function saveDetectorPersistState(patch) {
  const next = {
    ...loadDetectorPersistState(),
    ...patch,
  };
  saveJson(DETECTOR_STATE_FILE, next);
  return next;
}

function loadDetectorHistory() {
  const raw = loadJson(DETECTOR_HISTORY_FILE, []);
  return Array.isArray(raw) ? raw.slice(0, MAX_DETECTOR_HISTORY) : [];
}

function prependDetectorHistory(record) {
  const prev = loadDetectorHistory().filter((item) => item?.id !== record.id);
  const next = [record, ...prev].slice(0, MAX_DETECTOR_HISTORY);
  saveJson(DETECTOR_HISTORY_FILE, next);
  return next;
}

function loadEngineFromDiskBank() {
  const manifestPath = join(DETECTOR_BANK_DIR, 'asset-manifest.json');
  if (!existsSync(manifestPath)) return null;
  const files = new Map();
  files.set('asset-manifest.json', readFileSync(manifestPath));
  for (const rel of REQUIRED_BANK_ASSETS) {
    const full = join(DETECTOR_BANK_DIR, ...rel.split('/'));
    if (!existsSync(full)) return null;
    files.set(rel, readFileSync(full));
  }
  return buildEngineFromBuffers(files, { source: 'remote' });
}

function loadEngineFromSeedZip() {
  if (!existsSync(SEED_BANK_ZIP_FILE)) return null;
  const zipBuf = readFileSync(SEED_BANK_ZIP_FILE);
  const entries = readZipEntries(zipBuf);
  return buildEngineFromBuffers(entries, { source: 'builtin' });
}

export function ensureDetectorEngine({ forceReload = false } = {}) {
  if (modelDetectorRuntime.engine && !forceReload) {
    return modelDetectorRuntime.engine;
  }
  modelDetectorRuntime.engineError = null;
  try {
    const diskEngine = loadEngineFromDiskBank();
    if (diskEngine) {
      modelDetectorRuntime.engine = diskEngine;
      return diskEngine;
    }
  } catch (err) {
    modelDetectorRuntime.engineError = err?.message || String(err);
  }
  try {
    const seedEngine = loadEngineFromSeedZip();
    if (seedEngine) {
      modelDetectorRuntime.engine = seedEngine;
      modelDetectorRuntime.engineError = null;
      return seedEngine;
    }
  } catch (err) {
    modelDetectorRuntime.engineError = err?.message || String(err);
  }
  return null;
}

async function fetchDetectorAssetBuffer(relPath, assetMeta) {
  const gzRel = typeof assetMeta?.gzip === 'string' ? assetMeta.gzip : '';
  if (gzRel) {
    try {
      const gzRes = await fetch(`${MODELDIAL_BASE_URL}/${gzRel.replace(/^\/+/, '')}`, {
        method: 'GET',
        signal: AbortSignal.timeout(20_000),
      });
      if (gzRes.ok) {
        const compressed = Buffer.from(await gzRes.arrayBuffer());
        return zlib.gunzipSync(compressed);
      }
    } catch {
      // gzip 通道失败时自动回退原始文件通道
    }
  }
  const rawRes = await fetch(`${MODELDIAL_BASE_URL}/${relPath.replace(/^\/+/, '')}`, {
    method: 'GET',
    signal: AbortSignal.timeout(25_000),
  });
  if (!rawRes.ok) {
    throw new Error(`下载指纹库资产失败 (${relPath}: HTTP ${rawRes.status})`);
  }
  return Buffer.from(await rawRes.arrayBuffer());
}

function loadCurrentBankBuffers() {
  const manifestPath = join(DETECTOR_BANK_DIR, 'asset-manifest.json');
  if (existsSync(manifestPath)) {
    const map = new Map();
    map.set('asset-manifest.json', readFileSync(manifestPath));
    let complete = true;
    for (const rel of REQUIRED_BANK_ASSETS) {
      const full = join(DETECTOR_BANK_DIR, ...rel.split('/'));
      if (!existsSync(full)) {
        complete = false;
        break;
      }
      map.set(rel, readFileSync(full));
    }
    if (complete) return map;
  }
  if (existsSync(SEED_BANK_ZIP_FILE)) {
    return readZipEntries(readFileSync(SEED_BANK_ZIP_FILE));
  }
  return null;
}

/**
 * 检查并增量同步数字指纹库（双源择优 + 防降级 + SHA-256 强校验）：
 * 1. 检查 `modeldial.com` 镜像清单，校验哈希并更新辅助库或规则（若镜像主库版本落后于本地则防降级跳过主库覆盖）；
 * 2. 同时穿透检查上游权威仓库 `Ikaleio/lm-detector` 最新 `unified_bank.json` + `shared_detector.bin`，
 *    当上游已收录新模型（如 `gemini-4-hydrogen`）而 `modeldial.com` 尚未重部署时，自动拉取并二进制对齐校验后热更新。
 *
 * @param {{ force?: boolean }} [options]
 */
export async function syncDetectorBank({ force = false } = {}) {
  const engine = ensureDetectorEngine();
  const persist = loadDetectorPersistState();
  const now = Date.now();

  if (!LS_ADDR || LS_ADDR === 'test.invalid') {
    if (!force) return getDetectorBankSummary();
  }

  if (!force) {
    if (
      modelDetectorRuntime.lastBankAttemptMs > 0 &&
      now - modelDetectorRuntime.lastBankAttemptMs < BANK_SYNC_RETRY_COOLDOWN_MS
    ) {
      return getDetectorBankSummary();
    }
    const lastChecked = Number(persist.lastCheckedAtMs || 0);
    if (lastChecked > 0 && now - lastChecked < BANK_SYNC_TTL_MS) {
      return getDetectorBankSummary();
    }
  }

  if (modelDetectorRuntime.bankSyncInFlight) {
    return modelDetectorRuntime.bankSyncInFlight;
  }

  modelDetectorRuntime.lastBankAttemptMs = now;
  modelDetectorRuntime.bankSyncInFlight = (async () => {
    modelDetectorRuntime.isBankSyncing = true;
    try {
      let workingFiles = loadCurrentBankBuffers();
      let workingEngine = engine;
      let hasAnyUpdate = false;
      let mirrorError = '';

      // 通道 1：检查 ModelDial 发布清单（含 modeltrace.json 与 rules.json）
      try {
        const manifestRes = await fetch(`${MODELDIAL_BASE_URL}/asset-manifest.json`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
        if (!manifestRes.ok) {
          throw new Error(`指纹清单请求失败 (HTTP ${manifestRes.status})`);
        }
        const remoteManifest = await manifestRes.json();
        const diff = diffManifestAssets(workingEngine?.manifest || null, remoteManifest);
        if (!diff.valid) {
          throw new Error('远端指纹清单格式校验未通过');
        }

        if (diff.changed.length > 0 || !workingEngine) {
          const mirrorFiles = new Map();
          const seedEntries =
            !workingEngine && existsSync(SEED_BANK_ZIP_FILE)
              ? readZipEntries(readFileSync(SEED_BANK_ZIP_FILE))
              : null;

          for (const rel of REQUIRED_BANK_ASSETS) {
            const expectedSha = remoteManifest.assets[rel].sha256;
            let reuseBuf = null;
            if (!diff.changed.includes(rel)) {
              if (workingFiles?.has(rel)) {
                const b = workingFiles.get(rel);
                if (sha256Hex(b) === expectedSha) reuseBuf = b;
              }
              if (!reuseBuf && seedEntries?.has(rel)) {
                const b = seedEntries.get(rel);
                if (sha256Hex(b) === expectedSha) reuseBuf = b;
              }
            }
            if (reuseBuf) {
              mirrorFiles.set(rel, reuseBuf);
              continue;
            }
            const downloaded = await fetchDetectorAssetBuffer(rel, remoteManifest.assets[rel]);
            const actualSha = sha256Hex(downloaded);
            if (actualSha !== expectedSha) {
              throw new Error(
                `指纹资产哈希不一致 (${rel}: ${actualSha.slice(0, 10)} != ${expectedSha.slice(0, 10)})`
              );
            }
            mirrorFiles.set(rel, downloaded);
          }

          mirrorFiles.set(
            'asset-manifest.json',
            Buffer.from(JSON.stringify(remoteManifest, null, 2), 'utf8')
          );
          const candidateMirrorEngine = buildEngineFromBuffers(mirrorFiles, { source: 'remote' });
          const curBuiltMs = Date.parse(workingEngine?.builtAt || '') || 0;
          const mirBuiltMs = Date.parse(candidateMirrorEngine.builtAt || '') || 0;
          const curCount = Number(workingEngine?.modelCount || 0);
          const mirCount = Number(candidateMirrorEngine.modelCount || 0);

          // 防降级保护：若本地已持有更新的上游主库，仅合并非主库资产（modeltrace / rules），绝不回退主库模型数
          const mirrorIsOlderPrimary =
            Boolean(workingEngine) &&
            (mirBuiltMs < curBuiltMs || (mirBuiltMs === curBuiltMs && mirCount < curCount));

          if (!mirrorIsOlderPrimary) {
            workingFiles = mirrorFiles;
            workingEngine = candidateMirrorEngine;
            hasAnyUpdate = true;
          } else if (workingFiles) {
            const nonPrimaryChanged = diff.changed.filter(
              (rel) => rel !== 'data/detector.bin' && rel !== 'data/primary.json'
            );
            if (nonPrimaryChanged.length > 0) {
              const mergedFiles = new Map(workingFiles);
              const mergedManifest = JSON.parse(
                (workingFiles.get('asset-manifest.json') || Buffer.from('{}')).toString('utf8')
              );
              mergedManifest.assets = { ...(mergedManifest.assets || {}) };
              for (const rel of nonPrimaryChanged) {
                const buf = mirrorFiles.get(rel);
                if (buf) {
                  mergedFiles.set(rel, buf);
                  mergedManifest.assets[rel] = remoteManifest.assets[rel];
                }
              }
              mergedFiles.set(
                'asset-manifest.json',
                Buffer.from(JSON.stringify(mergedManifest, null, 2), 'utf8')
              );
              workingEngine = buildEngineFromBuffers(mergedFiles, { source: 'remote' });
              workingFiles = mergedFiles;
              hasAnyUpdate = true;
            }
          }
        }
      } catch (err) {
        mirrorError = err?.message || String(err);
        if (/哈希不一致|格式校验/.test(mirrorError)) {
          throw err;
        }
      }

      // 通道 2：穿透检查上游权威仓库 Ikaleio/lm-detector 最新主指纹库（解决镜像站滞后问题）
      if (workingFiles) {
        try {
          const ubRes = await fetch(`${LM_DETECTOR_UPSTREAM_BASE_URL}/unified_bank.json`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(14_000),
          });
          if (ubRes && ubRes.ok && typeof ubRes.json === 'function') {
            const ub = await ubRes.json();
            if (ub && Array.isArray(ub.models) && ub.models.length > 0) {
              const upBuiltMs = Date.parse(String(ub.built_at || '')) || 0;
              const curBuiltMs = Date.parse(String(workingEngine?.builtAt || '')) || 0;
              const upCount = ub.models.length;
              const curCount = Number(workingEngine?.modelCount || 0);

              if (!workingEngine || upBuiltMs > curBuiltMs || (upBuiltMs === curBuiltMs && upCount > curCount)) {
                const binRes = await fetch(
                  `${LM_DETECTOR_UPSTREAM_BASE_URL}/shared_detector.bin`,
                  {
                    method: 'GET',
                    signal: AbortSignal.timeout(25_000),
                  }
                );
                if (binRes && binRes.ok && typeof binRes.arrayBuffer === 'function') {
                  const binBuf = Buffer.from(await binRes.arrayBuffer());
                  const primaryObj = buildPrimaryJsonFromUnifiedBank(ub);
                  const primaryBuf = Buffer.from(JSON.stringify(primaryObj, null, 2), 'utf8');

                  const upstreamFiles = new Map(workingFiles);
                  const nextManifest = JSON.parse(
                    (workingFiles.get('asset-manifest.json') || Buffer.from('{"schema":1,"assets":{}}')).toString(
                      'utf8'
                    )
                  );
                  nextManifest.assets = { ...(nextManifest.assets || {}) };
                  nextManifest.assets['data/detector.bin'] = {
                    sha256: sha256Hex(binBuf),
                    bytes: binBuf.length,
                  };
                  nextManifest.assets['data/primary.json'] = {
                    sha256: sha256Hex(primaryBuf),
                    bytes: primaryBuf.length,
                  };
                  upstreamFiles.set('data/detector.bin', binBuf);
                  upstreamFiles.set('data/primary.json', primaryBuf);
                  upstreamFiles.set(
                    'asset-manifest.json',
                    Buffer.from(JSON.stringify(nextManifest, null, 2), 'utf8')
                  );

                  const verifiedUpstreamEngine = buildEngineFromBuffers(upstreamFiles, {
                    source: 'remote',
                  });
                  workingFiles = upstreamFiles;
                  workingEngine = verifiedUpstreamEngine;
                  hasAnyUpdate = true;
                  mirrorError = '';
                }
              }
            }
          }
        } catch {
          // 上游 GitHub 通道网络受限时静默保留当前有效指纹库
        }
      }

      if (!hasAnyUpdate) {
        if (mirrorError && !workingEngine) {
          throw new Error(mirrorError);
        }
        if (mirrorError) {
          saveDetectorPersistState({
            lastCheckedAtMs: Date.now(),
            lastSyncError: mirrorError,
          });
          return {
            ...getDetectorBankSummary(),
            updated: false,
            error: mirrorError,
          };
        }
        saveDetectorPersistState({
          lastCheckedAtMs: Date.now(),
          lastSyncError: '',
          upToDate: true,
        });
        return {
          ...getDetectorBankSummary(),
          updated: false,
          upToDate: true,
        };
      }

      mkdirSync(DETECTOR_BANK_DIR, { recursive: true });
      for (const [rel, buf] of workingFiles.entries()) {
        const target = join(DETECTOR_BANK_DIR, ...rel.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, buf);
      }

      modelDetectorRuntime.engine = workingEngine;
      modelDetectorRuntime.engineError = null;
      const ts = Date.now();
      saveDetectorPersistState({
        lastCheckedAtMs: ts,
        lastUpdatedAtMs: ts,
        lastSyncError: '',
        upToDate: true,
        detectorSha256: workingEngine.detectorSha256,
      });

      return {
        ...getDetectorBankSummary(),
        updated: true,
        upToDate: true,
      };
    } catch (err) {
      const msg = err?.message || '同步指纹库失败';
      saveDetectorPersistState({
        lastCheckedAtMs: Date.now(),
        lastSyncError: msg,
      });
      return {
        ...getDetectorBankSummary(),
        updated: false,
        error: msg,
      };
    } finally {
      modelDetectorRuntime.isBankSyncing = false;
      modelDetectorRuntime.bankSyncInFlight = null;
    }
  })();

  return modelDetectorRuntime.bankSyncInFlight;
}

export function getDetectorBankSummary() {
  const engine = ensureDetectorEngine();
  const persist = loadDetectorPersistState();
  return {
    ready: Boolean(engine),
    source: engine?.source || 'unavailable',
    modelCount: engine?.modelCount || 0,
    builtAt: engine?.builtAt || '',
    detectorSha256: engine?.detectorSha256 ? engine.detectorSha256.slice(0, 12) : '',
    isSyncing: modelDetectorRuntime.isBankSyncing,
    lastCheckedAtMs: Number(persist.lastCheckedAtMs || 0),
    lastUpdatedAtMs: Number(persist.lastUpdatedAtMs || 0),
    lastSyncError: persist.lastSyncError || modelDetectorRuntime.engineError || '',
  };
}

function normalizePickerComparisonText(text) {
  return String(text || '')
    .replace(/[()[\]]/g, ' ')
    .replace(/\b(?:new|fast|notice|beta|preview)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractRemainingPctFromQuotaInfo(quotaInfo, nowMs = Date.now()) {
  if (!quotaInfo || typeof quotaInfo !== 'object') return null;
  if (quotaInfo.disabled === true) return 0;
  if (
    quotaInfo.remainingFraction !== undefined &&
    quotaInfo.remainingFraction !== null &&
    Number.isFinite(Number(quotaInfo.remainingFraction))
  ) {
    const frac = Math.max(0, Math.min(1, Number(quotaInfo.remainingFraction)));
    return Math.round(frac * 100);
  }
  if (typeof quotaInfo.resetTime === 'string' && quotaInfo.resetTime.trim()) {
    const resetMs = Date.parse(quotaInfo.resetTime);
    if (Number.isFinite(resetMs) && resetMs > nowMs) return 0;
  }
  return null;
}

async function getFreshOrCachedCatalogInputs(force = false) {
  const now = Date.now();
  const memo = modelDetectorRuntime.catalogMemo;
  if (!force && memo.userStatus && now - memo.ts < MODEL_CATALOG_CACHE_TTL_MS) {
    return { userStatus: memo.userStatus, summaries: memo.summaries || {} };
  }
  const [usRes, allRes] = await Promise.all([
    callLsRpc('GetUserStatus', {}).catch(() => ({})),
    callLsRpc('GetAllCascadeTrajectories', {}).catch(() => ({})),
  ]);
  const userStatus = usRes?.userStatus || {};
  const summaries = allRes?.trajectorySummaries || {};
  memo.ts = Date.now();
  memo.userStatus = userStatus;
  memo.summaries = summaries;
  return { userStatus, summaries };
}

function extractLatestModelKeyFromTrajectorySteps(steps) {
  if (!Array.isArray(steps)) return '';
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const st = steps[i];
    if (st?.type === 'CORTEX_STEP_TYPE_CHECKPOINT') continue;
    const mk =
      st?.metadata?.generatorModel ||
      st?.metadata?.modelUsage?.model ||
      st?.modelKey ||
      '';
    if (mk && mk !== 'unknown') return String(mk);
  }
  return '';
}

function findTrajectoryCacheCaseInsensitive(cascadeId) {
  if (!cascadeId) return null;
  if (trajectoryCache[cascadeId]) return trajectoryCache[cascadeId];
  const lower = String(cascadeId).toLowerCase();
  for (const [k, v] of Object.entries(trajectoryCache)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function findSummaryCaseInsensitive(summaries, cascadeId) {
  if (!summaries || !cascadeId) return null;
  if (summaries[cascadeId]) return summaries[cascadeId];
  const lower = String(cascadeId).toLowerCase();
  for (const [k, v] of Object.entries(summaries)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * 动态构建反重力可选模型列表，并解析当前窗口正在使用的默认测试模型（严格隔离探针会话）。
 *
 * @param {{
 *   conversationId?: string,
 *   composerModelHint?: string,
 *   force?: boolean
 * }} [options]
 */
export async function resolveAntigravityDetectorCatalog({
  conversationId = '',
  composerModelHint = '',
  force = false,
} = {}) {
  const engine = ensureDetectorEngine();
  const choices = engine?.modelChoices || [];
  const { userStatus, summaries } = await getFreshOrCachedCatalogInputs(force);
  const cmc = userStatus?.cascadeModelConfigData || {};
  const rawConfigs = Array.isArray(cmc.clientModelConfigs) ? cmc.clientModelConfigs : [];
  const sortLabels = [];
  for (const sortItem of Array.isArray(cmc.clientModelSorts) ? cmc.clientModelSorts : []) {
    for (const grp of Array.isArray(sortItem?.groups) ? sortItem.groups : []) {
      for (const lbl of Array.isArray(grp?.modelLabels) ? grp.modelLabels : []) {
        if (lbl && !sortLabels.includes(lbl)) sortLabels.push(lbl);
      }
    }
  }

  const orderIndex = new Map(sortLabels.map((lbl, idx) => [lbl, idx]));
  const sortedConfigs = rawConfigs
    .map((cfg, idx) => ({ cfg, idx }))
    .sort((a, b) => {
      const ia = orderIndex.has(a.cfg?.label) ? orderIndex.get(a.cfg.label) : 1000 + a.idx;
      const ib = orderIndex.has(b.cfg?.label) ? orderIndex.get(b.cfg.label) : 1000 + b.idx;
      return ia - ib;
    })
    .map((x) => x.cfg);

  const availableModels = [];
  const seenModelIds = new Set();
  const nowMs = Date.now();

  for (const cfg of sortedConfigs) {
    const modelId = String(cfg?.modelId || '').trim();
    const rawKey = String(cfg?.modelOrAlias?.model || '').trim();
    const effectiveId = modelId || rawKey;
    if (!effectiveId || seenModelIds.has(effectiveId)) continue;
    seenModelIds.add(effectiveId);

    const label = String(cfg?.label || effectiveId).trim();
    const remainingPct = extractRemainingPctFromQuotaInfo(cfg?.quotaInfo, nowMs);
    const isQuotaExhausted = Boolean(cfg?.disabled) || (remainingPct !== null && remainingPct <= 0);
    const reference = suggestAntigravityReference(effectiveId, choices, label) || 'unknown';

    availableModels.push({
      modelId: effectiveId,
      rawKey,
      label,
      normPickerText: normalizePickerComparisonText(label),
      tagTitle: String(cfg?.tagTitle || '').trim(),
      remainingPct,
      isQuotaExhausted,
      reference,
    });
  }

  const matchByRawOrModelId = (token) => {
    const clean = String(token || '').trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();
    return (
      availableModels.find(
        (m) =>
          (m.rawKey && m.rawKey.toLowerCase() === lower) ||
          m.modelId.toLowerCase() === lower ||
          m.label.toLowerCase() === lower
      ) || null
    );
  };

  let currentWindowModel = null;
  let currentSource = 'fallback';

  // 优先级 1：主窗口输入框模型选择器实时匹配（仅当唯一精确命中单个模型与档位时生效）
  const normHint = normalizePickerComparisonText(composerModelHint);
  if (normHint) {
    const hintMatches = availableModels.filter(
      (m) => m.normPickerText === normHint || m.modelId.toLowerCase() === normHint
    );
    if (hintMatches.length === 1) {
      currentWindowModel = hintMatches[0];
      currentSource = 'window_picker';
    }
  }

  // 优先级 2：当前窗口活跃非探针会话最近一次实际调用的模型
  const safeConvId =
    conversationId && !/[\\/]|\.\./.test(String(conversationId)) ? String(conversationId).trim() : '';
  let targetConvId = safeConvId;
  if (targetConvId) {
    if (modelDetectorRuntime.activeProbeConvIds.has(targetConvId.toLowerCase())) {
      targetConvId = '';
    } else {
      const directSum = findSummaryCaseInsensitive(summaries, targetConvId);
      const cachedEntry = findTrajectoryCacheCaseInsensitive(targetConvId);
      const candidateTitle =
        directSum?.annotations?.title || directSum?.summary || cachedEntry?.title || '';
      if (isModelDetectorProbeTitle(candidateTitle)) {
        targetConvId = '';
      }
    }
  }
  if (!targetConvId) {
    let latestMs = -1;
    for (const [cid, sum] of Object.entries(summaries)) {
      const title = sum?.annotations?.title || sum?.summary || '';
      if (isModelDetectorProbeTitle(title)) continue;
      if (modelDetectorRuntime.activeProbeConvIds.has(String(cid).toLowerCase())) continue;
      if (sum?.trajectoryMetadata?.subagentSpec) continue;
      const ms = Date.parse(sum?.lastModifiedTime || sum?.createdTime || '') || 0;
      if (ms > latestMs) {
        latestMs = ms;
        targetConvId = cid;
      }
    }
  }

  if (!currentWindowModel && targetConvId) {
    const cachedEntry = findTrajectoryCacheCaseInsensitive(targetConvId);
    let convModelKey = '';
    if (cachedEntry?.steps?.length) {
      for (let i = cachedEntry.steps.length - 1; i >= 0; i -= 1) {
        const st = cachedEntry.steps[i];
        if (!st?.isCompactionStep && st?.modelKey && st.modelKey !== 'unknown') {
          convModelKey = st.modelKey;
          break;
        }
      }
    }
    if (!convModelKey) {
      const trajRes = await callLsRpc('GetCascadeTrajectory', { cascadeId: targetConvId }).catch(
        () => null
      );
      const trajTitle =
        trajRes?.trajectory?.annotations?.title || trajRes?.trajectory?.summary || '';
      if (!isModelDetectorProbeTitle(trajTitle)) {
        convModelKey = extractLatestModelKeyFromTrajectorySteps(trajRes?.trajectory?.steps);
      }
    }
    const matchedFromConv = matchByRawOrModelId(convModelKey);
    if (matchedFromConv) {
      currentWindowModel = matchedFromConv;
      currentSource = 'active_conversation';
    }
  }

  // 优先级 3：账号当前默认模型配置 (defaultOverrideModelConfig)
  if (!currentWindowModel) {
    const defaultKey = cmc?.defaultOverrideModelConfig?.modelOrAlias?.model || '';
    const matchedDefault = matchByRawOrModelId(defaultKey);
    if (matchedDefault) {
      currentWindowModel = matchedDefault;
      currentSource = 'account_default';
    }
  }

  if (!currentWindowModel && availableModels.length > 0) {
    currentWindowModel = availableModels[0];
    currentSource = 'catalog_first';
  }

  const cleanModels = availableModels.map(({ normPickerText: _unused, ...rest }) => rest);
  const cleanCurrent = currentWindowModel
    ? {
        modelId: currentWindowModel.modelId,
        rawKey: currentWindowModel.rawKey,
        label: currentWindowModel.label,
        reference: currentWindowModel.reference,
        remainingPct: currentWindowModel.remainingPct,
        isQuotaExhausted: currentWindowModel.isQuotaExhausted,
        source: currentSource,
      }
    : null;

  return {
    availableModels: cleanModels,
    currentWindowModel: cleanCurrent,
    userStatus,
    summaries,
    targetConvId,
  };
}

export function resolveAgentApiBinary(options = {}) {
  const env = options.env || process.env || {};
  const platform = options.platform || process.platform;
  const home = options.homeDir || homedir();
  const envExe = String(env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();
  if (envExe) {
    return { cmd: envExe, prefixArgs: ['agentapi'] };
  }

  const desktopApp = resolveAntigravityDesktopAppPath({
    platform,
    desktopAppPath: options.desktopAppPath,
  });
  if (desktopApp) {
    const binDir =
      platform === 'darwin' || desktopApp.toLowerCase().endsWith('.app')
        ? join(desktopApp, 'Contents', 'Resources', 'bin')
        : join(desktopApp, 'resources', 'bin');
    const names =
      platform === 'win32'
        ? ['language_server.exe']
        : ['language_server', 'language_server_macos_arm', 'language_server_macos_x64'];
    for (const name of names) {
      const cand = join(binDir, name);
      if (existsSync(cand)) {
        return { cmd: cand, prefixArgs: ['agentapi'] };
      }
    }
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const winCandidates = [
      join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
      join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    ];
    for (const cand of winCandidates) {
      if (existsSync(cand)) {
        return { cmd: cand, prefixArgs: ['agentapi'] };
      }
    }
  } else if (platform === 'darwin') {
    const macApps = ['/Applications/Antigravity.app', join(home, 'Applications', 'Antigravity.app')];
    for (const app of macApps) {
      for (const name of ['language_server', 'language_server_macos_arm', 'language_server_macos_x64']) {
        const cand = join(app, 'Contents', 'Resources', 'bin', name);
        if (existsSync(cand)) {
          return { cmd: cand, prefixArgs: ['agentapi'] };
        }
      }
    }
  } else {
    for (const dir of ['/opt/Antigravity', '/usr/lib/antigravity', '/usr/share/antigravity']) {
      const cand = join(dir, 'resources', 'bin', 'language_server');
      if (existsSync(cand)) {
        return { cmd: cand, prefixArgs: ['agentapi'] };
      }
    }
  }

  const agyCli = resolveStandaloneAgyExecutable({ agyExecutablePath: options.agyExecutablePath });
  if (agyCli) {
    return { cmd: agyCli, prefixArgs: ['agentapi'] };
  }
  return { cmd: 'agentapi', prefixArgs: [] };
}

function execDetectorAgentApi(subArgs, { projectId } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof execFile !== 'function') {
      reject(new Error('当前运行环境不支持子进程调用'));
      return;
    }
    const { cmd, prefixArgs } = resolveAgentApiBinary();
    const env = { ...(process.env || {}) };
    if (projectId !== undefined) {
      if (projectId) {
        env.ANTIGRAVITY_PROJECT_ID = projectId;
      } else {
        delete env.ANTIGRAVITY_PROJECT_ID;
      }
    }
    execFile(
      cmd,
      [...prefixArgs, ...subArgs],
      {
        windowsHide: true,
        timeout: 25_000,
        maxBuffer: 4 * 1024 * 1024,
        env,
      },
      (err, stdout, stderr) => {
        const outText = String(stdout || '').trim();
        if (outText) {
          try {
            const parsed = JSON.parse(outText);
            resolve(parsed);
            return;
          } catch {
            // 非 JSON 输出按标准错误处理
          }
        }
        if (err) {
          const detail = String(stderr || stdout || err.message || '').trim();
          reject(new Error(detail || err.message));
          return;
        }
        resolve({});
      }
    );
  });
}

function buildProbeNewConversationArgs({ modelId, title, prompt, useProfile = true }) {
  const args = ['new-conversation', `--model=${modelId}`];
  if (useProfile && MODEL_DETECTOR_PROBE_PROFILE) {
    args.push(`--profile=${MODEL_DETECTOR_PROBE_PROFILE}`);
  }
  args.push(`--title=${title}`, prompt);
  return args;
}

async function startSingleProbeConversation({
  modelId,
  title,
  prompt,
  initialProjectId = '',
  fallbackProjectId = '',
}) {
  const attemptSpawn = async (projectId, useProfile) => {
    const args = buildProbeNewConversationArgs({ modelId, title, prompt, useProfile });
    try {
      const res = await execDetectorAgentApi(args, {
        projectId: projectId !== undefined ? projectId : undefined,
      });
      return { res, errText: String(res?.error || '') };
    } catch (err) {
      return { res: null, errText: String(err?.message || err || '') };
    }
  };

  let activeProj = initialProjectId;
  let useProfile = true;

  let { res, errText } = await attemptSpawn(activeProj, useProfile);
  let convId = String(res?.response?.newConversation?.conversationId || '').trim();
  if (convId) return convId;

  // 若旧版宿主尚未发现极简代理 profile，自动无感降级回默认 profile 重试
  if (/profile|agent.*not\s*found|unknown\s*agent/i.test(errText)) {
    useProfile = false;
    ({ res, errText } = await attemptSpawn(activeProj, false));
    convId = String(res?.response?.newConversation?.conversationId || '').trim();
    if (convId) return convId;
  }

  // 自动修复 source project_id 与 target project_id 不匹配错误并缓存治愈后的 projectId
  const mismatch = errText.match(/source project_id "([^"]*)" does not match target project_id/i);
  if (mismatch) {
    const requiredProjId = mismatch[1];
    modelDetectorRuntime.healedProjectId = requiredProjId;
    activeProj = requiredProjId;
    ({ res, errText } = await attemptSpawn(activeProj, useProfile));
    convId = String(res?.response?.newConversation?.conversationId || '').trim();
    if (convId) return convId;
    if (useProfile && /profile|agent.*not\s*found|unknown\s*agent/i.test(errText)) {
      ({ res, errText } = await attemptSpawn(activeProj, false));
      convId = String(res?.response?.newConversation?.conversationId || '').trim();
      if (convId) return convId;
    }
  } else if (!activeProj && fallbackProjectId) {
    ({ res, errText } = await attemptSpawn(fallbackProjectId, useProfile));
    convId = String(res?.response?.newConversation?.conversationId || '').trim();
    if (convId) return convId;
  }

  throw new Error(errText || '启动探针会话未返回会话 ID');
}

function readTranscriptProgressAndReply(probeConvId) {
  if (!BRAIN_DIR || !probeConvId) return { diskSize: 0, text: '' };
  const transcriptPath = join(
    BRAIN_DIR,
    probeConvId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  if (!existsSync(transcriptPath)) return { diskSize: 0, text: '' };
  let diskSize = 0;
  try {
    diskSize = Number(statSync(transcriptPath)?.size || 0);
  } catch {
    diskSize = 0;
  }
  try {
    const lines = readFileSync(transcriptPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    const doneChunks = [];
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj?.type === 'PLANNER_RESPONSE' && obj?.status === 'DONE' && obj?.content) {
        doneChunks.push(String(obj.content).trim());
      }
    }
    return {
      diskSize,
      text: doneChunks.filter(Boolean).join('\n'),
    };
  } catch {
    return { diskSize, text: '' };
  }
}

function createAbortToken(parentToken = null) {
  const token = {
    cancelled: Boolean(parentToken?.cancelled),
    wakers: new Set(),
    abort() {
      if (token.cancelled) return;
      token.cancelled = true;
      for (const wake of [...token.wakers]) {
        try {
          wake();
        } catch {
          // 忽略单个唤醒回调异常
        }
      }
      token.wakers.clear();
    },
  };
  if (parentToken && !parentToken.cancelled) {
    parentToken.wakers.add(() => token.abort());
  }
  return token;
}

function sleepAbortable(ms, abortToken) {
  return new Promise((resolve) => {
    if (abortToken?.cancelled) {
      resolve();
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      abortToken?.wakers?.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    abortToken?.wakers?.add(wake);
  });
}

/**
 * 带流式活性自适应续期的探针响应等待器：
 * - 当模型正在生成思维链或输出整数时自动延长租约（最高 240s），彻底杜绝正常生成中途误判超时；
 * - 实时回调当前思考字符量与已解析整数个数，驱动前端平滑进度展示；
 * - 兼容 `empty_output_continuation_check` 续写钩子，避免在空输出首步提前误判完成。
 */
async function waitForProbeConversationReply(
  probeConvId,
  expectedCount,
  abortToken,
  onProgress = null
) {
  const startMs = Date.now();
  let deadline = startMs + PROBE_INITIAL_TIMEOUT_MS;
  const minAccepted = Math.max(80, Math.ceil((expectedCount || 300) * 0.55));
  let lastActivitySig = '';
  let shortDoneSettlePolls = 0;

  while (Date.now() < deadline) {
    if (abortToken?.cancelled) {
      throw new Error('检测已取消');
    }

    const trajRes = await callLsRpc('GetCascadeTrajectory', { cascadeId: probeConvId }).catch(
      () => null
    );
    const steps = Array.isArray(trajRes?.trajectory?.steps) ? trajRes.trajectory.steps : [];
    const trajStatus = String(trajRes?.trajectory?.status || '');
    const doneResponses = [];
    const liveResponses = [];
    let actualModelKey = '';
    let thinkingMeasure = 0;
    let hasActiveStep = trajStatus === 'CORTEX_STEP_STATUS_RUNNING' || trajStatus === 'CASCADE_RUN_STATUS_RUNNING';

    for (const st of steps) {
      const genModel = st?.metadata?.generatorModel || st?.metadata?.modelUsage?.model || '';
      if (genModel) actualModelKey = String(genModel);

      const thinkStr = String(st?.plannerResponse?.thinking || '');
      const thinkToks = Number(st?.metadata?.modelUsage?.thinkingOutputTokens || 0);
      thinkingMeasure += thinkStr.length + thinkToks;

      const txt = String(
        st?.plannerResponse?.modifiedResponse ?? st?.plannerResponse?.response ?? ''
      ).trim();
      if (txt) {
        liveResponses.push(txt);
      }

      const stStatus = String(st?.status || '');
      if (st?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
        if (stStatus === 'CORTEX_STEP_STATUS_DONE') {
          if (txt) doneResponses.push(txt);
        } else if (
          stStatus &&
          stStatus !== 'CORTEX_STEP_STATUS_ERROR' &&
          stStatus !== 'CORTEX_STEP_STATUS_CANCELED'
        ) {
          hasActiveStep = true;
        }
      } else if (
        stStatus === 'CORTEX_STEP_STATUS_RUNNING' ||
        stStatus === 'CORTEX_STEP_STATUS_GENERATING' ||
        stStatus === 'CORTEX_STEP_STATUS_PENDING'
      ) {
        hasActiveStep = true;
      }

      if (stStatus === 'CORTEX_STEP_STATUS_ERROR' || stStatus === 'CORTEX_STEP_STATUS_CANCELED') {
        const errTxt = st?.error?.message || st?.metadata?.error || '模型响应中断或报错';
        throw new Error(String(errTxt));
      }
    }

    const diskInfo = readTranscriptProgressAndReply(probeConvId);
    const liveJoined = liveResponses.join('\n') || diskInfo.text;
    const liveParsedCount = liveJoined ? parseNumbers(liveJoined).length : 0;

    const activitySig = `${steps.length}:${thinkingMeasure}:${liveJoined.length}:${diskInfo.diskSize}`;
    if (lastActivitySig && activitySig !== lastActivitySig) {
      deadline = Math.min(
        startMs + PROBE_MAX_WALL_MS,
        Math.max(deadline, Date.now() + PROBE_ACTIVE_EXTENSION_MS)
      );
    }
    lastActivitySig = activitySig;

    if (typeof onProgress === 'function') {
      const phase =
        liveParsedCount > 0
          ? 'streaming'
          : thinkingMeasure > 0 || steps.length >= 2
            ? 'thinking'
            : 'queued';
      onProgress({
        phase,
        parsedNumbers: liveParsedCount,
        thinkingMeasure,
      });
    }

    const effectiveDoneText = doneResponses.join('\n') || (!hasActiveStep ? diskInfo.text : '');
    if (effectiveDoneText) {
      const doneParsedCount = parseNumbers(effectiveDoneText).length;
      if (doneParsedCount >= minAccepted) {
        onProgress?.({
          phase: 'done',
          parsedNumbers: doneParsedCount,
          thinkingMeasure,
        });
        return {
          text: effectiveDoneText,
          actualModelKey,
          parsedNumbers: doneParsedCount,
        };
      }
      if (!hasActiveStep) {
        shortDoneSettlePolls += 1;
        if (shortDoneSettlePolls >= 3 && doneParsedCount > 0) {
          return {
            text: effectiveDoneText,
            actualModelKey,
            parsedNumbers: doneParsedCount,
          };
        }
      } else {
        shortDoneSettlePolls = 0;
      }
    } else {
      shortDoneSettlePolls = 0;
    }

    await sleepAbortable(PROBE_POLL_INTERVAL_MS, abortToken);
  }

  throw new Error('等待模型探针响应超时（可能触发了上游排队限流或配额耗尽）');
}

/**
 * 归档已完成探针的 Token 账本至 `trajectoryCache`，随后停止并清理宿主临时探针会话，
 * 确保侧边栏零残留且本机用量统计 100% 准确。
 *
 * @param {string[]} probeConvIds
 * @param {{ archiveUsage?: boolean, cancelRunning?: boolean, accountName?: string }} [options]
 */
async function cleanupProbeConversations(
  probeConvIds,
  { archiveUsage = false, cancelRunning = false, accountName = '' } = {}
) {
  const uniqueIds = [...new Set((probeConvIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!uniqueIds.length || !LS_ADDR) return;

  if (cancelRunning) {
    await Promise.all(
      uniqueIds.map((cid) =>
        callLsRpc('CancelCascadeInvocation', { cascadeId: cid }, 3500).catch(() => null)
      )
    );
  }

  if (archiveUsage) {
    try {
      let cacheUpdated = false;
      await Promise.all(
        uniqueIds.map(async (cid) => {
          const trajRes = await callLsRpc('GetCascadeTrajectory', { cascadeId: cid }, 4000).catch(
            () => null
          );
          const rawSteps = trajRes?.trajectory?.steps;
          if (!Array.isArray(rawSteps) || rawSteps.length === 0) return;
          const steps = extractModelSteps(rawSteps, trajRes?.trajectory?.generatorMetadata || []);
          if (!steps.length) return;
          const lowerKey = cid.toLowerCase();
          const lastStepMs = steps[steps.length - 1]?.createdAtMs || Date.now();
          trajectoryCache[lowerKey] = {
            signature: `${CACHE_SCHEMA_VERSION}:disk:${Math.floor(lastStepMs)}`,
            accountName: accountName || '',
            title: `${MODEL_DETECTOR_PROBE_TITLE_PREFIX} archived`,
            lastModifiedMs: lastStepMs,
            diskMtimeMs: 0,
            wasRunning: false,
            steps,
            subagentRefs: [],
          };
          cacheUpdated = true;
        })
      );
      if (cacheUpdated) {
        saveJson(CACHE_FILE, trajectoryCache);
      }
    } catch {
      // 忽略归档异常，继续执行清理避免残留
    }
  }

  await Promise.all(
    uniqueIds.map((cid) =>
      callLsRpc('DeleteCascadeTrajectory', { cascadeId: cid }, 4000).catch(() => null)
    )
  );
  modelDetectorRuntime.catalogMemo.ts = 0;
}

function resolveFallbackProjectIdFromSummaries(conversationId, summaries = {}) {
  if (conversationId) {
    const directSum = findSummaryCaseInsensitive(summaries, conversationId);
    const sumProj = String(directSum?.trajectoryMetadata?.projectId || '').trim();
    if (sumProj) return sumProj;
  }
  let bestProj = '';
  let bestMs = -1;
  for (const sum of Object.values(summaries || {})) {
    const proj = String(sum?.trajectoryMetadata?.projectId || '').trim();
    if (!proj) continue;
    const ms = Date.parse(sum?.lastModifiedTime || sum?.createdTime || '') || 0;
    if (ms > bestMs) {
      bestMs = ms;
      bestProj = proj;
    }
  }
  return bestProj;
}

function formatLiveDetectorPhaseText(jobState, perProbeProgress) {
  const completed = Number(jobState.completedProbes || 0);
  const total = Math.max(1, Number(jobState.totalProbes || 3));
  const totalParsed = perProbeProgress.reduce((sum, p) => sum + Number(p?.parsedNumbers || 0), 0);
  const streamingCount = perProbeProgress.filter((p) => p?.phase === 'streaming').length;
  const thinkingCount = perProbeProgress.filter((p) => p?.phase === 'thinking').length;

  if (completed >= total) {
    return '3/3 采样完成，正在计算双引擎数字指纹…';
  }
  if (completed > 0) {
    if (totalParsed > completed * 250) {
      return `已完成 ${completed}/${total} 路采样 · 实时捕获 ${totalParsed} 个整数…`;
    }
    if (thinkingCount > 0) {
      return `已完成 ${completed}/${total} 路采样 · 其余探针思考中…`;
    }
    return `已完成 ${completed}/${total} 路采样，等待其余探针…`;
  }
  if (streamingCount > 0 || totalParsed > 0) {
    return `探针高速输出中 · 已捕获 ${totalParsed} 个整数 (0/${total})…`;
  }
  if (thinkingCount > 0) {
    return jobState.fastTierRouted
      ? `同权轻思考探针已连接，正在生成序列 (0/${total})…`
      : `模型深度思考中，已自动续期守护 (0/${total})…`;
  }
  return jobState.fastTierRouted
    ? `已投递同权轻思考探针，等待模型首字响应 (0/${total})…`
    : `探针已投递，等待 ${jobState.targetLabel} 响应 (0/${total})…`;
}

/**
 * 读取模型检测面板的完整实时快照（指纹库状态 + 反重力可用模型 + 当前窗口模型 + 运行进度 + 最近结果与历史）。
 */
export async function getModelDetectorStatus(query = {}) {
  const force = query?.force === '1' || query?.force === true;
  if (LS_ADDR && LS_ADDR !== 'test.invalid' && !force) {
    syncDetectorBank({ force: false }).catch(() => {});
  }
  const bank = getDetectorBankSummary();
  const { availableModels, currentWindowModel } = await resolveAntigravityDetectorCatalog({
    conversationId: String(query?.conversationId || ''),
    composerModelHint: String(query?.composerModelHint || ''),
    force,
  });
  const history = loadDetectorHistory();
  const running = modelDetectorRuntime.runningJob
    ? {
        ...modelDetectorRuntime.runningJob,
        elapsedMs: Math.max(0, Date.now() - modelDetectorRuntime.runningJob.startedAtMs),
      }
    : null;

  return {
    ok: true,
    bank,
    availableModels,
    currentWindowModel,
    running,
    latestResult: history[0] || null,
    history: history.slice(0, 5),
  };
}

/**
 * 启动异步模型真身检测任务（立即返回，前端轮询 `/api/model-detector/status` 获取实时进度与最终结论）。
 */
export async function startAntigravityModelDetection(payload = {}) {
  if (modelDetectorRuntime.runningJob?.active) {
    return {
      ok: true,
      alreadyRunning: true,
      status: await getModelDetectorStatus(payload),
    };
  }

  const engine = ensureDetectorEngine();
  if (!engine) {
    return {
      ok: false,
      statusHttp: 500,
      error: modelDetectorRuntime.engineError || '本地数字指纹库未就绪',
    };
  }

  const conversationId = String(payload?.conversationId || '').trim();
  const composerModelHint = String(payload?.composerModelHint || '').trim();
  const requestedId = String(payload?.modelId || CURRENT_WINDOW_MODEL_SENTINEL).trim();
  const probeMode = normalizeDetectorProbeMode(payload?.probeMode);

  const { availableModels, currentWindowModel, userStatus, summaries, targetConvId } =
    await resolveAntigravityDetectorCatalog({
      conversationId,
      composerModelHint,
      force: true,
    });

  if (!availableModels.length) {
    return {
      ok: false,
      statusHttp: 503,
      error: '暂未从反重力宿主获取到可用模型列表，请稍后点击同步重试',
    };
  }

  const useCurrentDefault = !requestedId || requestedId === CURRENT_WINDOW_MODEL_SENTINEL;
  const targetModel = useCurrentDefault
    ? availableModels.find((m) => m.modelId === currentWindowModel?.modelId) || availableModels[0]
    : availableModels.find((m) => m.modelId === requestedId) || null;

  if (!targetModel) {
    return {
      ok: false,
      statusHttp: 400,
      error: '仅允许选择反重力环境下当前可用的模型进行检测',
    };
  }

  const { executionModel, fastTierRouted } = resolveProbeExecutionModel(
    targetModel,
    availableModels,
    probeMode
  );

  const envProj = String(process.env.ANTIGRAVITY_PROJECT_ID || '').trim();
  const initialProjectId = envProj || modelDetectorRuntime.healedProjectId || '';
  const fallbackProjectId = resolveFallbackProjectIdFromSummaries(
    conversationId || targetConvId,
    summaries
  );
  const accountName = String(userStatus?.email || userStatus?.name || '').trim();

  const challengeSet = generateChallengeSet();
  const totalProbes = challengeSet.questions.length;
  const expectedTotalNumbers = challengeSet.questions.reduce(
    (sum, q) => sum + Number(q.expected_count || 300),
    0
  );
  const runId = `md_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const cancelToken = createAbortToken();
  const spawnedConvIds = [];

  const jobState = {
    runId,
    active: true,
    probeMode,
    fastTierRouted,
    targetModelId: targetModel.modelId,
    targetLabel: targetModel.label,
    executionModelId: executionModel.modelId,
    executionLabel: executionModel.label,
    targetReference: targetModel.reference,
    usedCurrentWindowDefault: useCurrentDefault,
    completedProbes: 0,
    totalProbes,
    liveParsedNumbers: 0,
    expectedTotalNumbers,
    activeThinkingProbes: 0,
    startedAtMs: Date.now(),
    phaseText: fastTierRouted
      ? `正在通过同权轻思考通道启动 3 路极速探针…`
      : '正在并发启动 3 路无语义整数探针…',
    lastError: '',
  };

  modelDetectorRuntime.runningJob = jobState;
  modelDetectorRuntime.cancelToken = cancelToken;

  // 后台异步并发采样、多数派容错结算、账本归档与探针自动清理
  void (async () => {
    const perProbeProgress = challengeSet.questions.map(() => ({
      phase: 'spawning',
      parsedNumbers: 0,
      thinkingMeasure: 0,
    }));
    const perProbeTokens = challengeSet.questions.map(() => createAbortToken(cancelToken));
    let stragglerTimer = null;
    let stragglerExtended = false;

    const syncLiveJobProgress = () => {
      if (modelDetectorRuntime.runningJob?.runId !== runId) return;
      jobState.liveParsedNumbers = perProbeProgress.reduce(
        (sum, p) => sum + Number(p?.parsedNumbers || 0),
        0
      );
      jobState.activeThinkingProbes = perProbeProgress.filter(
        (p) => p?.phase === 'thinking' || p?.phase === 'streaming'
      ).length;
      jobState.phaseText = formatLiveDetectorPhaseText(jobState, perProbeProgress);
    };

    const maybeArmStragglerGrace = (settledFlags) => {
      if (stragglerTimer || cancelToken.cancelled) return;
      const doneValidCount = settledFlags.filter((s) => s === 'ok').length;
      const pendingIndices = settledFlags
        .map((s, idx) => (s === 'pending' ? idx : -1))
        .filter((idx) => idx >= 0);
      if (doneValidCount < 2 || pendingIndices.length !== 1) return;

      const stragglerIdx = pendingIndices[0];
      const onGraceFire = () => {
        stragglerTimer = null;
        if (settledFlags[stragglerIdx] !== 'pending' || cancelToken.cancelled) return;
        if (!stragglerExtended && perProbeProgress[stragglerIdx]?.phase === 'streaming') {
          stragglerExtended = true;
          stragglerTimer = setTimeout(onGraceFire, 18_000);
          return;
        }
        perProbeTokens[stragglerIdx].abort();
      };
      stragglerTimer = setTimeout(onGraceFire, PROBE_STRAGGLER_GRACE_MS);
    };

    const settledFlags = challengeSet.questions.map(() => 'pending');

    try {
      const probeOutcomes = await Promise.all(
        challengeSet.questions.map(async (q, idx) => {
          const probeTitle = `${MODEL_DETECTOR_PROBE_TITLE_PREFIX} ${executionModel.label} #${idx + 1}`;
          let probeConvId = '';
          try {
            probeConvId = await startSingleProbeConversation({
              modelId: executionModel.modelId,
              title: probeTitle,
              prompt: q.prompt,
              initialProjectId: modelDetectorRuntime.healedProjectId || initialProjectId,
              fallbackProjectId,
            });
            spawnedConvIds.push(probeConvId);
            modelDetectorRuntime.activeProbeConvIds.add(probeConvId.toLowerCase());
            perProbeProgress[idx].phase = 'queued';
            syncLiveJobProgress();

            const reply = await waitForProbeConversationReply(
              probeConvId,
              q.expected_count,
              perProbeTokens[idx],
              (prog) => {
                perProbeProgress[idx] = prog;
                syncLiveJobProgress();
              }
            );

            settledFlags[idx] = 'ok';
            if (modelDetectorRuntime.runningJob?.runId === runId) {
              jobState.completedProbes += 1;
              syncLiveJobProgress();
            }
            maybeArmStragglerGrace(settledFlags);

            return {
              ok: true,
              index: idx,
              probeConvId,
              text: reply.text,
              actualModelKey: reply.actualModelKey,
            };
          } catch (err) {
            settledFlags[idx] = 'failed';
            return {
              ok: false,
              index: idx,
              probeConvId,
              text: '',
              actualModelKey: '',
              error: err?.message || String(err),
            };
          }
        })
      );

      if (stragglerTimer) {
        clearTimeout(stragglerTimer);
        stragglerTimer = null;
      }

      if (cancelToken.cancelled) return;

      probeOutcomes.sort((a, b) => a.index - b.index);
      const succeededOutcomes = probeOutcomes.filter((r) => r.ok && r.text);
      if (succeededOutcomes.length === 0) {
        const firstErr =
          probeOutcomes.find((r) => r.error)?.error || '探针未返回有效整数序列，请稍后重试';
        throw new Error(firstErr);
      }

      const unfinishedIds = probeOutcomes
        .filter((r) => !r.ok && r.probeConvId)
        .map((r) => r.probeConvId);
      if (unfinishedIds.length > 0) {
        await cleanupProbeConversations(unfinishedIds, {
          archiveUsage: false,
          cancelRunning: true,
        });
      }

      const replies = probeOutcomes.map((r) => (r.ok ? r.text : ''));
      const latestEngine = ensureDetectorEngine() || engine;
      const diagnosis = buildFullDiagnosis({
        replies,
        claimed: targetModel.modelId,
        claimedLabel: targetModel.label,
        seed: challengeSet.challenge.seed,
        schema: challengeSet.challenge.schema,
        questions: challengeSet.questions,
        engine: latestEngine,
      });

      if (diagnosis.usedOutputs === 0 && succeededOutcomes.length < 2) {
        const partialErr = probeOutcomes.find((r) => r.error)?.error;
        if (partialErr) throw new Error(partialErr);
      }

      // 检查宿主是否因为该模型配额耗尽/不可用而静默回退至其他基础模型（如 Flash）
      const observedRawKey =
        probeOutcomes.map((r) => r.actualModelKey).find((k) => Boolean(k)) || '';
      const actualCatalogModel = observedRawKey
        ? availableModels.find(
            (m) =>
              (m.rawKey && m.rawKey === observedRawKey) || m.modelId === observedRawKey
          ) || null
        : null;

      const expectedRawKeys = new Set(
        [executionModel.rawKey, targetModel.rawKey].filter(Boolean)
      );
      const targetBaseInfo = extractTieredModelBase(targetModel.modelId);
      if (targetBaseInfo) {
        for (const m of availableModels) {
          if (extractTieredModelBase(m.modelId)?.base === targetBaseInfo.base && m.rawKey) {
            expectedRawKeys.add(m.rawKey);
          }
        }
      }
      const hostFallbackOccurred = Boolean(
        expectedRawKeys.size > 0 && observedRawKey && !expectedRawKeys.has(observedRawKey)
      );

      let finalSummary = diagnosis.summary;
      let hostFallback = null;
      if (hostFallbackOccurred) {
        const actualLabel = actualCatalogModel?.label || observedRawKey;
        hostFallback = {
          occurred: true,
          requestedLabel: targetModel.label,
          actualLabel,
          actualModelId: actualCatalogModel?.modelId || observedRawKey,
        };
        finalSummary = {
          badge: '宿主回退',
          tone: 'warn',
          headline: `宿主实际回退以 ${actualLabel} 执行（指纹最接近 ${diagnosis.topCandidates[0]?.label || '未知'}）`,
          detail: `所选「${targetModel.label}」当前不可用或额度已耗尽，反重力自动降级至 ${actualLabel} 响应。`,
        };
      }

      const record = {
        id: runId,
        ok: true,
        createdAt: diagnosis.createdAt,
        elapsedMs: Math.max(0, Date.now() - jobState.startedAtMs),
        probeMode,
        fastTierRouted,
        targetModelId: targetModel.modelId,
        targetLabel: targetModel.label,
        executionModelId: executionModel.modelId,
        executionLabel: executionModel.label,
        usedCurrentWindowDefault: useCurrentDefault,
        reference: diagnosis.reference,
        verdictState: hostFallbackOccurred
          ? 'fallback'
          : diagnosis.displayVerdict?.state || 'unset',
        summary: finalSummary,
        hostFallback,
        topCandidates: diagnosis.topCandidates.slice(0, 4),
        totalNumbers: diagnosis.totalNumbers,
        usedOutputs: diagnosis.usedOutputs,
        bankBuiltAt: latestEngine.builtAt,
        detectorSha256: latestEngine.detectorSha256.slice(0, 12),
      };

      prependDetectorHistory(record);

      // 归档探针 Token 消耗后清理临时探针会话，保持侧边栏干净无残留
      await cleanupProbeConversations(spawnedConvIds, {
        archiveUsage: true,
        cancelRunning: false,
        accountName,
      });
    } catch (err) {
      if (stragglerTimer) {
        clearTimeout(stragglerTimer);
        stragglerTimer = null;
      }
      if (!cancelToken.cancelled) {
        const failRecord = {
          id: runId,
          ok: false,
          createdAt: new Date().toISOString(),
          elapsedMs: Math.max(0, Date.now() - jobState.startedAtMs),
          probeMode,
          fastTierRouted,
          targetModelId: targetModel.modelId,
          targetLabel: targetModel.label,
          executionModelId: executionModel.modelId,
          executionLabel: executionModel.label,
          usedCurrentWindowDefault: useCurrentDefault,
          reference: targetModel.reference,
          verdictState: 'error',
          summary: {
            badge: '检测失败',
            tone: 'bad',
            headline: `${targetModel.label} 探针采样未完成`,
            detail: err?.message || '探针请求异常，请检查模型额度后重试。',
          },
          hostFallback: null,
          topCandidates: [],
          totalNumbers: 0,
          usedOutputs: 0,
          bankBuiltAt: engine.builtAt,
          detectorSha256: engine.detectorSha256.slice(0, 12),
        };
        prependDetectorHistory(failRecord);
      }
      await cleanupProbeConversations(spawnedConvIds, {
        archiveUsage: false,
        cancelRunning: true,
      });
    } finally {
      for (const cid of spawnedConvIds) {
        modelDetectorRuntime.activeProbeConvIds.delete(String(cid).toLowerCase());
      }
      if (modelDetectorRuntime.runningJob?.runId === runId) {
        modelDetectorRuntime.runningJob = null;
        modelDetectorRuntime.cancelToken = null;
      }
    }
  })();

  return {
    ok: true,
    started: true,
    runId,
    status: await getModelDetectorStatus({ conversationId, composerModelHint }),
  };
}

export async function cancelAntigravityModelDetection(query = {}) {
  const token = modelDetectorRuntime.cancelToken;
  const activeIds = [...modelDetectorRuntime.activeProbeConvIds];
  if (token) {
    token.abort();
  }
  modelDetectorRuntime.runningJob = null;
  modelDetectorRuntime.cancelToken = null;
  modelDetectorRuntime.activeProbeConvIds.clear();

  if (activeIds.length > 0) {
    void cleanupProbeConversations(activeIds, {
      archiveUsage: false,
      cancelRunning: true,
    });
  }

  return {
    ok: true,
    cancelled: Boolean(token),
    status: await getModelDetectorStatus(query),
  };
}
