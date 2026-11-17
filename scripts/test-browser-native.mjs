#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runDirectory, findChrome, prepareFixture, reserveDebugPort, connectToChrome, createCDP, waitFor, capture, stopChrome } from './test-browser-oauth.mjs';

if (!process.argv.includes('--real')) throw Error('This test uses your installed Codex model with synthetic pages. Run pnpm test:native --real explicitly.');
const cleanupPrompt = '只归档标题以「临时检索」开头、闲置超过一小时且与当前工作无关的测试搜索结果，归为 temporary。保留其它页面；同一主题使用相同 task。';
const groupingPrompt = '将两个标题以「临时检索」开头的标签归入同一个「临时检索」组，其余标签按用途分组。每个输入 ID 必须且只能出现一次。';
const server = createServer((request, response) => {
  const route = new URL(request.url, 'http://fixture').pathname;
  const title = route.startsWith('/search/') ? `临时检索 ${route.endsWith('one') ? '一' : '二'} 搜索结果`
    : route === '/work' ? '当前工作 项目编辑' : route === '/protected' ? '受保护资料' : route === '/recent' ? '最近使用的文章' : '固定参考资料';
  response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  response.end(`<!doctype html><title>${title}</title><p>Synthetic TabFlow regression page</p>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome, cdp, exited;
let evidence = { realInference: true, usesExistingBrowserProfile: false, syntheticPagesOnly: true, syntheticIdleTimestamps: true, mockedInference: false };

// Observe real native calls without changing their inputs, responses or destination.
const trace = `(() => {
  globalThis.__nativeTrace = [];
  const send = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
  chrome.runtime.sendNativeMessage = (host, request, callback) => {
    let input; try { input = JSON.parse(request.input); } catch {}
    const entry = { action: request.action, protocolVersion: request.protocolVersion,
      schema: request.outputSchema?.required, candidateIds: input?.candidates?.map(tab=>tab.id),
      contextIds: input?.context?.map(tab=>tab.id), sanitized: request.outputSchema?.required?.includes('decisions')
        ? !request.input.includes('token=') && !request.input.includes('#synthetic') : undefined };
    globalThis.__nativeTrace.push(entry);
    return send(host, request, response => {
      const error = chrome.runtime.lastError?.message;
      Object.assign(entry, { success: response?.success, modelUsed: response?.modelUsed, error: error || response?.error });
      callback(response);
    });
  };
})()`;

try {
  const directory = await prepareFixture(), port = await reserveDebugPort();
  const profile = path.join(runDirectory, 'real-native-profile');
  if (process.platform === 'darwin') {
    // An isolated user-data directory has its own user-level host registry. Keep the real launcher path.
    const hosts = path.join(profile, 'NativeMessagingHosts'); await mkdir(hosts, { recursive: true });
    await copyFile(path.join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabflow.codex_bridge.json'), path.join(hosts, 'com.tabflow.codex_bridge.json'));
  }
  chrome = spawn(await findChrome(), ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-sync',
    '--disable-background-networking', '--enable-unsafe-extension-debugging', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; chrome.once('error', error => { launchError = error; }); exited = new Promise(resolve => chrome.once('exit', resolve));
  const connection = await connectToChrome(port, () => launchError); cdp = createCDP(connection.socket);
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: directory });
  evidence = { ...evidence, browser: connection.version.Browser, extensionId: id };
  const attach = async targetId => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    return { sessionId, evaluate: async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId, 140_000);
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    } };
  };
  const bootstrap = await cdp.send('Target.createTarget', { url: `chrome-extension://${id}/options.html` });
  const control = await attach(bootstrap.targetId);
  await waitFor(() => control.evaluate('Boolean(document.getElementById("ai-provider"))'), 'bootstrap settings');
  const ping = await control.evaluate(`new Promise(resolve=>chrome.runtime.sendNativeMessage('com.tabflow.codex_bridge',{action:'PING'},r=>resolve({reply:r,error:chrome.runtime.lastError?.message})))`);
  assert.equal(ping.error, undefined); assert.equal(ping.reply?.protocolVersion, 1); assert(ping.reply.supportedActions.includes('GENERATE_JSON'));
  evidence.bridgeVersion = ping.reply.version;
  console.log('Connected to registered native bridge:', ping.reply.version);
  const fixture = await control.evaluate(`(async () => {
    await chrome.storage.sync.set({sidetab_settings:{autoGroupNewTabs:false,aiSettings:{provider:'heuristic'}}});
    const window = await chrome.windows.create({url:${JSON.stringify(origin + '/work')},focused:true});
    const work=(await chrome.tabs.query({windowId:window.id}))[0];
    const create=(url,extra={})=>chrome.tabs.create({windowId:window.id,url,active:false,...extra});
    const first=await create(${JSON.stringify(origin + '/search/one?token=synthetic#synthetic')});
    const second=await create(${JSON.stringify(origin + '/search/two?token=synthetic#synthetic')});
    const pinned=await create(${JSON.stringify(origin + '/pinned')},{pinned:true});
    const recent=await create(${JSON.stringify(origin + '/recent')});
    const protectedTab=await create(${JSON.stringify(origin.replace('127.0.0.1', 'localhost') + '/protected')});
    return {windowId:window.id,ids:[first.id,second.id],pinned:pinned.id,work:work.id,recent:recent.id,protected:protectedTab.id};
  })()`);
  await waitFor(() => control.evaluate(`chrome.tabs.query({windowId:${fixture.windowId}}).then(tabs=>tabs.length===6&&tabs.every(tab=>tab.status==='complete'))`), 'synthetic pages');
  const popupURL = `chrome-extension://${id}/popup.html?windowId=${fixture.windowId}`;
  await control.evaluate(`chrome.windows.create({type:'popup',url:${JSON.stringify(popupURL)},width:440,height:1000})`);
  const target = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === popupURL), 'popup target');
  const view = await attach(target.targetId); const evaluate = view.evaluate;
  await cdp.send('Page.enable', {}, view.sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 1000, deviceScaleFactor: 1, mobile: false }, view.sessionId);
  await evaluate(trace);
  const worker = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/background.js`), 'extension worker');
  const workerView = await attach(worker.targetId); await workerView.evaluate(trace);
  await waitFor(() => evaluate('Boolean(document.querySelector("button[title=设置]"))'), 'app UI');
  await evaluate('document.querySelector("button[title=设置]").click()');
  await waitFor(() => evaluate('Boolean(document.getElementById("ai-provider"))'), 'settings');
  await evaluate(`(()=>{const select=document.getElementById('ai-provider');select.value='codex_native';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate('document.body.innerText.includes("已登录")'), 'real Codex account and catalog', 80_000);
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="分组提示词"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(groupingPrompt)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`chrome.storage.sync.get('sidetab_settings').then(data=>data.sidetab_settings.aiSettings.customPrompt===${JSON.stringify(groupingPrompt)})`), 'grouping settings persistence');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='完成').click()`);
  console.log('Running real Codex grouping through the UI...');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='智能分组').click()`);
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=关闭分组结果]"))'), 'real grouping result', 115_000);
  const groupingText = await evaluate('document.querySelector("[aria-label=关闭分组结果]").parentElement.textContent');
  assert(groupingText.includes('本机 Codex') && groupingText.includes('已创建'), groupingText);
  const grouped = await evaluate(`Promise.all(${JSON.stringify(fixture.ids)}.map(id=>chrome.tabs.get(id))).then(tabs=>tabs.map(tab=>tab.groupId))`);
  assert(grouped[0] >= 0 && grouped[0] === grouped[1]);
  const group = await evaluate(`chrome.tabGroups.get(${grouped[0]}).then(group=>({title:group.title,color:group.color}))`);
  evidence.grouping = { passed: true, groupedTabs: 2, group: group.title };
  await capture(cdp, view.sessionId, 'native-grouping.png');
  console.log('Real grouping passed; running cleanup preview...');
  await evaluate('document.querySelector("button[title=设置]").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=清理策略]"))'), 'cleanup controls');
  await evaluate(`document.querySelector('[aria-label="清理策略"] input[value="aggressive"]').click()`);
  await waitFor(() => evaluate(`chrome.storage.local.get('tabflow_cleanup_config').then(data=>data.tabflow_cleanup_config?.tier==='aggressive')`), 'cleanup tier');
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="清理提示词"]');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(cleanupPrompt)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`chrome.storage.local.get('tabflow_cleanup_config').then(data=>data.tabflow_cleanup_config?.prompt===${JSON.stringify(cleanupPrompt)})`), 'cleanup prompt');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='清理管理').click()`);
  await waitFor(()=>evaluate('Boolean(document.querySelector("section[aria-label=清理管理]"))'), 'management UI');
  await evaluate(`(()=>{const section=document.querySelector('section[aria-label="清理管理"]');[...section.querySelectorAll('summary')].find(el=>el.textContent.includes('保护网站')).click();const input=section.querySelector('[name="hostname"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'localhost');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('form[aria-label="添加保护网站"]').requestSubmit()`);
  await waitFor(() => evaluate(`chrome.storage.local.get('tabflow_cleanup_config').then(data=>data.tabflow_cleanup_config?.protectedSites.includes('localhost'))`), 'protected website');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='返回设置').click()`);
  await waitFor(() => evaluate('!document.querySelector("button[role=switch][aria-label=自动清理]").disabled'), 'cleanup switch ready');
  await evaluate('document.querySelector("button[role=switch][aria-label=自动清理]").click()');
  await waitFor(() => evaluate('document.querySelector("button[role=switch][aria-label=自动清理]").getAttribute("aria-checked")==="true"'), 'cleanup enabled');
  await evaluate(`(async()=>{const key='tabflow_cleanup_session';const state=(await chrome.storage.session.get(key))[key];
    for(const id of ${JSON.stringify([...fixture.ids, fixture.pinned, fixture.protected])})state.tabs[id].lastUsed=Date.now()-2*3600000;
    for(const id of ${JSON.stringify([fixture.work, fixture.recent])})state.tabs[id].lastUsed=Date.now();
    state.resumeAfter=0;state.lastScanAt=Date.now();state.lastEvaluationAt=0;await chrome.storage.session.set({[key]:state});
    const settings=(await chrome.storage.local.get('tabflow_cleanup_config')).tabflow_cleanup_config;settings.notBefore=0;await chrome.storage.local.set({tabflow_cleanup_config:settings});})()`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='清理管理').click()`);
  await waitFor(() => evaluate(`Boolean(Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='查看清理建议'&&!button.disabled))`), 'preview ready');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='查看清理建议').click()`);
  await waitFor(()=>workerView.evaluate("globalThis.__nativeTrace.some(entry=>entry.schema?.includes('decisions')&&entry.success===undefined)"), 'real inference in progress');
  await evaluate(`chrome.tabs.get(${fixture.ids[0]}).then(tab=>chrome.tabGroups.update(tab.groupId,{collapsed:true}))`);
  await waitFor(() => evaluate('(Boolean(document.querySelector("section[aria-label=全部页面清理建议] fieldset")) && !document.querySelector("section[aria-label=全部页面清理建议] [role=status]")) || Boolean(document.querySelector("section[aria-label=全部页面清理建议] [role=alert]"))'), 'real cleanup result', 115_000);
  const previewText = await evaluate('document.querySelector("section[aria-label=全部页面清理建议]").textContent');
  assert(!await evaluate('Boolean(document.querySelector("section[aria-label=全部页面清理建议] [role=alert]"))'), previewText);
  const report = await evaluate(`Array.from(document.querySelectorAll('section[aria-label="全部页面清理建议"] li')).map(row=>({action:row.dataset.cleanupAction,text:row.textContent}))`);
  const allIds = await evaluate('chrome.tabs.query({windowType:"normal"}).then(tabs=>tabs.map(tab=>tab.id))');
  evidence.previewRows = report;
  evidence.previewTrace = await workerView.evaluate('globalThis.__nativeTrace');
  await capture(cdp, view.sessionId, 'native-preview.png');
  assert.equal(report.length, allIds.length);
  assert.equal(report.filter(row=>row.action==='archive').length, 2, JSON.stringify(report));
  assert.equal(report.filter(row=>row.action==='pending').length, 0);
  for (const reason of ['已固定', '当前选中的页面', '闲置记录不足 1 小时', '网站已受保护']) assert(report.some(row=>row.text.includes(reason)), reason);
  assert.equal(await evaluate(`Promise.all(${JSON.stringify(fixture.ids)}.map(id=>chrome.tabs.get(id))).then(tabs=>tabs.length)`), 2);
  const workerTrace = await workerView.evaluate('globalThis.__nativeTrace');
  const cleanupCall = workerTrace.find(entry => entry.schema?.includes('decisions'));
  assert.equal(cleanupCall?.success, true); assert.equal(cleanupCall.action, 'GENERATE_JSON');
  assert.equal(cleanupCall.sanitized, true); assert.deepEqual(cleanupCall.candidateIds.sort(), [...fixture.ids].sort());
  assert(!cleanupCall.contextIds.includes(fixture.protected));
  evidence.preview = { passed: true, all: allIds.length, keep: allIds.length - 2, pending: 0, complete: true, stateChangeSurvived: true, candidates: 2, suggestedArchive: 2, closed: 0, protections: ['pinned', 'active', 'recent', 'website'], modelUsed: cleanupCall.modelUsed };
  await capture(cdp, view.sessionId, 'native-preview.png');
  console.log('Real preview passed; restarting worker and triggering automatic archive...');
  await cdp.send('ServiceWorker.enable', {}, control.sessionId); await cdp.send('ServiceWorker.stopAllWorkers', {}, control.sessionId);
  await evaluate(`(async()=>{const key='tabflow_cleanup_session';const state=(await chrome.storage.session.get(key))[key];state.lastEvaluationAt=0;await chrome.storage.session.set({[key]:state});await chrome.alarms.create('tabflow-cleanup',{when:Date.now()+100});})()`);
  const archived = await waitFor(() => evaluate(`chrome.runtime.sendMessage({action:'CLEANUP',command:'view'}).then(reply=>reply.value?.entries.length===2&&reply.value.entries.every(entry=>entry.state==='archived')?reply.value:null)`), 'automatic archive', 115_000);
  assert(archived.entries.every(entry => entry.model.startsWith('codex_native')));
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='返回清理管理').click()`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.startsWith('归档记录')).click()`);
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=搜索归档]"))'), 'archive UI');
  await capture(cdp, view.sessionId, 'native-archive.png');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='选择搜索结果').click()`);
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='打开所选 (2)'&&!button.disabled)`), 'selected archive entries');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='打开所选 (2)').click()`);
  await waitFor(() => evaluate(`chrome.runtime.sendMessage({action:'CLEANUP',command:'view'}).then(reply=>reply.value?.entries.length===0)`), 'restore completion');
  await waitFor(() => evaluate(`chrome.tabs.query({windowId:${fixture.windowId}}).then(tabs=>tabs.filter(tab=>tab.url?.includes('/search/')).length===2&&tabs.every(tab=>tab.status==='complete'))`), 'restored page navigation');
  const restored = await evaluate(`(async()=>{const tabs=await chrome.tabs.query({windowId:${fixture.windowId}});const view=await chrome.runtime.sendMessage({action:'CLEANUP',command:'view'});return {tabs:tabs.map(tab=>({id:tab.id,groupId:tab.groupId,url:tab.url,pinned:tab.pinned})),protected:view.value.protectedTabIds};})()`);
  const reopened = restored.tabs.filter(tab => tab.url.includes('/search/'));
  assert.equal(reopened.length, 2); assert(reopened[0].groupId >= 0 && reopened[0].groupId === reopened[1].groupId);
  assert(reopened.every(tab => restored.protected.includes(tab.id)));
  assert([fixture.pinned, fixture.work, fixture.recent, fixture.protected].every(id => restored.tabs.some(tab => tab.id === id)));
  const restoredGroup = await evaluate(`chrome.tabGroups.get(${reopened[0].groupId}).then(group=>({title:group.title,color:group.color}))`);
  assert.deepEqual(restoredGroup, group);
  evidence.archive = { passed: true, archived: 2, restored: 2, groupMetadataRestored: true, workerRestart: true, protectedTabsPreserved: true };
  console.log('Archive and restore passed; testing an unregistered summary task on the same bridge...');
  const summary = await evaluate(`new Promise((resolve,reject)=>chrome.runtime.sendNativeMessage('com.tabflow.codex_bridge',{
    action:'GENERATE_JSON',protocolVersion:1,instructions:'用一句简短中文总结输入文本。',input:JSON.stringify({text:'TabFlow 已完成真实分组、清理预览、归档和恢复测试。'}),
    outputSchema:{type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}}}
  },reply=>{const error=chrome.runtime.lastError?.message;if(error||!reply?.success)reject(Error(error||reply?.error));else resolve(reply);}))`);
  assert.equal(summary.protocolVersion, 1); assert.equal(typeof summary.data?.summary, 'string'); assert(summary.data.summary.trim());
  const uiTrace = await evaluate('globalThis.__nativeTrace');
  const inferenceCalls = [...uiTrace, ...workerTrace].filter(entry => entry.action === 'GENERATE_JSON');
  assert(['groups', 'decisions', 'summary'].every(field => inferenceCalls.some(entry => entry.schema?.includes(field) && entry.success)));
  evidence = { ...evidence, passed: true, newTask: { passed: true, schema: 'summary', modelUsed: summary.modelUsed }, nativeCalls: inferenceCalls };
  console.log('REAL native E2E passed: UI grouping, preview, background archive after restart, restore, and a new JSON task.');
} catch (error) { evidence = { ...evidence, passed: false, error: error.message }; console.error(error.stack || error.message); process.exitCode = 1; }
finally {
  if (chrome) await stopChrome(cdp, chrome, exited);
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(runDirectory, 'native-result.json'), JSON.stringify(evidence, null, 2));
  console.log('Evidence:', runDirectory);
}
