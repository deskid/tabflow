#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { runDirectory, findChrome, prepareFixture, reserveDebugPort, connectToChrome, createCDP, evaluator, waitFor, capture, stopChrome } from './test-browser-oauth.mjs';

await mkdir(runDirectory, { recursive: true });
const modelRequests = [];
const modelPrompts = [];
const customPrompt = '仅归档失去用途的测试搜索页。';
let failFirstPreview = true;
let incompletePreview = true;
let holdPreview = false, releasePreview;
const server = createServer(async (request, response) => {
  if (request.url === '/v1/chat/completions') {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); const input = JSON.parse(payload.messages[1].content); modelRequests.push(input); modelPrompts.push(payload.messages[0].content);
    if (failFirstPreview) {
      failFirstPreview = false;
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '预览测试：服务暂时不可用' } })); return;
    }
    if (incompletePreview) {
      incompletePreview = false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"decisions":{}}' } }] })); return;
    }
    if (holdPreview) { holdPreview = false; await new Promise(resolve => { releasePreview = resolve; }); }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decisions: Object.fromEntries(input.candidates.map(tab => [tab.id, {
      action: 'archive', kind: 'temporary', task: '测试资料', reason: '闲置的测试搜索资料',
    }])) }) } }] })); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  response.end(`<title>清理测试资料</title><p>Isolated TabFlow cleanup fixture</p>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome, cdp, exited;
let evidence = { usesExistingProfile: false, realInference: false };
try {
  const executable = await findChrome(); const extensionDirectory = await prepareFixture(); const port = await reserveDebugPort();
  chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-sync',
    '--disable-background-networking', '--enable-unsafe-extension-debugging', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(runDirectory, 'cleanup-profile')}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; chrome.once('error', error => { launchError = error; }); exited = new Promise(resolve => chrome.once('exit', resolve));
  const connection = await connectToChrome(port, () => launchError); cdp = createCDP(connection.socket);
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionDirectory });
  const target = await cdp.send('Target.createTarget', { url: `chrome-extension://${loaded.id}/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId); await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = evaluator(cdp, sessionId);
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=自动清理]"))'), 'cleanup UI');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[aria-label=清理策略] input")).map(input => input.getAttribute("aria-label"))'), ['保守', '均衡', '积极']);
  await evaluate(`(() => { const select=document.querySelector('[name="cleanup-mode"]'); select.value='time'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=闲置时长]"))'), 'time-based controls');
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=清理提示词]"))'), false);
  await evaluate(`(() => { const select=document.querySelector('[name="cleanup-mode"]'); select.value='ai'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=清理提示词]"))'), 'AI prompt controls');
  await evaluate(`(() => { const input=document.querySelector('[aria-label="清理提示词"]'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(customPrompt)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => evaluate(`chrome.storage.local.get('tabflow_cleanup_config').then(data=>data.tabflow_cleanup_config?.prompt===${JSON.stringify(customPrompt)})`), 'persisted cleanup prompt');
  await capture(cdp, sessionId, 'cleanup-compact.png');
  const fixture = await evaluate(`(async () => {
    await chrome.storage.sync.set({ sidetab_settings: { autoGroupNewTabs: false,
      aiSettings: { provider: 'custom', apiEndpoint: ${JSON.stringify(origin + '/v1')}, model: 'fixture' } } });
    const own = await chrome.tabs.getCurrent();
    const first = await chrome.tabs.create({ url: ${JSON.stringify(origin + '/search/one?token=synthetic#private')}, active: false, windowId: own.windowId });
    const second = await chrome.tabs.create({ url: ${JSON.stringify(origin + '/search/two?token=synthetic#private')}, active: false, windowId: own.windowId });
    const pinned = await chrome.tabs.create({ url: ${JSON.stringify(origin + '/pinned')}, active: false, pinned: true, windowId: own.windowId });
    const groupId = await chrome.tabs.group({ tabIds: [first.id, second.id] });
    await chrome.tabGroups.update(groupId, { title: '清理测试组', color: 'blue' });
    const result = await chrome.runtime.sendMessage({ action: 'CLEANUP', command: 'update', patch: { enabled: true, tier: 'conservative' } });
    if (!result.success) throw Error(result.error);
    return { ids: [first.id, second.id], pinnedId: pinned.id, windowId: own.windowId };
  })()`);
  await waitFor(() => evaluate(`Promise.all(${JSON.stringify(fixture.ids)}.map(id => chrome.tabs.get(id))).then(tabs => tabs.every(tab => tab.status === 'complete'))`), 'fixture page loads');
  await evaluate(`(async () => {
    const key = 'tabflow_cleanup_session'; const stored = (await chrome.storage.session.get(key))[key];
    for (const id of ${JSON.stringify(fixture.ids)}) stored.tabs[id].lastUsed = Date.now() - 2 * 3600000;
    stored.resumeAfter = 0; stored.lastScanAt = Date.now(); stored.lastEvaluationAt = 0;
    await chrome.storage.session.set({ [key]: stored });
    const config = (await chrome.storage.local.get('tabflow_cleanup_config')).tabflow_cleanup_config;
    config.notBefore = 0; await chrome.storage.local.set({ tabflow_cleanup_config: config });
  })()`);
  const rootControls = await evaluate(`(() => {const section=document.querySelector('section[aria-label="自动清理"]');return {management:[...section.querySelectorAll('button')].filter(button=>button.textContent==='清理管理').length,hidden:!section.textContent.includes('保护网站')&&!section.textContent.includes('归档记录')&&!section.textContent.includes('暂停 24 小时')&&!section.textContent.includes('查看清理建议')};})()`);
  assert.deepEqual(rootControls,{management:1,hidden:true});
  await capture(cdp, sessionId, 'cleanup-single-entry.png');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='清理管理').click()`);
  await waitFor(()=>evaluate('Boolean(document.querySelector("section[aria-label=清理管理]"))'), 'cleanup management');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='暂停 24 小时').click()`);
  await waitFor(()=>evaluate('document.querySelector("section[aria-label=清理管理]").textContent.includes("已暂停")'), 'paused');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='恢复').click()`);
  await waitFor(()=>evaluate('document.querySelector("section[aria-label=清理管理]").textContent.includes("自动清理中")'), 'resumed');
  await evaluate(`(()=>{const section=document.querySelector('section[aria-label="清理管理"]');[...section.querySelectorAll('summary')].find(el=>el.textContent.includes('保护网站')).click();const input=section.querySelector('[name="hostname"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'protected.example');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('form[aria-label="添加保护网站"]').requestSubmit()`);
  await waitFor(()=>evaluate(`chrome.storage.local.get('tabflow_cleanup_config').then(data=>data.tabflow_cleanup_config.protectedSites.includes('protected.example'))`), 'protected site saved');
  await waitFor(()=>evaluate(`Boolean(document.querySelector('button[aria-label="取消保护 protected.example"]:not(:disabled)'))`), 'protected site action ready');
  await evaluate(`document.querySelector('button[aria-label="取消保护 protected.example"]').click()`);
  await waitFor(()=>evaluate(`chrome.storage.local.get('tabflow_cleanup_config').then(data=>!data.tabflow_cleanup_config.protectedSites.includes('protected.example'))`), 'protected site removed');
  await evaluate(`Array.from(document.querySelectorAll('summary')).find(el=>el.textContent.includes('保护网站')).click();document.activeElement?.blur()`);
  await capture(cdp, sessionId, 'cleanup-management.png');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='查看清理建议').click()`);
  await waitFor(() => evaluate('document.querySelector("section[aria-label=全部页面清理建议] [role=alert]")?.textContent.includes("HTTP 503")'), 'preview error');
  assert.equal(await evaluate(`(() => { const section=document.querySelector('section[aria-label="全部页面清理建议"]'); const message=section.querySelector('[role="alert"]').textContent; return section.textContent.split(message).length-1; })()`), 1, 'preview error must appear once');
  assert.equal(await evaluate(`Promise.all(${JSON.stringify(fixture.ids)}.map(id=>chrome.tabs.get(id))).then(tabs=>tabs.length)`), 2);
  await capture(cdp, sessionId, 'cleanup-preview-error.png');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='重新分析').click()`);
  await waitFor(() => evaluate('document.querySelector("section[aria-label=全部页面清理建议] [role=alert]")?.textContent.includes("当前需要 2 项")'), 'incomplete result error');
  assert.equal(await evaluate(`Promise.all(${JSON.stringify(fixture.ids)}.map(id=>chrome.tabs.get(id))).then(tabs=>tabs.length)`), 2, 'incomplete model output must not close any pages');
  holdPreview = true;
  const previewStarted = performance.now();
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='重新分析').click()`);
  await waitFor(()=>Boolean(releasePreview), 'inference in progress');
  await waitFor(()=>evaluate('document.querySelectorAll("section[aria-label=全部页面清理建议] li").length>=3'), 'immediate page list');
  const firstRowsMs = Math.round(performance.now() - previewStarted);
  const immediate = await evaluate(`({rows:document.querySelectorAll('section[aria-label="全部页面清理建议"] li').length,pending:document.querySelectorAll('section[aria-label="全部页面清理建议"] li[data-cleanup-action="pending"]').length,kept:document.querySelectorAll('section[aria-label="全部页面清理建议"] li[data-cleanup-action="keep"]').length})`);
  assert(immediate.rows>=3); assert.equal(immediate.pending,2); assert(immediate.kept>=1);
  await capture(cdp,sessionId,'cleanup-instant-preview.png');

  await evaluate(`chrome.tabGroups.query({}).then(groups=>chrome.tabGroups.update(groups.find(group=>group.title==='清理测试组').id,{collapsed:true}))`);
  releasePreview();

  await waitFor(() => evaluate('Boolean(document.querySelector("section[aria-label=全部页面清理建议] fieldset")) && !document.querySelector("section[aria-label=全部页面清理建议] [role=alert]") && !document.querySelector("section[aria-label=全部页面清理建议] [role=status]")'), 'successful preview retry');
  const requestsBeforeRepeat = modelRequests.length; const repeatStarted = performance.now();
  const preview = await evaluate(`chrome.runtime.sendMessage({ action: 'CLEANUP', command: 'preview' })`);
  const repeatMs = Math.round(performance.now() - repeatStarted);
  assert.equal(modelRequests.length,requestsBeforeRepeat,'unchanged preview must reuse inference results');
  assert.equal(preview.success, true, preview.error); assert.equal(preview.value.decisions.length, 2);
  const openIds = await evaluate('chrome.tabs.query({windowType:"normal"}).then(tabs=>tabs.map(tab=>tab.id).sort((a,b)=>a-b))');
  assert.deepEqual(preview.value.pages.map(page=>page.id).sort((a,b)=>a-b), openIds);
  assert.equal(preview.value.pages.find(page=>page.id===fixture.pinnedId).reason, '已固定');
  const report = 'section[aria-label="全部页面清理建议"]';
  assert.equal(await evaluate(`document.querySelectorAll('${report} li').length`), openIds.length);
  assert.equal(await evaluate(`document.querySelector('${report}').textContent.includes('保留此标签')`), false);
  await evaluate(`document.querySelector('${report} input[value="archive"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('${report} li').length`), 2);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('${report} li')).every(row=>row.dataset.cleanupAction==='archive')`), true);
  await evaluate(`document.querySelector('${report} input[value="pending"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('${report} li').length`), 0);
  await evaluate(`document.querySelector('${report} input[value="all"]').click()`);
  // Native radio keyboard navigation and native details disclosure must work.
  await evaluate(`document.querySelector('${report} input[value="all"]').focus()`);
  await cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}, sessionId);
  await cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}, sessionId);
  assert.equal(await evaluate(`document.querySelector('${report} input[value="archive"]').checked`), true);
  await evaluate(`document.querySelector('${report} input[value="all"]').click(); document.querySelector('${report} summary').click()`);
  assert.equal(await evaluate(`document.querySelector('${report} details').open`), true);
  await evaluate(`document.querySelector('${report} summary').click()`);
  await evaluate('document.activeElement?.blur()');
  await capture(cdp, sessionId, 'cleanup-overview-light.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width:320,height:800,deviceScaleFactor:1,mobile:false}, sessionId);
  await evaluate(`chrome.storage.sync.get('sidetab_settings').then(data=>chrome.storage.sync.set({sidetab_settings:{...data.sidetab_settings,theme:'dark'}}))`);
  await waitFor(()=>evaluate('document.documentElement.classList.contains("dark")'), 'dark theme');
  await evaluate('new Promise(resolve=>setTimeout(resolve,250))');
  assert.equal(await evaluate(`document.querySelector('${report}').scrollWidth<=document.querySelector('${report}').clientWidth`), true);
  await capture(cdp, sessionId, 'cleanup-overview-dark-320.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width:380,height:900,deviceScaleFactor:1,mobile:false}, sessionId);
  await evaluate(`chrome.storage.sync.get('sidetab_settings').then(data=>chrome.storage.sync.set({sidetab_settings:{...data.sidetab_settings,theme:'light'}}))`);
  await waitFor(()=>evaluate('!document.documentElement.classList.contains("dark")'), 'light theme');
  evidence.preview = {all:openIds.length,archive:2,keep:openIds.length-2,pending:0,complete:true,filtering:true,keyboard:true,narrowLayout:true,stateChangeSurvived:true,singleManagementEntry:true,immediatePreview:{...immediate,firstRowsMs,repeatMs}};
  assert.equal(await evaluate(`Promise.all(${JSON.stringify(fixture.ids)}.map(id => chrome.tabs.get(id))).then(tabs => tabs.length)`), 2);
  await capture(cdp, sessionId, 'cleanup-settings.png');
  // Stop the actual MV3 worker. The alarm must wake it and preserve session timestamps.
  const control = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const controlTarget = await cdp.send('Target.attachToTarget', { targetId: control.targetId, flatten: true });
  await cdp.send('ServiceWorker.enable', {}, controlTarget.sessionId);
  await cdp.send('ServiceWorker.stopAllWorkers', {}, controlTarget.sessionId);
  await evaluate(`(async () => { const key='tabflow_cleanup_session'; const data=(await chrome.storage.session.get(key))[key]; data.lastEvaluationAt=0;
    await chrome.storage.session.set({[key]:data}); await chrome.alarms.create('tabflow-cleanup', {when:Date.now()+100}); })()`);
  const archived = await waitFor(() => evaluate(`chrome.runtime.sendMessage({action:'CLEANUP',command:'view'}).then(reply => reply.value.entries.length === 2 ? reply.value : null)`), 'background automatic archive', 40_000);
  assert(archived.entries.every(entry => entry.state === 'archived'));
  const remaining = await evaluate('chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))');
  assert(fixture.ids.every(id => !remaining.includes(id))); assert(remaining.includes(fixture.pinnedId));
  assert(modelRequests.length >= 1); assert(modelRequests.every(input => input.candidates.every(tab => !tab.url.includes('token=') && !tab.url.includes('#'))));
  assert(modelPrompts.every(prompt => prompt.includes(customPrompt)), 'edited prompt must reach actual model requests');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='返回清理管理').click()`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.startsWith('归档记录')).click()`);
  await waitFor(() => evaluate('document.body.innerText.includes("清理测试组")'), 'archive UI');
  await capture(cdp, sessionId, 'cleanup-archive.png');
  const restored = await evaluate(`chrome.runtime.sendMessage({action:'CLEANUP',command:'restore',ids:${JSON.stringify(archived.entries.map(entry => entry.id))},windowId:${fixture.windowId}})`);
  assert.equal(restored.success, true, restored.error);
  await waitFor(() => evaluate(`chrome.tabs.query({windowId:${fixture.windowId}}).then(tabs=>tabs.filter(tab=>tab.url?.includes('/search/')).length===2)`), 'restored navigation');
  const result = await evaluate(`(async () => { const view=await chrome.runtime.sendMessage({action:'CLEANUP',command:'view'});
    const tabs=await chrome.tabs.query({windowId:${fixture.windowId}}); return { entries:view.value.entries.length,
      protected:view.value.protectedTabIds.length, restored:tabs.filter(tab=>tab.url.includes('/search/')).map(tab=>({url:tab.url,groupId:tab.groupId})) }; })()`);
  assert.equal(result.entries, 0); assert.equal(result.restored.length, 2); assert.equal(result.protected, 2);
  assert.equal(result.restored[0].groupId, result.restored[1].groupId);
  evidence = { ...evidence, passed: true, browser: connection.version.Browser, archived: 2, restored: 2, pinnedPreserved: true, previewNonDestructive: true, sanitizedModelRequests: true, groupRestored: true, workerRestart: true };
  console.log('Cleanup browser smoke passed: preview, automatic AI archive, pinned protection, local recovery and regrouping.');
} catch (error) { evidence = { ...evidence, passed: false, error: error.message }; console.error(error.stack ?? error.message); process.exitCode = 1; }
finally {
  releasePreview?.();
  if (chrome) await stopChrome(cdp, chrome, exited);
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(runDirectory, 'cleanup-result.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${runDirectory}`);
}
