const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const es31 = process.argv.includes('--es31');
const reportFile = path.join(__dirname, es31 ?
  'results/web-engine-webgpu-es31-results.json' : 'results/web-engine-webgpu-results.json');
const incremental = process.argv.includes('--incremental');
const shaderCook = es31 || process.argv.includes('--shader-cook');
const contentMode = es31 ? 'WebGPU-ES31' : 'WebGPU-SM5';
const report = {date: new Date().toISOString(), pass: false, architecture: 'wasm64',
  contentMode: shaderCook ? contentMode : 'NullRHI-only',
  deviceCreationVerified: false, preRHIResourcesInitialized: false,
  nullRHITickVerified: false, fullNormalUBTBuildVerified: false,
  engineLoopBrowserTickVerified: false, completeBrowserUERuntime: false,
  completeUEScene: false, browserRuns: []};

(async () => {
  let browser;
  try {
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (incremental) {
      const buildFile = path.join(__dirname, 'results/web-engine-webgpu-link-results.json');
      const build = read(buildFile);
      assert(build.pass && build.mode === 'incremental-link-diagnostic' &&
        build.fullNormalUBTBuildVerified === false && valid(build.log) &&
        valid(build.moduleCompileLog) && valid(build.linkResponse) && valid(build.ubt) &&
        build.linkInputs.every(valid) && build.sourceFiles.every(valid) && build.products.every(valid));
      assert((build.recompiledObjects || []).every(item => item.exitCode === 0 &&
        ['response', 'source', 'product', 'log'].every(key => valid(item[key]))));
      report.buildReport = audit(buildFile);
      const baselineFile = fs.readdirSync(path.join(__dirname, 'results'))
        .filter(name => /^web-engine-runtime-results-before-webgpu-.*\.json$/.test(name)).sort().at(-1);
      const baselinePath = path.join(__dirname, 'results', baselineFile);
      const baseline = read(baselinePath);
      assert(baseline.pass && baseline.engineLoopBrowserTickVerified);
      report.previousNullRHIBaseline = audit(baselinePath);
      const configs = baseline.configFiles.map(({file, virtualPath}) => ({...audit(file), virtualPath}));
      configs.push({...audit(path.join(__dirname, '../../reference-engine/Engine/Platforms/Web/Config/WebEngine.ini')),
        virtualPath: '/Engine/Platforms/Web/Config/WebEngine.ini'});
      const configBundle = path.join(__dirname, 'build/web-engine/config-files.json');
      fs.writeFileSync(configBundle, JSON.stringify(configs.map(item => ({
        path: item.virtualPath, sha256: item.sha256, data: fs.readFileSync(item.file).toString('base64')
      }))));
      report.configBundle = audit(configBundle);
      report.configFiles = configs;
      const stageFile = path.join(__dirname, 'results/web-engine-stage-results.json');
      const stage = read(stageFile);
      const cook = read(stage.cookReport.file);
      assert(stage.pass && stage.mode === 'NullRHI-only' && valid(stage.cookReport) &&
        valid(stage.pack) && valid(stage.manifest) && stage.sourceFiles.every(valid) &&
        cook.pass && cook.products.every(valid) && cook.sourceFiles.every(valid) &&
        cook.hostProducts.every(valid) && valid(cook.log));
      report.stageReport = audit(stageFile);
    } else {
      const baselineFile = path.join(__dirname, 'results/web-engine-runtime-results.json');
      const baseline = read(baselineFile);
      assert(baseline.pass && baseline.engineLoopBrowserTickVerified &&
        valid(baseline.buildReport) && valid(baseline.stageReport) &&
        valid(baseline.configBundle) && baseline.stagedFiles.every(valid),
      'Run the current full build, Cook/Stage and NullRHI browser regression first');
      const build = read(baseline.buildReport.file);
      assert(build.pass && build.sourceFiles.every(valid) && build.products.every(valid) && valid(build.ubt));
      report.buildReport = baseline.buildReport;
      report.nullRHIBaseline = audit(baselineFile);
      report.stageReport = baseline.stageReport;
      report.fullNormalUBTBuildVerified = true;
    }
    report.sourceFiles = ['probe-web-engine-webgpu.cjs', 'web-engine.html']
      .map(name => audit(path.join(__dirname, name)));
    if (es31) report.sourceFiles.push(...['capture-web-texture-uploads.cjs', 'capture-web-canvas.cjs']
      .map(name => audit(path.join(__dirname, name))));
    if (es31) report.sourceFiles.push(...[
      'Source/Runtime/Launch/Private/LaunchEngineLoop.cpp',
      'Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompiler.cpp'
    ].map(name => audit(path.join(__dirname, '../../.tools/ue58-web-build-host/Engine', name))));
    const nullContent = read(report.stageReport.file).files;
    let gpuContent = null;
    if (shaderCook) {
      const stageFile = path.join(__dirname, es31 ?
        'results/web-engine-webgpu-es31-stage-results.json' : 'results/web-engine-webgpu-stage-results.json');
      const stage = read(stageFile);
      assert(stage.pass && stage.mode === contentMode && valid(stage.cookReport) &&
        valid(stage.pack) && valid(stage.manifest) && stage.sourceFiles.every(valid));
      const cook = read(stage.cookReport.file);
      assert(cook.pass && cook.mode === contentMode && cook.products.every(valid) &&
        cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && valid(cook.log));
      const prepared = read(cook.hostPreparationReport.file);
      assert(valid(cook.hostPreparationReport) && valid(cook.hostPreparationLog) && prepared.pass &&
        prepared.sourceFiles.every(valid) && prepared.products.every(valid));
      report.webgpuStageReport = audit(stageFile);
      gpuContent = stage.files;
      if (es31) {
        const settings = file => fs.readFileSync(file, 'utf8').split(/\r?\n/)
          .map(line => line.trim()).filter(line => /^(?:r\.|landscape\.)[^=]+=/.test(line)).sort();
        const runtimeConfig = report.configFiles.find(item =>
          item.virtualPath === '/Engine/Platforms/Web/Config/WebEngine.ini');
        assert(runtimeConfig, 'The runtime renderer configuration must be staged');
        assert.deepEqual(settings(runtimeConfig.file), settings(cook.minimalRendererConfig.file),
          'Runtime renderer settings must match the successful ES3.1 Cook');
        report.rendererSettingsMatched = true;
        report.cookedMaterialPolicy = cook.shaderInventory.detail.materialPolicy;
      }
    }
    const browserModes = [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ].flatMap(([name, executable]) => (incremental ? ['null', 'webgpu'] : ['webgpu'])
      .map(rhi => [name, executable, rhi]));
    for (const [name, executablePath, rhi] of browserModes) {
      const run = {browser: name, rhi, pass: false, consoleLog: [], errors: [],
        rhiFactorySelected: false, preRHIResourcesInitialized: false, gpuValidationErrors: [],
        startupBlocker: null, viewportEnds: [], shaderLibraryOpened: false, projectShaderLibraryOpened: false,
        globalShaderMapStartupPassed: false, gameEngineInitialized: false, startupMapMissing: false};
      try {
        browser = await chromium.launch({executablePath, headless: true});
        run.version = browser.version();
        const page = await browser.newPage({viewport: {width: 1280, height: 800}});
        await page.addInitScript(() => { Error.stackTraceLimit = 100; });
        if (es31 && rhi === 'webgpu') {
          await page.addInitScript(require('./capture-web-texture-uploads.cjs'));
          await page.addInitScript(require('./capture-web-canvas.cjs'));
        }
        page.on('pageerror', error => {
          run.errors.push(error.stack || error.message);
          if (error.message.includes('Cannot mix BigInt') && error.stack?.includes('makeStringFromStringView'))
            run.startupBlocker = 'webgpu-string-view-wasm64-abi';
        });
        page.on('console', message => {
          const text = message.text();
          if (text.startsWith('P3_MATERIAL_POLICY '))
            run.materialPolicy = JSON.parse(text.slice('P3_MATERIAL_POLICY '.length));
          for (const [marker, field] of [
            ['P3_VIEWPORT_REQUEST ', 'viewportRequest'], ['P3_VIEWPORT_CONFIGURED ', 'viewportConfigured']
          ]) {
            const start = text.indexOf(marker);
            if (start >= 0) run[field] = JSON.parse(text.slice(start + marker.length));
          }
          const viewportEnd = text.indexOf('P3_VIEWPORT_END ');
          if (viewportEnd >= 0) run.viewportEnds.push(JSON.parse(text.slice(viewportEnd + 'P3_VIEWPORT_END '.length)));
          run.consoleLog.push(text);
          if (run.consoleLog.length > 1000) run.consoleLog.shift();
          if (message.type() === 'error') run.errors.push(text);
          if (text.includes('GPU validation:')) run.gpuValidationErrors.push(text);
          if (text.includes(`P2_STARTUP factory selected WebGPU platform=${es31 ? 46 : 47} `)) run.rhiFactorySelected = true;
          if (text.includes('Game Engine Initialized.')) run.gameEngineInitialized = true;
          if (text.includes('UGameInstance::StartGameInstance.MapNotFound')) run.startupMapMissing = true;
          if (text.includes('P2_STARTUP pre-RHI resources initialized')) run.preRHIResourcesInitialized = true;
          if (text.includes("Logical shader library 'Global' has been created as a monolithic library"))
            run.shaderLibraryOpened = true;
          if (text.includes("Logical shader library 'UEWebEngine' has been created as a monolithic library"))
            run.projectShaderLibraryOpened = true;
          if (rhi === 'webgpu' && run.shaderLibraryOpened && text.includes('Running DelayedAutoRegister Phase PreObjectSystemReady'))
            run.globalShaderMapStartupPassed = true;
          if (text.includes('WebGPURHI operation is not implemented:'))
            run.startupBlocker = text.slice(text.indexOf('WebGPURHI operation is not implemented:'));
          if (text.includes('Failed to initialize ShaderCodeLibrary required by the project because part of the Global shader library is missing')) {
            run.startupBlocker = 'global-shader-library-missing';
          }
          if (text.includes('Attempting to load an incompatible memory image'))
            run.startupBlocker = 'shader-map-memory-layout-mismatch';
          if (text.includes('Web does not support Oodle-compressed data') ||
              text.includes('Could not decompress shader with Oodle'))
            run.startupBlocker = 'shader-payload-oodle-unsupported';
          if (/Web shader (header\/frequency invalid|optional-data|payload truncated)/.test(text))
            run.startupBlocker = 'shader-payload-wrapper-invalid';
          if (text.includes('Assertion failed: Rasterizer.FillMode =='))
            run.startupBlocker = 'graphics-rasterizer-state-unsupported';
          if (text.includes('Consolidate was hit while Get/SetPSO was running'))
            run.startupBlocker = 'pipeline-cache-consolidation-guard';
          if (text.includes('WebGPU BufferSRV unsupported:'))
            run.startupBlocker = text.slice(text.indexOf('WebGPU BufferSRV unsupported:'));
          if (text.includes('Resource access mismatch:'))
            run.startupBlocker = text.slice(text.indexOf('Resource access mismatch:'));
          if (text.includes('WebGPU texture creation unsupported:'))
            run.startupBlocker = text.slice(text.indexOf('WebGPU texture creation unsupported:'));
          if (text.includes('Failed to find shader map for default material'))
            run.startupBlocker = 'default-material-shader-map-incomplete';
          if (text.includes('Viewport requires a valid window and nonzero dimensions within device limits'))
            run.startupBlocker = 'viewport-window-or-dimensions-invalid';
          if (text.includes('WebGPU viewport currently supports windowed presentation only'))
            run.startupBlocker = 'viewport-fullscreen-unsupported';
          if (text.includes('WebGPU viewport currently supports RGBA8/BGRA8 only'))
            run.startupBlocker = 'viewport-format-unsupported';
          if (text.includes('Current viewport probe requires render attachment and CopySrc surface usages'))
            run.startupBlocker = 'viewport-surface-usage-query';
          if (text.includes('Current WebGPU viewport supports FIFO/vsync presentation only'))
            run.startupBlocker = 'viewport-fifo-vsync-request-mismatch';
          if (text.includes('GetFullScreenInfo is not expected to be called on this platform'))
            run.startupBlocker = 'canvas-display-bounds-missing';
        });
        await page.goto(`http://127.0.0.1:8765/web-engine.html?rhi=${rhi}${incremental ? '&incremental=1' : ''}${shaderCook && rhi === 'webgpu' ? `&cook=${es31 ? 'es31' : 'webgpu'}` : ''}`,
          {waitUntil: 'commit'});
        try {
          await page.waitForFunction(() => globalThis.__webEngineFailure ||
            (globalThis.__webEngineReady && globalThis.__webEngineFrames >= 9), null, {timeout: 45000});
        } catch (error) {
          run.waitFailure = error.message;
        }
        const state = await page.evaluate(() => ({
          deviceReady: globalThis.__webEngineGPUDeviceReady ?? null,
          ready: globalThis.__webEngineReady || null, frames: globalThis.__webEngineFrames || 0,
          layout: globalThis.__webEngineLayout || null,
          world: globalThis.__webEngineWorld || null,
          fileCache: globalThis.__webEngineFileCache || null,
          canvas: globalThis.__webCanvas || null,
          failure: globalThis.__webEngineFailure || null, log: globalThis.__webEngineLog,
          configFiles: globalThis.__webEngineConfigFiles || [],
          contentFiles: globalThis.__webEngineContentFiles || []
        }));
        Object.assign(run, state);
        if (rhi === 'webgpu' && state.failure && !run.startupBlocker)
          run.startupBlocker = run.consoleLog.findLast(line =>
            /(?:Assertion failed|Ensure condition failed):/.test(line))?.trim() || 'unclassified-engine-failure';
        if (es31 && rhi === 'webgpu') {
          run.engineQueueCompletion = await page.evaluate(() => globalThis.__webCanvasWaitIdle());
          run.textureUploads = await page.evaluate(() => globalThis.__webTextureUploads.readback());
        }
        assert.deepEqual(state.configFiles, report.configFiles.map(({virtualPath, sha256}) =>
          ({path: virtualPath, sha256})), 'Browser must mount the audited configuration bytes');
        assert.deepEqual(state.contentFiles, (rhi === 'webgpu' && gpuContent ? gpuContent : nullContent)
          .map(({path, sha256, size}) => ({path, sha256, size})),
        'Browser must mount the audited Cook/Stage bytes');
        run.stagedContentVerified = true;
        if (es31) {
          assert.deepEqual(state.layout, {maxFieldAlignment: 4294967295, flags: 1, pointerBytes: 8},
            'Cook requires the actual wasm64 Clang memory-image layout');
          run.wasmLayoutVerified = true;
        }
        run.minimalPolicyVerified = state.ready?.webGPUSceneEnabled === false &&
          state.ready?.skinningSceneEnabled === false && state.ready?.mobileGPUSceneSetting === 0 &&
          state.ready?.skinningSceneSetting === 0;
        run.minimalMapLoaded = state.world?.package === '/Game/WebMinimal' &&
          state.world.begunPlay === true && state.world.exitRequested === false &&
          !run.startupMapMissing;
        if (rhi === 'null' && es31) {
          assert.deepEqual(state.fileCache, {pass: true, handles: 3, blockReads: 387, crossBlockReads: 3,
            checkedBytes: 25362483}, 'File cache must survive repeated inline completions and handle cleanup');
          run.fileCacheVerified = true;
        }
        run.pass = (rhi === 'null' ? state.ready?.nullRHI === true && run.minimalPolicyVerified :
          state.deviceReady === true && run.rhiFactorySelected &&
          run.preRHIResourcesInitialized && state.ready?.nullRHI === false &&
          (!es31 || state.ready?.shaderPlatform === 46)) &&
          state.frames >= 9 && run.minimalMapLoaded && !state.failure && run.errors.length === 0 &&
          run.gpuValidationErrors.length === 0 && !run.waitFailure;
      } catch (error) {
        run.failure = error.stack;
      } finally {
        report.browserRuns.push(run);
        if (browser) await browser.close();
        browser = null;
      }
    }
    const gpuRuns = report.browserRuns.filter(run => run.rhi === 'webgpu');
    const nullRuns = report.browserRuns.filter(run => run.rhi === 'null');
    report.nullRHITickVerified = incremental ? nullRuns.length === 2 && nullRuns.every(run => run.pass) : true;
    report.nullRHIMinimalPolicyVerified = nullRuns.length === 2 && nullRuns.every(run => run.minimalPolicyVerified);
    report.deviceCreationVerified = gpuRuns.length === 2 && gpuRuns.every(run => run.deviceReady === true);
    report.preRHIResourcesInitialized = gpuRuns.length === 2 && gpuRuns.every(run => run.preRHIResourcesInitialized);
    report.shaderLibraryOpenedVerified = gpuRuns.length === 2 && gpuRuns.every(run => run.shaderLibraryOpened);
    report.projectShaderLibraryOpenedVerified = gpuRuns.length === 2 && gpuRuns.every(run => run.projectShaderLibraryOpened);
    report.globalShaderMapStartupPassed = gpuRuns.length === 2 && gpuRuns.every(run => run.globalShaderMapStartupPassed);
    report.fileCacheVerified = nullRuns.length === 2 && nullRuns.every(run => run.fileCacheVerified);
    report.textureMipUploadsVerified = es31 && gpuRuns.length === 2 &&
      gpuRuns.every(run => run.textureUploads?.pass && run.textureUploads.mips.some(mip => mip.mip > 0));
    report.canvasViewportConfiguredVerified = es31 && gpuRuns.length === 2 && gpuRuns.every(run =>
      run.viewportRequest?.hasWindow && !run.viewportRequest.fullscreen &&
      run.viewportRequest.format === 2 && run.viewportConfigured?.format === 2 &&
      run.canvas?.configurations.some(config => config.canvas === 'canvas' &&
        config.deviceMatched && config.format === 'bgra8unorm' &&
        config.width === run.viewportConfigured.width && config.height === run.viewportConfigured.height));
    report.breadcrumbMarkerForwardedVerified = es31 && gpuRuns.length === 2 && gpuRuns.every(run =>
      run.canvas?.debugMarkers.some(marker => marker.kind === 'command' && marker.label.length > 0) &&
      !run.errors.some(error => error.includes('Cannot mix BigInt')));
    report.staticUniformStartupVerified = es31 && gpuRuns.length === 2 && gpuRuns.every(run =>
      run.consoleLog.some(line => /P3_STATIC_UNIFORMS batch=\d+ count=\d+ slots=\d+/.test(line)) &&
      !run.errors.some(error => error.includes('operation is not implemented: RHISetStaticUniformBuffer')));
    report.browserViewportEndVerified = es31 && gpuRuns.length === 2 && gpuRuns.every(run =>
      run.viewportEnds.some(end => end.effectiveMode === 'browser-fifo' && !end.requestedVSync &&
        end.present && end.ended > 0 && end.backbufferReleased && end.submitted > 0) &&
      run.canvas.queueSubmissions > 0 && run.canvas.submittedCommandBuffers > 0 &&
      run.engineQueueCompletion?.pass &&
      !run.consoleLog.some(line => line.includes('Current WebGPU viewport supports FIFO/vsync presentation only')));
    report.browserShaderCreationVerified = es31 && gpuRuns.length === 2 && gpuRuns.every(run =>
      run.canvas.shaderModules >= 2 && run.gpuValidationErrors.length === 0 &&
      !run.consoleLog.some(line => /Could not decompress shader with Oodle|Web shader header\/frequency invalid/.test(line)));
    report.browserClearDrawSubmittedVerified = report.browserShaderCreationVerified && gpuRuns.every(run =>
      run.canvas.renderPipelines >= 1 && run.canvas.drawCalls >= 1 &&
      run.canvas.debugMarkers.some(marker => marker.label === 'CanvasClear') &&
      run.canvas.submittedCommandBuffers >= 15 && run.engineQueueCompletion?.pass);
    report.synchronousPSOConsolidationConfigured = es31 && report.configFiles.some(item =>
      item.virtualPath === '/Engine/Platforms/Web/Config/WebEngine.ini' &&
      /^r\.pso\.EnableAsyncCacheConsolidation=0\s*$/m.test(fs.readFileSync(item.file, 'utf8')));
    report.gameEngineInitializedVerified = gpuRuns.length === 2 && gpuRuns.every(run => run.gameEngineInitialized);
    report.engineInitReturnedVerified = gpuRuns.length === 2 && gpuRuns.every(run =>
      run.ready?.nullRHI === false && run.ready?.shaderPlatform === 46 &&
      run.ready?.shaderCount === 834 && run.minimalPolicyVerified);
    report.startupMapMissingObserved = gpuRuns.length === 2 && gpuRuns.every(run => run.startupMapMissing);
    report.minimalMapLoadedVerified = report.browserRuns.length === 4 &&
      report.browserRuns.every(run => run.minimalMapLoaded);
    report.canvasBackbufferAcquiredVerified = report.canvasViewportConfiguredVerified && gpuRuns.every(run =>
      run.canvas.acquisitions.some(texture => texture.width === run.viewportConfigured.width &&
        texture.height === run.viewportConfigured.height && texture.format === 'bgra8unorm' &&
        (texture.usage & 17) === 17));
    report.materialPolicyMatched = es31 && !!report.cookedMaterialPolicy &&
      gpuRuns.length === 2 && gpuRuns.every(run => run.materialPolicy?.platform === 46 &&
        run.materialPolicy.mobile && Object.entries(report.cookedMaterialPolicy)
          .every(([key, value]) => run.materialPolicy[key] === value));
    report.stagedContentVerified = report.browserRuns.length > 0 &&
      report.browserRuns.every(run => run.stagedContentVerified);
    report.es31LibraryIntegrationVerified = es31 && report.rendererSettingsMatched &&
      report.deviceCreationVerified && report.preRHIResourcesInitialized &&
      report.stagedContentVerified && report.shaderLibraryOpenedVerified &&
      report.projectShaderLibraryOpenedVerified && report.globalShaderMapStartupPassed &&
      report.fileCacheVerified && report.nullRHITickVerified &&
      gpuRuns.every(run => run.rhiFactorySelected && run.wasmLayoutVerified);
    report.engineLoopBrowserTickVerified = gpuRuns.length === 2 && gpuRuns.every(run => run.pass);
    report.pass = report.nullRHITickVerified && report.engineLoopBrowserTickVerified;
    report.boundary = (incremental ?
      'Incremental diagnostic link of existing full Engine objects plus newly compiled WebGPU modules; current full normal UBT build remains unverified. ' : '') +
      'Mixed-source wasm64 Engine with browser WebGPU device creation and the shared real WebGPURHI backend. ' +
      (shaderCook ? `Hardware startup uses the audited real ${contentMode} Cook/Stage; NullRHI uses its own shader-free Cook. ` :
        'Startup uses shader-free NullRHI-only Cook content solely to locate the first hardware startup blocker. ') +
      'Global-map startup completion is inferred from reaching PreObjectSystemReady after the existing CompileGlobalShaderMap/VerifyGlobalShaders call; their guards are unchanged. Opening a library does not verify shader-payload decompression or RHI shader creation. ' +
      'Tick success requires /Game/WebMinimal BeginPlay and rejects engine exit requests. ' +
      'The minimal map is empty; loading it does not verify a rendered mesh, camera interaction or HTML UI.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, nullRHITickVerified: report.nullRHITickVerified,
      fullNormalUBTBuildVerified: report.fullNormalUBTBuildVerified, deviceCreationVerified: report.deviceCreationVerified,
      preRHIResourcesInitialized: report.preRHIResourcesInitialized,
      es31LibraryIntegrationVerified: report.es31LibraryIntegrationVerified,
      globalShaderMapStartupPassed: report.globalShaderMapStartupPassed,
      projectShaderLibraryOpenedVerified: report.projectShaderLibraryOpenedVerified,
      canvasViewportConfiguredVerified: report.canvasViewportConfiguredVerified,
      canvasBackbufferAcquiredVerified: report.canvasBackbufferAcquiredVerified,
      breadcrumbMarkerForwardedVerified: report.breadcrumbMarkerForwardedVerified,
      staticUniformStartupVerified: report.staticUniformStartupVerified,
      browserViewportEndVerified: report.browserViewportEndVerified,
      browserShaderCreationVerified: report.browserShaderCreationVerified,
      browserClearDrawSubmittedVerified: report.browserClearDrawSubmittedVerified,
      synchronousPSOConsolidationConfigured: report.synchronousPSOConsolidationConfigured,
      gameEngineInitializedVerified: report.gameEngineInitializedVerified,
      engineInitReturnedVerified: report.engineInitReturnedVerified,
      startupMapMissingObserved: report.startupMapMissingObserved,
      minimalMapLoadedVerified: report.minimalMapLoadedVerified,
      fileCacheVerified: report.fileCacheVerified,
      textureMipUploadsVerified: report.textureMipUploadsVerified,
      browserRuns: report.browserRuns.map(({browser, rhi, pass, deviceReady, rhiFactorySelected,
        preRHIResourcesInitialized, frames, startupBlocker, failure}) =>
        ({browser, rhi, pass, deviceReady, rhiFactorySelected, preRHIResourcesInitialized,
          frames, startupBlocker, failure})), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
