import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import * as metrics from '../speed-metrics.mjs';
import { stripModuleSyntax } from '../scripts/build-bundle.mjs';

const REAL_CATALOG_RAW = JSON.parse(
  fs.readFileSync(new URL('../../../pricing-catalog.json', import.meta.url), 'utf8')
);
const REAL_SEED_BANK_ZIP = fs.readFileSync(
  new URL('../vendor/seed-bank.zip', import.meta.url)
);
const DEFAULT_BUNDLED_CATALOG = {
  schemaVersion: 1,
  pricing: REAL_CATALOG_RAW.pricing,
  placeholders: REAL_CATALOG_RAW.placeholders,
};

const BACKEND_MODULE_FILES = [
  '../backend/config.mjs',
  '../backend/pricing-catalog.mjs',
  '../backend/plugin-updater.mjs',
  '../backend/ls-rpc.mjs',
  '../backend/model-pricing.mjs',
  '../backend/quota-pools.mjs',
  '../backend/local-scanner.mjs',
  '../backend/usage-aggregator.mjs',
  '../backend/context-window-manager.mjs',
  '../backend/inference-health.mjs',
  '../backend/telemetry-builder.mjs',
  '../backend/model-detector-core.mjs',
  '../backend/model-detector.mjs',
  '../backend/window-bridge.mjs',
  '../main.mjs',
];

function loadCombinedBackendSource() {
  return BACKEND_MODULE_FILES.map((relPath) =>
    fs.readFileSync(new URL(relPath, import.meta.url), 'utf8')
  ).join('\n');
}

function stripEsmSyntax(rawSource, mainUrl) {
  return stripModuleSyntax(rawSource).replaceAll('import.meta.url', JSON.stringify(mainUrl));
}

