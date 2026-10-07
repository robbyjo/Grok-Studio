import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('embedded startup resolves native skipped runtime fields and respects explicit subagent opt-out', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-engine-config-')),
    home = join(root, 'grok');
  mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), '[subagents]\nmax_depth=2\n');
  const path = resolve('.runtime/studio-engine.node');
  const run = (disabled: string) => {
    const script =
      'const native=require(process.env.STUDIO_TEST_ADDON);native.start(process.cwd(),"test-only-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","oauth");console.log("CONFIG="+native.configurationStatus());process.exit(0);';
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: {
        ...process.env,
        STUDIO_TEST_ADDON: path,
        GROK_HOME: home,
        GROK_SUBAGENTS: disabled,
        XAI_API_KEY: '',
        GROK_DEPLOYMENT_KEY: '',
      },
    });
    return JSON.parse(
      output
        .split(/\r?\n/)
        .find((line) => line.startsWith('CONFIG='))!
        .slice(7),
    );
  };
  const defaultConfig = run('');
  assert.equal(defaultConfig.subagentsEnabled, true);
  assert.equal(defaultConfig.subagentsMaxDepth, 2);
  assert.equal(run('0').subagentsEnabled, false);
});

test('native MCP configuration waits for a Windows byte-range lock and saves without bypassing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-engine-lock-')),
    home = join(root, 'grok');
  mkdirSync(home);
  const addon = resolve('.runtime/studio-engine.node');
  const script = `
    const native=require(process.env.STUDIO_TEST_ADDON),{spawn}=require('node:child_process'),path=require('node:path');
    native.start(process.cwd(),'test-only-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','oauth');
    const hold="$ErrorActionPreference='Stop';$f=[IO.File]::Open($env:STUDIO_TEST_LOCK,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);try{$f.Lock(0,1);[Console]::WriteLine('HELD');[Threading.Thread]::Sleep(400)}finally{$f.Unlock(0,1);$f.Dispose()}";
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',hold],{windowsHide:true,env:{...process.env,STUDIO_TEST_LOCK:path.join(process.env.GROK_HOME,'.config-init.lock')}});
    let output='';child.stdout.on('data',async chunk=>{output+=chunk;if(!output.includes('HELD'))return;child.stdout.removeAllListeners('data');const began=Date.now();try{const result=JSON.parse(await native.mcp(JSON.stringify({operation:'add',scope:'user',name:'locked-fixture',config:{command:'node',args:[]}})));console.log('LOCK='+JSON.stringify({elapsed:Date.now()-began,saved:result.saved}));process.exit(0)}catch(error){console.error(error.message);process.exit(1)}});
    child.stderr.pipe(process.stderr);child.on('exit',code=>{if(code&&!output.includes('HELD'))process.exit(code)});
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: {
      ...process.env,
      STUDIO_TEST_ADDON: addon,
      GROK_HOME: home,
      XAI_API_KEY: '',
      GROK_DEPLOYMENT_KEY: '',
    },
  });
  const result = JSON.parse(
    output
      .split(/\r?\n/)
      .find((line) => line.startsWith('LOCK='))!
      .slice(5),
  );
  assert.equal(result.saved, true);
  assert.ok(result.elapsed >= 200, 'The native write must wait for the lock holder.');
});