export function backendHarness({
  cache={},
  deepStats=null,
  transcripts={},
  settings={},
  trajectories={},
  summaries={},
  userStatus={},
  quotaSummary={groups:[]},
  localCatalog=DEFAULT_BUNDLED_CATALOG,
  remoteCatalog=null,
  pluginManifest=null,
  hasGitDir=false,
  pluginRootPath=null,
  remoteFetch=null,
  execFileImpl=null,
  seedBankZip=REAL_SEED_BANK_ZIP,
  sourceText=null,
  metricsImplementation=metrics,
}={}) {
  const mainUrl = pluginRootPath ? `file://${pluginRootPath}/sidecars/panel/main.mjs` : 'file:///test/sidecars/panel/main.mjs';
  const mainPath = pluginRootPath ? `${pluginRootPath}/sidecars/panel/main.mjs` : '/test/sidecars/panel/main.mjs';
  const source = stripEsmSyntax(sourceText ?? loadCombinedBackendSource(), mainUrl);
  const state={calls:[],errors:[],saves:[],virtualFiles:new Map(),virtualMtimes:new Map(),virtualTick:10,trajectories,summaries,transcripts,transcriptMtimeMs:1,userStatus,quotaSummary,localCatalog,remoteCatalog,pluginManifest,hasGitDir,deepStats,deepStatsMtimeMs:1};
  const touchVirtual=(norm)=>{const t=++state.virtualTick;state.virtualMtimes.set(norm,t);return t;};
  const ctx={
    ...metricsImplementation, URL, AbortSignal, Buffer, crypto, zlib, setTimeout, clearTimeout, DataView, Float32Array, Uint8Array,
    process:{pid:process.pid,kill:process.kill.bind(process),platform:'win32',env:{ANTIGRAVITY_EXECUTABLE_DATA_DIR:'/test-data',ANTIGRAVITY_LS_ADDRESS:'test.invalid',ANTIGRAVITY_CSRF_TOKEN:'test'}},
    console:{error:m=>state.errors.push(m)},
    cpSync:()=>{},
    rmSync:()=>{},
    openSync:p=>String(p).replace(/\\/g, '/'),
    readSync:(fd,buf,offset,length,position)=>{
      const src = state.virtualFiles.get(fd);
      if (!src) return 0;
      const start = Math.max(0, Number(position || 0));
      const end = Math.min(src.length, start + length);
      if (end <= start) return 0;
      src.copy(buf, offset, start, end);
      return end - start;
    },
    closeSync:()=>{},
    readlinkSync:()=>'',
    realpathSync:p=>p,
    execFile:execFileImpl || ((cmd,args,opts,cb)=>{
      const fn = typeof opts === 'function' ? opts : cb;
      fn(new Error('execFile not mocked'));
    }),
    existsSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) return true;
      if (norm.endsWith('/vendor/seed-bank.zip')) return Boolean(seedBankZip);
      if (norm.endsWith('settings.json') || norm.endsWith('trajectory_usage_cache.json')) return true;
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return Boolean(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return Boolean(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return Boolean(state.remoteCatalog);
      if (norm.endsWith('plugin.json')) return Boolean(state.pluginManifest);
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        return Boolean(m && state.transcripts?.[m[1]]);
      }
      if (norm.endsWith('/.git')) return Boolean(state.hasGitDir);
      return false;
    },
    mkdirSync:()=>{},readdirSync:()=>[],
    chmodSync:()=>{},
    unlinkSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      state.virtualFiles.delete(norm);
      state.virtualMtimes.delete(norm);
    },
    copyFileSync:(src,dst)=>{
      const sNorm = String(src).replace(/\\/g, '/');
      const dNorm = String(dst).replace(/\\/g, '/');
      if (state.virtualFiles.has(sNorm)) {
        state.virtualFiles.set(dNorm, Buffer.from(state.virtualFiles.get(sNorm)));
        touchVirtual(dNorm);
      }
    },
    renameSync:(src,dst)=>{
      const sNorm = String(src).replace(/\\/g, '/');
      const dNorm = String(dst).replace(/\\/g, '/');
      if (state.virtualFiles.has(sNorm)) {
        state.virtualFiles.set(dNorm, state.virtualFiles.get(sNorm));
        state.virtualFiles.delete(sNorm);
        state.virtualMtimes.delete(sNorm);
        touchVirtual(dNorm);
      }
    },
    lstatSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) {
        const buf = state.virtualFiles.get(norm);
        const ts = state.virtualMtimes.get(norm) || 1;
        return {
          mtimeMs: ts,
          ctimeMs: ts,
          size: buf.length,
          isSymbolicLink: () => false,
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
    statSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) {
        const buf = state.virtualFiles.get(norm);
        const ts = state.virtualMtimes.get(norm) || 1;
        return {
          mtimeMs: ts,
          ctimeMs: ts,
          ino: 1000 + norm.length,
          size: buf.length,
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        if (lines) {
          const text = Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines);
          return {mtimeMs:state.transcriptMtimeMs,size:Buffer.byteLength(text,'utf8')};
        }
      }
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json') && state.deepStats) {
        return {mtimeMs:state.deepStatsMtimeMs,size:JSON.stringify(state.deepStats).length};
      }
      return {mtimeMs:0,size:0};
    },
    readFileSync:(p,enc)=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) {
        const buf = state.virtualFiles.get(norm);
        return enc ? buf.toString(enc) : buf;
      }
      if (norm.endsWith('/vendor/seed-bank.zip')) return seedBankZip;
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        return Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines || '');
      }
      if (norm.endsWith('settings.json')) return JSON.stringify(settings);
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return JSON.stringify(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return JSON.stringify(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return JSON.stringify(state.remoteCatalog);
      if (norm.endsWith('plugin.json')) return JSON.stringify(state.pluginManifest);
      return JSON.stringify(cache);
    },
    writeFileSync:(p,s)=>{
      const norm = String(p).replace(/\\/g, '/');
      const buf = Buffer.isBuffer(s) ? Buffer.from(s) : Buffer.from(String(s), 'utf8');
      state.virtualFiles.set(norm, buf);
      touchVirtual(norm);
      let parsed = s;
      if (typeof s === 'string') {
        try {
          parsed = JSON.parse(s);
        } catch {
          parsed = s;
        }
      }
      state.saves.push({path:p,data:parsed});
      if (norm.endsWith('remote_pricing_cache.json')) {
        state.remoteCatalog = parsed;
      }
    },
    homedir:()=>'/test-home',dirname:path.dirname,join:path.join,basename:path.basename,fileURLToPath:()=>mainPath,
    Response:class {constructor(body,options){this.body=body;this.options=options;}},
    SidecarApp:class {page(){} api(){} run(){}},
    fetch:async(url,options={})=>{
      if (/^https?:\/\/(?!test\.invalid)/i.test(String(url)) && remoteFetch) {
        return remoteFetch(url, options);
      }
      const method=url.split('/').pop(); const body=options.body ? JSON.parse(options.body) : {};state.calls.push({method,body});
      if(method==='GetCascadeTrajectory') {
        const data=state.trajectories[body.cascadeId];
        if(data instanceof Error) throw data;
        return {ok:true,json:async()=>data||{}};
      }
      if(method==='RetrieveUserQuotaSummary') {
        const qs=state.quotaSummary;
        if(qs instanceof Error) throw qs;
        return {ok:true,json:async()=>({response:qs})};
      }
      const data={GetUserStatus:{userStatus:state.userStatus},GetAllCascadeTrajectories:{trajectorySummaries:state.summaries},DeleteCascadeTrajectory:{},CancelCascadeInvocation:{}}[method];
      return {ok:true,json:async()=>data||{}};
    },
  };
  vm.runInNewContext(source+'\n globalThis.api={buildTelemetryPayloadInternal,computeStepCost,resolveModelInfo,inferFamilyFromProviderOrKey,isArgonModelIdentifier,isCarbonModelIdentifier,getBaseModelLabel,formatUpstreamModelId,PLACEHOLDER_MAP,normalizeQuotaFraction,classifyOfficialBucketWindow,classifyQuotaPoolIdentity,buildOfficialQuotaPools,resolveTimeWindow,sanitizeCatalogPayload,rebuildActiveCatalog,syncCloudCatalog,getCloudStatus,isValidSemver,compareSemver,performPluginUpdate,resolveMigratedGitRemoteUrl,loadSettings,executeSettingsAction,dispatchBridgeApiRequest,ensureDetectorEngine,resolveAntigravityDetectorCatalog,resolveProbeExecutionModel,extractTieredModelBase,resolveAgentApiBinary,getModelDetectorStatus,startAntigravityModelDetection,cancelAntigravityModelDetection,syncDetectorBank,suggestAntigravityReference,compareForDisplay,formatDiagnosisSummary,CONTEXT_WINDOW_MODES,AGY_CLAMP_X64_UNPATCHED_HEX,normalizeContextWindowMode,decodeArm64ClampAt,decodeX64ClampAt,buildPatchedClampBuffer,inspectAntigravityContextBinary,resolveAntigravityDesktopAppPath,getContextWindowControlSnapshot,switchContextWindowMode,ensureContextWindowAlignedOnBoot,clearContextWindowCachesForTests,evaluateAgentInferenceHealth,mergeAggregatedInferenceHealth};',ctx);
  return {...ctx.api,state};
}
