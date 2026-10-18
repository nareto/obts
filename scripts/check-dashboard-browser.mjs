import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createFixtures } from '../tests/fixtures/dashboard.mjs';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const { createServer } = await import(require.resolve('vite'));
const { svelte } = await import(require.resolve('@sveltejs/vite-plugin-svelte'));
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const screenshots = process.env.DASHBOARD_SCREENSHOT_DIR ? resolve(process.env.DASHBOARD_SCREENSHOT_DIR) : null;
if (screenshots) await mkdir(screenshots, {recursive: true});
const cache = await mkdtemp(join(tmpdir(), 'obts-dashboard-browser-'));
const server = await createServer({configFile:false,root:join(root,'frontend/dashboard'),cacheDir:cache,plugins:[svelte()],logLevel:'error',server:{host:'127.0.0.1',port:0}});
let browser;
let failures = 0;
let count = 0;
try {
  await server.listen();
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
  /**
   * Test-script-only stand-in for EventSource (production code has no hooks for it). It never connects or emits by
   * itself: scenarios drive it through `window.__obtsFakeEventSource`, so request counts stay deterministic.
   */
  function installFakeEventSource() {
    const instances = [];
    class FakeEventSource {
      constructor(url, init) {
        this.url = url;
        this.init = init ?? null;
        this.readyState = 0;
        this.closed = false;
        this.listeners = {};
        instances.push(this);
      }
      addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
      removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(candidate => candidate !== listener); }
      close() { this.closed = true; this.readyState = 2; }
    }
    FakeEventSource.CONNECTING = 0;
    FakeEventSource.OPEN = 1;
    FakeEventSource.CLOSED = 2;
    const open = () => instances.filter(instance => !instance.closed);
    const dispatch = (instance, type, event) => { for (const listener of [...(instance.listeners[type] ?? [])]) listener(event); };
    window.EventSource = FakeEventSource;
    window.__obtsFakeEventSource = {
      emit(type, data) {
        for (const instance of open()) {
          if (type === 'refresh' || type === 'invalidate') instance.readyState = 1;
          dispatch(instance, type, {type, data});
        }
      },
      error(fatal = false) {
        for (const instance of open()) {
          instance.readyState = fatal ? 2 : 0;
          dispatch(instance, 'error', {type: 'error'});
        }
      },
      get instanceCount() { return instances.length; },
      get openCount() { return open().length; },
      get urls() { return instances.map(instance => instance.url); },
      get inits() { return instances.map(instance => instance.init); }
    };
  }

  async function scenario(name, run, options = {}) {
    count++;
    const {initialPath = '', prepare, liveMode = 'fake', ...contextOptions} = options;
    const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'en-GB',...contextOptions});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    const fixture = createFixtures();
    await fixture.install(page);
    // liveMode: 'fake' (default) installs the controllable fake; 'none' removes EventSource; 'real' leaves the browser's own.
    if (liveMode === 'fake') await page.addInitScript(installFakeEventSource);
    else if (liveMode === 'none') await page.addInitScript(() => { delete window.EventSource; });
    const es = {
      emit: (type, data) => page.evaluate(([eventType, payload]) => window.__obtsFakeEventSource.emit(eventType, payload), [type, data]),
      invalidate: payload => es.emit('invalidate', typeof payload === 'string' ? payload : JSON.stringify(payload)),
      error: (fatal = false) => page.evaluate(value => window.__obtsFakeEventSource.error(value), fatal),
      counts: () => page.evaluate(() => ({instances: window.__obtsFakeEventSource.instanceCount, open: window.__obtsFakeEventSource.openCount, urls: window.__obtsFakeEventSource.urls, inits: window.__obtsFakeEventSource.inits}))
    };
    if (prepare) await prepare({page, fixture});
    async function capture(name) {
      if (screenshots) await page.screenshot({path: join(screenshots, `${name}.png`), fullPage: true, animations: 'disabled'});
    }
    async function navigate(name) {
      const button = page.locator('nav').getByRole('link',{name:new RegExp(`^${name}`)});
      if (page.viewportSize().width < 1100) {
        await expect(page.locator('.app-sidebar')).toHaveAttribute('inert', '');
        await page.getByRole('button', {name: 'Open navigation', exact: true}).click();
        await expect(page.locator('.app-sidebar')).not.toHaveAttribute('inert', '');
      }
      await button.click();
      await expect(page.getByRole('heading',{name,level:1,exact:true})).toBeVisible();
    }
    try {
      await page.goto(initialPath ? new URL(initialPath, server.resolvedUrls.local[0]).toString() : server.resolvedUrls.local[0]);
      if (!initialPath) {
        await expect(page.getByText('Desktop workstation',{exact:true}).first()).toBeVisible();
        await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
      }
      await run({page,fixture,navigate,context,capture,es});
      assert.deepEqual(errors,[],'No uncaught browser errors');
      assert.deepEqual(fixture.unexpected,[],'All requests use configured fixtures');
      console.log(`PASS ${name}`);
    } catch(error) {
      failures++;
      console.error(`FAIL ${name}\n${error.message}`);
    } finally {await context.close();}
  }

  await scenario('desktop rail hides mobile controls; layouts fit from 320 to 1440px',async({page,navigate,capture})=>{
    await expect(page.locator('.menu-toggle')).toBeHidden();
    await expect(page.locator('.sidebar-close')).toBeHidden();
    for(const width of [1440,1280,1100,1099,1024,768,390,320]) {
      await page.setViewportSize({width,height:900});
      for(const view of ['Overview','Devices']) {
        await navigate(view);
        const layout = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,wrappers:[...document.querySelectorAll('.device-table-wrap')].map(e=>({width:e.clientWidth,scroll:e.scrollWidth}))}));
        assert.ok(layout.scroll<=layout.width+1,`${view} at ${width}: no document overflow`);
        for(const wrapper of layout.wrappers) assert.ok(wrapper.scroll<=wrapper.width+1,`${view} at ${width}: no device overflow`);
        await capture(`${view.toLowerCase()}-${width}-light`);
      }
    }
  });

  await scenario('drawer is inert when closed, traps focus, restores focus and unlocks on desktop',async({page,capture})=>{
    await expect(page.locator('.app-sidebar')).toHaveAttribute('inert','');
    await page.getByRole('button',{name:'Open navigation',exact:true}).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.querySelector('.app-sidebar').contains(document.activeElement)),false);
    await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Primary navigation'});
    await expect(dialog).toBeVisible();
    await capture('navigation-phone-light');
    for(let i=0;i<14;i++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.querySelector('.app-sidebar').contains(document.activeElement)),true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    await page.setViewportSize({width:1440,height:1000});
    await expect(page.locator('.content')).not.toHaveAttribute('inert','');
    await expect(page.locator('.app-sidebar')).not.toHaveAttribute('inert','');
    assert.notEqual(await page.evaluate(()=>document.body.style.overflow),'hidden');
    await expect(page.locator('.menu-toggle')).toBeHidden();
  },{viewport:{width:390,height:844}});

  await scenario('reduced motion disables drawer transition',async({page})=>{
    assert.equal(await page.locator('.app-sidebar').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  },{viewport:{width:390,height:844},reducedMotion:'reduce'});

  await scenario('dark primary button meets contrast on rest and hover',async({page,capture})=>{
    const button=page.getByRole('button',{name:'New vault',exact:true});
    for(const hover of [false,true]) {
      if(hover) await button.hover();
      const colors=await button.evaluate(e=>({foreground:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));
      const luminance=rgb=>rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>c/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0);
      const values=[luminance(colors.foreground),luminance(colors.background)].sort((a,b)=>b-a);
      assert.ok((values[0]+0.05)/(values[1]+0.05)>=4.5,`Primary contrast at ${hover?'hover':'rest'}`);
    }
    await page.mouse.move(0, 0);
    await capture('overview-desktop-dark');
  },{colorScheme:'dark'});

  await scenario('device details retain complete identifiers; action menu supports Escape',async({page,navigate,fixture})=>{
    await navigate('Devices');
    const row=page.locator('.device-row').first();
    await row.locator('.details-button').click();
    await expect(page.locator('.technical-details')).toContainText(fixture.devices[0].last_applied_main);
    const trigger=row.getByRole('button',{name:'Desktop workstation actions',exact:true});
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded','true');
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded','false');
    await expect(trigger).toBeFocused();
  });

  await scenario('device rename retains rejected draft then updates successful response',async({page,navigate,fixture})=>{
    await navigate('Devices');
    await page.getByRole('button',{name:'Desktop workstation actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Rename device',exact:true}).click();
    const input=page.getByRole('textbox',{name:'New name for Desktop workstation',exact:true});
    await expect(input).toBeFocused();
    await input.fill('Writing desk');
    fixture.setFailure({path:'/vaults/sample-vault/devices/sample-device-0',status:400});
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
    await expect(input).toHaveValue('Writing desk');
    fixture.setFailure(null);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.getByText('Writing desk',{exact:true})).toBeVisible();
    assert.equal(fixture.devices[0].device_name,'Writing desk');
  });

  await scenario('device revoke cancels safely, surfaces errors and disables revoked actions',async({page,navigate,fixture})=>{
    await navigate('Devices');
    page.once('dialog',dialog=>dialog.dismiss());
    await page.getByRole('button',{name:'Desktop workstation actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Revoke device',exact:true}).click();
    assert.equal(fixture.requests.some(request=>request.path.endsWith('/revoke')),false);
    fixture.setFailure({path:'/vaults/sample-vault/devices/sample-device-0/revoke',status:503});
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Desktop workstation actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Revoke device',exact:true}).click();
    await expect(page.locator('.action-error')).toContainText('temporarily unavailable');
    fixture.setFailure(null);
    page.once('dialog',dialog=>{assert.match(dialog.message(),/Desktop workstation/);dialog.accept();});
    await page.getByRole('button',{name:'Desktop workstation actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Revoke device',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'Desktop workstation was revoked.'})).toBeVisible();
    await page.getByRole('link',{name:'View revoked devices',exact:true}).click();
    await expect(page.getByRole('button',{name:'Desktop workstation actions',exact:true})).toBeDisabled();
    await expect(page.getByText('Revoked',{exact:true})).toBeVisible();
  });

  {
    let releaseReauth;
    let approvalInput = null;
    const reauthGate = new Promise(resolve => releaseReauth = resolve);
    await scenario('connection reauth freezes its target and traps modal focus', async ({page}) => {
      await page.getByRole('heading', {name: 'Connect Probe vault', exact: true}).waitFor();
      await page.getByLabel('Vault name', {exact: true}).fill('Target A');
      await page.getByRole('button', {name: 'Approve connection', exact: true}).click();
      const modal = page.getByRole('dialog', {name: 'Recent authentication', exact: true});
      await expect(modal).toBeVisible();
      await expect(page.locator('.connection-page')).toHaveAttribute('inert', '');
      await expect(page.getByLabel('Username', {exact: true})).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByRole('button', {name: 'Continue', exact: true})).toBeFocused();
      const destination = page.getByLabel('Vault name', {exact: true});
      await expect(destination).toBeDisabled();
      await destination.evaluate(element => {
        element.removeAttribute('disabled');
        element.value = 'Target B';
        element.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await page.getByLabel('Username', {exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-password');
      const reauthRequest = page.waitForRequest('**/api/v1/auth/reauthenticate');
      await page.getByRole('button', {name: 'Continue', exact: true}).click();
      await reauthRequest;
      await page.getByRole('button', {name: 'Cancel', exact: true}).click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByRole('button', {name: 'Approve connection', exact: true})).toBeFocused();
      releaseReauth();
      await page.waitForTimeout(30);
      assert.equal(approvalInput, null, 'cancelled reauthentication must suppress approval');
    }, {
      viewport: {width: 390, height: 844},
      initialPath: '/connect/demo',
      prepare: async ({page, fixture}) => {
        fixture.routes['/auth/session'].recent_auth_expires_at = '2000-01-01T00:00:00.000Z';
        fixture.routes['/auth/session'].csrf_token = 'initial-csrf';
        await page.route('**/api/v1/connections/demo/review', async route => await route.fulfill({status: 200, json: {
          connection_id: 'demo', verification_code: 'ABCD-EFGH', status: 'pending', plugin_version: '0.3.25', device_name: 'Probe device', local_vault_name: 'Probe vault',
          local_summary: {has_content: true, syncable_file_count: 3, syncable_bytes: 100, has_detached_baseline: false},
          vaults: [{vault_id: 'sample-vault', display_name: 'Personal notes', current_main: fixture.vault.current_main, status: 'active'}]
        }}));
        await page.route('**/api/v1/auth/reauthenticate', async route => {
          await reauthGate;
          await route.fulfill({status: 200, json: {user_id: 'sample-owner', csrf_token: 'rotated-csrf', recent_auth_expires_at: '2099-01-01T00:00:00.000Z'}});
        });
        await page.route('**/api/v1/connections/demo/approve', async route => {
          approvalInput = route.request().postDataJSON();
          await route.fulfill({status: 200, json: {status: 'approved'}});
        });
      }
    });
  }

  {
    let releaseApproval;
    let denyAttempts = 0;
    const approvalGate = new Promise(resolve => releaseApproval = resolve);
    await scenario('connection operations serialize and deny errors remain recoverable', async ({page}) => {
      await page.getByRole('heading', {name: 'Connect Probe vault', exact: true}).waitFor();
      await page.getByRole('button', {name: 'Deny', exact: true}).click();
      await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
      const approvalRequest = page.waitForRequest('**/api/v1/connections/demo/approve');
      await page.getByRole('button', {name: 'Approve connection', exact: true}).click();
      await approvalRequest;
      await expect(page.getByRole('button', {name: 'Deny', exact: true})).toBeDisabled();
      await expect(page.getByRole('button', {name: 'Approve connection', exact: true})).toBeDisabled();
      await expect(page.getByLabel('Vault name', {exact: true})).toBeDisabled();
      const order = await page.locator('.connection-actions button').evaluateAll(buttons => buttons.map(button => ({text: button.textContent?.trim(), top: button.getBoundingClientRect().top})));
      assert.equal(order[0].text, 'Deny');
      assert.equal(order[1].text, 'Approve connection');
      assert.ok(order[0].top < order[1].top, 'mobile visual order must match DOM order');
      releaseApproval();
      await page.getByRole('heading', {name: 'Return to Obsidian', exact: true}).waitFor();
      assert.equal(denyAttempts, 1);
    }, {
      viewport: {width: 390, height: 844},
      initialPath: '/connect/demo',
      prepare: async ({page, fixture}) => {
        await page.route('**/api/v1/connections/demo/review', async route => await route.fulfill({status: 200, json: {
          connection_id: 'demo', verification_code: 'ABCD-EFGH', status: 'pending', plugin_version: '0.3.25', device_name: 'Probe device', local_vault_name: 'Probe vault',
          local_summary: {has_content: true, syncable_file_count: 3, syncable_bytes: 100, has_detached_baseline: false},
          vaults: [{vault_id: 'sample-vault', display_name: 'Personal notes', current_main: fixture.vault.current_main, status: 'active'}]
        }}));
        await page.route('**/api/v1/connections/demo/deny', async route => {
          denyAttempts++;
          await route.fulfill({status: 503, json: {error: {code: 'fixture_unavailable', message: 'The sample server is temporarily unavailable.'}}});
        });
        await page.route('**/api/v1/connections/demo/approve', async route => {
          await approvalGate;
          await route.fulfill({status: 200, json: {status: 'approved'}});
        });
      }
    });
  }

  {
    let releaseReauth;
    const reauthGate = new Promise(resolve => releaseReauth = resolve);
    await scenario('cancelled reauth accepts same-session token but suppresses deletion', async ({page, fixture}) => {
      await page.getByRole('link', {name: 'Settings', exact: true}).click();
      const diagnostics = page.locator('.diagnostics-settings');
      await diagnostics.getByRole('button', {name: 'Delete all diagnostics', exact: true}).click();
      await page.getByLabel('Username', {exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-password');
      const reauthRequest = page.waitForRequest('**/api/v1/auth/reauthenticate');
      await page.getByRole('button', {name: 'Continue', exact: true}).click();
      await reauthRequest;
      await page.getByRole('button', {name: 'Cancel', exact: true}).click();
      releaseReauth();
      await page.waitForTimeout(30);
      assert.equal(fixture.requests.filter(request => request.method === 'DELETE' && request.path === '/diagnostic-events').length, 0);
      page.once('dialog', dialog => void dialog.accept());
      await diagnostics.getByRole('button', {name: 'Delete all diagnostics', exact: true}).click();
      await expect(page.getByRole('status')).toContainText('Deleted');
      const deletion = fixture.requests.filter(request => request.method === 'DELETE' && request.path === '/diagnostic-events').at(-1);
      assert.equal(deletion.csrf, 'rotated-csrf');
    }, {
      prepare: async ({page, fixture}) => {
        fixture.routes['/auth/session'].recent_auth_expires_at = '2000-01-01T00:00:00.000Z';
        fixture.routes['/auth/session'].csrf_token = 'initial-csrf';
        await page.route('**/api/v1/auth/reauthenticate', async route => {
          await reauthGate;
          await route.fulfill({status: 200, json: {user_id: 'sample-owner', csrf_token: 'rotated-csrf', recent_auth_expires_at: '2099-01-01T00:00:00.000Z'}});
        });
      }
    });
  }

  {
    let releaseReauth;
    const reauthGate = new Promise(resolve => releaseReauth = resolve);
    await scenario('old reauth cannot overwrite a new account CSRF token after logout', async ({page, fixture}) => {
      await page.getByRole('link', {name: 'Settings', exact: true}).click();
      const diagnostics = page.locator('.diagnostics-settings');
      await diagnostics.getByRole('button', {name: 'Delete all diagnostics', exact: true}).click();
      await page.getByLabel('Username', {exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-password');
      const reauthRequest = page.waitForRequest('**/api/v1/auth/reauthenticate');
      await page.getByRole('button', {name: 'Continue', exact: true}).click();
      await reauthRequest;
      await page.getByRole('button', {name: 'Cancel', exact: true}).click();
      await page.locator('.app-sidebar').getByRole('button', {name: 'Sign out', exact: true}).click();
      await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
      fixture.routes['/auth/session'] = {...fixture.routes['/auth/session'], csrf_token: 'new-account-csrf', recent_auth_expires_at: '2099-01-01T00:00:00.000Z'};
      await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-password');
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
      await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
      releaseReauth();
      await page.waitForTimeout(30);
      await page.getByRole('link', {name: 'Settings', exact: true}).click();
      const newDiagnostics = page.locator('.diagnostics-settings');
      page.once('dialog', dialog => void dialog.accept());
      await newDiagnostics.getByRole('button', {name: 'Delete all diagnostics', exact: true}).click();
      await expect(page.getByRole('status')).toContainText('Deleted');
      const deletion = fixture.requests.filter(request => request.method === 'DELETE' && request.path === '/diagnostic-events').at(-1);
      assert.equal(deletion.csrf, 'new-account-csrf');
    }, {
      prepare: async ({page, fixture}) => {
        fixture.routes['/auth/session'].recent_auth_expires_at = '2000-01-01T00:00:00.000Z';
        fixture.routes['/auth/session'].csrf_token = 'old-session-csrf';
        await page.route('**/api/v1/auth/reauthenticate', async route => {
          await reauthGate;
          await route.fulfill({status: 200, json: {user_id: 'sample-owner', csrf_token: 'old-reauth-csrf', recent_auth_expires_at: '2099-01-01T00:00:00.000Z'}});
        });
      }
    });
  }

  await scenario('vault switch clears visible history and rejects a delayed history response',async({page,navigate})=>{
    await navigate('History');
    await page.getByRole('textbox',{name:'Path',exact:true}).fill('Notes/Sample.md');
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await expect(page.locator('.preview')).toContainText('Sample content from vault A');
    let release;
    const gate=new Promise(resolve=>release=resolve);
    await page.route('**/api/v1/vaults/sample-vault/history/version',async route=>{await gate;await route.fulfill({status:200,json:{path:'Notes/Sample.md',commit:'a'.repeat(40),content:'Delayed vault A content',source_diff:'Delayed vault A content',rendered_markdown_diff:null,metadata_only:false,content_redacted:false}});});
    const requested=page.waitForRequest('**/api/v1/vaults/sample-vault/history/version');
    await page.locator('.timeline button').first().click();
    await requested;
    await page.getByRole('combobox',{name:'Current vault',exact:true}).selectOption('old-test-vault');
    release();
    await expect(page.locator('.preview')).not.toContainText('vault A');
    await expect(page.locator('.timeline')).not.toContainText('update');
  });

  await scenario('background refresh preserves a draft but invalidates a removed conflict',async({page,navigate,fixture})=>{
    await navigate('Conflicts');
    await page.locator('.resolution-policy select').selectOption('manual');
    const draft=page.locator('.manual-file-editor textarea').first();
    await draft.fill('Unsubmitted sample draft');
    fixture.routes['/vaults/sample-vault/conflicts']={conflicts:[]};
    const refreshed=page.waitForResponse(response=>response.url().endsWith('/dashboard'));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(page.getByRole('button',{name:'Refresh review',exact:true})).toBeVisible();
    await expect(draft).toHaveValue('Unsubmitted sample draft');
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Review result',exact:true})).toHaveCount(0);
  });

  await scenario('result review gates apply and candidate edits invalidate the reviewed result',async({page,navigate,fixture})=>{
    await navigate('Conflicts');
    await expect(page.locator('.diff-source-legend')).toContainText('Server main');
    await expect(page.locator('.diff-source-legend')).toContainText('Device: Travel laptop');
    await expect(page.locator('.diff-source-legend')).toContainText('Colors identify versions');
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toHaveCount(0);
    await page.locator('.resolution-policy select').selectOption('use_device');
    const previewRequest=page.waitForRequest(request=>request.url().endsWith('/preview'));
    await page.getByRole('button',{name:'Review result',exact:true}).click();
    const previewBody=(await previewRequest).postDataJSON();
    assert.equal(previewBody.resolution_kind,'use_device');
    assert.equal(previewBody.expected_main,fixture.vault.current_main);
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toBeVisible();
    await expect(page.locator('.conflict-result')).toContainText('Nothing is applied until you choose Apply resolution');
    await expect(page.locator('.conflict-result')).toContainText('Solaris');
    await expect(page.locator('.conflict-result')).not.toContainText('Piranesi');
    await page.getByRole('button',{name:'Compare',exact:true}).click();
    await page.locator('.resolution-policy select').selectOption('keep_server');
    await expect(page.getByRole('button',{name:'Review result',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Result',exact:true}).click();
    await expect(page.locator('.conflict-result')).toContainText('Piranesi');
    const resolveRequest=page.waitForRequest(request=>request.url().endsWith('/resolve'));
    await page.getByRole('button',{name:'Apply resolution',exact:true}).click();
    const resolveBody=(await resolveRequest).postDataJSON();
    assert.equal(resolveBody.resolution_kind,'keep_server');
    assert.equal(resolveBody.expected_tree,'e'.repeat(40));
    await expect(page.locator('.notice')).toContainText('Conflict resolved');
  });

  await scenario('failed result review keeps the draft and never enables apply',async({page,navigate,fixture})=>{
    await navigate('Conflicts');
    await page.locator('.resolution-policy select').selectOption('manual');
    const draft=page.locator('.manual-file-editor textarea').first();
    await draft.fill('Draft final content');
    fixture.setFailure({path:'/vaults/sample-vault/conflicts/sample-conflict/preview',status:503});
    await page.getByRole('button',{name:'Review result',exact:true}).click();
    await expect(page.locator('.resolution-banner.warning')).toContainText('temporarily unavailable');
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toHaveCount(0);
    await expect(draft).toHaveValue('Draft final content');
    fixture.setFailure(null);
    await page.getByRole('button',{name:'Review result',exact:true}).click();
    await expect(page.locator('.conflict-result')).toContainText('Draft final content');
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toBeVisible();
  });

  await scenario('line selections preview the assembled final text with newlines preserved',async({page,navigate})=>{
    await navigate('Conflicts');
    await page.getByRole('button',{name:'Line by line',exact:true}).click();
    await page.getByRole('button',{name:'All device',exact:true}).first().click();
    await page.getByRole('button',{name:/^Use server for /u}).first().click();
    const previewRequest=page.waitForRequest(request=>request.url().endsWith('/preview'));
    await page.getByRole('button',{name:'Review result',exact:true}).click();
    const previewBody=(await previewRequest).postDataJSON();
    assert.equal(previewBody.resolution_kind,'manual');
    const first=previewBody.manual_files['Projects/Weekend plans.md'];
    assert.ok(first.includes('Visit the market on Saturday'),'server line choice is preserved');
    assert.ok(!first.includes('Visit the market on Sunday'),'overridden device line is replaced');
    assert.ok(first.endsWith('\n'),'final newline is preserved');
    assert.ok(previewBody.manual_files['Notes/Reading list.md'].includes('Solaris'));
    await expect(page.getByRole('button',{name:'Apply resolution',exact:true})).toBeVisible();
  });

  await scenario('long conflict files show GitHub-style hunks with expandable unchanged context',async({page,navigate})=>{
    const favicon=page.locator('link[rel="icon"]');
    await expect(favicon).toHaveAttribute('type','image/svg+xml');
    const faviconResponse=await page.request.get(await favicon.evaluate(link=>link.href));
    assert.equal(faviconResponse.status(),200,'favicon is served');
    assert.match(await faviconResponse.text(),/<svg/u);
    await navigate('Conflicts');
    const file=page.locator('.conflict-file').first();
    await expect(file.locator('.diff-code-row')).toHaveCount(17);
    await expect(file.locator('.diff-hunk-header')).toHaveCount(3);
    await expect(file.locator('.diff-hunk-header').first()).toContainText('Server main lines 40–46');
    await expect(file.locator('.diff-hunk-header').first()).toContainText('39 unchanged lines hidden');
    await expect(file.getByText('Long intro 1:',{exact:false})).toHaveCount(0);
    await file.getByRole('button',{name:/^Show 39 unchanged lines \(Server main lines 1–39/u}).click();
    await expect(file.locator('.diff-code-row')).toHaveCount(56);
    await expect(file.getByText('Long intro 1: unchanged',{exact:false})).toBeVisible();
    await expect(file.locator('.diff-code-row').first().locator('.line-number').first()).toHaveText('1');
    await page.getByRole('button',{name:'Line by line',exact:true}).click();
    await expect(file.locator('.diff-code-row')).toHaveCount(56);
    await page.getByRole('button',{name:'All device',exact:true}).first().click();
    const previewRequest=page.waitForRequest(request=>request.url().endsWith('/preview'));
    await page.getByRole('button',{name:'Review result',exact:true}).click();
    const first=(await previewRequest).postDataJSON().manual_files['Projects/Weekend plans.md'];
    assert.ok(first.includes('Long body 30: unchanged'),'hidden context is still part of the assembled file');
    assert.ok(first.includes('- Plan the trip on Sunday') && first.includes('- Another device idea'));
    assert.ok(!first.includes('Saturday'));
  },{prepare:async({fixture})=>{
    const lines=(count,prefix)=>Array.from({length:count},(_,index)=>`${prefix} ${index+1}: unchanged note text.`);
    const head=['# Weekly review','',...lines(40,'Long intro')];
    const middle=lines(60,'Long body');
    const tail=lines(40,'Long footer');
    const review=fixture.routes['/vaults/sample-vault/conflicts/sample-conflict'];
    review.files[0]={...review.files[0],
      server_content:[...head,'- Plan the trip on Saturday',...middle,'## Ideas','- Server-side idea',...tail].join('\n')+'\n',
      device_content:[...head,'- Plan the trip on Sunday',...middle,'## Ideas','- Device-side idea','- Another device idea',...tail].join('\n')+'\n'};
  }});

  await scenario('manual refresh owns its request; a focus trigger waits and runs once as the trailing refresh',async({page,fixture})=>{
    const dashboardGets=()=>fixture.requests.filter(request=>request.path.endsWith('/dashboard')).length;
    const before=dashboardGets();
    fixture.setDelay(200);
    const requested=page.waitForRequest('**/api/v1/vaults/sample-vault/dashboard');
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await requested;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal(dashboardGets(),before+1,'focus during a manual refresh never starts a concurrent or superseding request');
    await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
    await expect.poll(dashboardGets).toBe(before+2);
    await page.waitForTimeout(500);
    assert.equal(dashboardGets(),before+2,'repeated focus triggers collapse into exactly one trailing refresh');
  });

  await scenario('manual refresh 401 exits authenticated UI without uncaught errors',async({page,fixture})=>{
    fixture.setFailure({path:'/vaults/sample-vault/dashboard',status:401});
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
    await expect(page.locator('.shell')).toHaveCount(0);
  });

  await scenario('pending logout blocks sign-in; login selects only a newly authorized vault', async ({page, fixture}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/auth/logout', async route => {
      await gate;
      await route.fulfill({status: 200, json: {status: 'ok'}});
    });
    try {
      await page.getByRole('button', {name: 'Sign out', exact: true}).click();
      const signIn = page.getByRole('button', {name: 'Sign in', exact: true});
      await expect(signIn).toBeDisabled();
      await expect(page.locator('.shell')).toHaveCount(0);
      fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
      release();
      await expect(signIn).toBeEnabled();
      await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-only');
      await signIn.click();
      await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
      await expect(page.locator('.header-context')).toContainText('Old test vault');
      await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
    } finally { release(); }
  });

  await scenario('failed logout clears the local view and exposes an honest retry', async ({page, fixture}) => {
    fixture.setFailure({path: '/auth/logout', status: 503});
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await expect(page.locator('.shell')).toHaveCount(0);
    await expect(page.locator('.auth')).toContainText('server sign-out failed');
    fixture.setFailure(null);
    await page.getByRole('button', {name: 'Retry sign out', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
    await expect(page.getByRole('button', {name: 'Retry sign out', exact: true})).toHaveCount(0);
  });

  await scenario('an old account 401 cannot sign out a newly authenticated account', async ({page, fixture}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/sample-vault/dashboard', async route => {
      await gate;
      await route.fulfill({status: 401, json: {error: {code: 'expired_session', message: 'Previous session ended.'}}});
    });
    try {
      const pending = page.waitForRequest('**/api/v1/vaults/sample-vault/dashboard');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await pending;
      await page.getByRole('button', {name: 'Sign out', exact: true}).click();
      const signIn = page.getByRole('button', {name: 'Sign in', exact: true});
      await expect(signIn).toBeEnabled();
      fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
      await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-only');
      await signIn.click();
      await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
      const response = page.waitForResponse('**/api/v1/vaults/sample-vault/dashboard');
      release();
      await response;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
      await expect(page.locator('.action-error')).toHaveCount(0);
      await expect(page.locator('.auth')).toHaveCount(0);
    } finally { release(); }
  });

  await scenario('failed conflict selection never leaves another review submittable', async ({page, fixture, navigate}) => {
    const other = {...fixture.conflict, conflict_id: 'other-conflict', affected_paths: ['Notes/Other.md']};
    fixture.routes['/vaults/sample-vault/conflicts'] = {conflicts: [fixture.conflict, other]};
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
    await navigate('Conflicts');
    fixture.setFailure({path: '/vaults/sample-vault/conflicts/other-conflict', status: 503});
    await page.getByRole('combobox', {name: 'Current review', exact: true}).selectOption('other-conflict');
    await expect(page.locator('.action-error')).toContainText('temporarily unavailable');
    await expect(page.locator('.conflict-workbench')).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Review result', exact: true})).toHaveCount(0);
  });

  await scenario('late same-target conflict response cannot overwrite a newer selection', async ({page, fixture, navigate}) => {
    const other = {...fixture.conflict, conflict_id: 'other-conflict'};
    fixture.routes['/vaults/sample-vault/conflicts'] = {conflicts: [fixture.conflict, other]};
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
    await navigate('Conflicts');
    let release;
    let requests = 0;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/sample-vault/conflicts/other-conflict', async route => {
      const first = ++requests === 1;
      if (first) await gate;
      const files = fixture.review.files.map(file => ({...file, server_content: first ? 'Superseded B snapshot' : 'Newest B snapshot'}));
      await route.fulfill({status: 200, json: {...fixture.review, conflict: other, files}});
    });
    try {
      const select = page.getByRole('combobox', {name: 'Current review', exact: true});
      const pending = page.waitForRequest('**/api/v1/vaults/sample-vault/conflicts/other-conflict');
      await select.selectOption('other-conflict');
      await pending;
      await select.selectOption('sample-conflict');
      await expect(page.locator('.conflict-workbench')).toBeVisible();
      await select.selectOption('other-conflict');
      await expect(page.locator('.conflict-workbench')).toContainText('Newest B snapshot');
      const response = page.waitForResponse('**/api/v1/vaults/sample-vault/conflicts/other-conflict');
      release();
      await response;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(page.locator('.conflict-workbench')).toContainText('Newest B snapshot');
      await expect(page.locator('.conflict-workbench')).not.toContainText('Superseded B snapshot');
    } finally { release(); }
  });

  await scenario('a delayed review cannot resurrect a conflict invalidated by polling', async ({page, fixture, navigate}) => {
    await navigate('Conflicts');
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/sample-vault/conflicts/sample-conflict', async route => {
      await gate;
      await route.fulfill({status: 200, json: fixture.review});
    });
    try {
      await page.getByRole('button', {name: 'Browse queue', exact: true}).click();
      const pending = page.waitForRequest('**/api/v1/vaults/sample-vault/conflicts/sample-conflict');
      await page.locator('.conflict-queue-list').getByRole('button', {name: 'Review', exact: true}).click();
      await pending;
      fixture.routes['/vaults/sample-vault/conflicts'] = {conflicts: []};
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.locator('.action-error')).toContainText('no longer available');
      const response = page.waitForResponse('**/api/v1/vaults/sample-vault/conflicts/sample-conflict');
      release();
      await response;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(page.getByRole('button', {name: 'Refresh review', exact: true})).toBeVisible();
      await expect(page.getByRole('button', {name: 'Review result', exact: true})).toHaveCount(0);
    } finally { release(); }
  });

  await scenario('an old account vault creation cannot populate a new session', async ({page, fixture}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await gate;
      await route.fulfill({status: 200, json: {...fixture.vault, vault_id: 'late-created-vault', display_name: 'Old account creation'}});
    });
    try {
      await page.getByRole('button', {name: 'New vault', exact: true}).click();
      await page.getByRole('textbox', {name: 'Vault name', exact: true}).fill('Old account creation');
      const pending = page.waitForRequest(request => request.url().endsWith('/vaults') && request.method() === 'POST');
      await page.getByRole('button', {name: 'Create vault', exact: true}).click();
      await pending;
      fixture.setFailure({path: '/vaults/sample-vault/dashboard', status: 401});
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const signIn = page.getByRole('button', {name: 'Sign in', exact: true});
      await expect(signIn).toBeEnabled();
      fixture.setFailure(null);
      fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
      await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-only');
      await signIn.click();
      await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
      const response = page.waitForResponse(response => response.url().endsWith('/vaults') && response.request().method() === 'POST');
      release();
      await response;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const vaults = page.getByRole('combobox', {name: 'Current vault', exact: true});
      await expect(vaults).toHaveValue('old-test-vault');
      await expect(vaults.locator('option')).toHaveCount(1);
    } finally { release(); }
  });

  await scenario('device rename supersedes an older dashboard snapshot', async ({page, fixture, navigate}) => {
    await navigate('Devices');
    const old = structuredClone(fixture.summary);
    let release;
    let requests = 0;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/sample-vault/dashboard', async route => {
      const first = ++requests === 1;
      if (first) await gate;
      await route.fulfill({status: 200, json: first ? old : fixture.summary});
    });
    try {
      const pending = page.waitForRequest('**/api/v1/vaults/sample-vault/dashboard');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await pending;
      await page.getByRole('button', {name: 'Desktop workstation actions', exact: true}).click();
      await page.getByRole('menuitem', {name: 'Rename device', exact: true}).click();
      await page.getByRole('textbox', {name: 'New name for Desktop workstation', exact: true}).fill('Writing desk');
      await page.getByRole('button', {name: 'Save', exact: true}).click();
      await expect(page.getByText('Writing desk', {exact: true})).toBeVisible();
      const response = page.waitForResponse('**/api/v1/vaults/sample-vault/dashboard');
      release();
      await response;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(page.getByText('Writing desk', {exact: true})).toBeVisible();
    } finally { release(); }
  });

  await scenario('breakpoint changes hand keyboard focus to visible controls', async ({page}) => {
    await page.locator('nav').getByRole('link', {name: 'Devices', exact: true}).focus();
    await page.setViewportSize({width: 390, height: 844});
    await expect(page.getByRole('button', {name: 'Open navigation', exact: true})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', {name: 'Close navigation', exact: true})).toBeFocused();
    await page.setViewportSize({width: 1440, height: 1000});
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeFocused();
  });

  await scenario('remaining pages stay compact and fit responsive widths', async ({page, navigate, capture}) => {
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      for (const view of ['History', 'Maintenance', 'Settings']) {
        await navigate(view);
        if (view === 'Settings' && (width === 1440 || width === 390)) await capture(`settings-${width}-light`);
        const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
        assert.ok(layout.scroll <= layout.width + 1, `${view} at ${width}: no document overflow`);
      }
    }
  });

  await scenario('conflict workbench stays readable without document overflow at narrow widths', async ({page, navigate}) => {
    await navigate('Conflicts');
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(layout.scroll <= layout.width + 1, `Conflicts at ${width}: no document overflow`);
      await expect(page.locator('.diff-source-legend')).toBeVisible();
      await expect(page.getByRole('button', {name: 'Review result', exact: true})).toBeVisible();
    }
  });

  await scenario('history search preserves an actionable error state', async ({page, navigate, fixture}) => {
    await navigate('History');
    await page.getByRole('textbox', {name: 'Path', exact: true}).fill('Notes/Missing.md');
    fixture.setFailure({path: '/vaults/sample-vault/history/query', status: 503});
    await page.getByRole('button', {name: 'Search', exact: true}).click();
    await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
    await expect(page.getByRole('heading', {name: 'Preview', exact: true})).toBeVisible();
    fixture.setFailure(null);
  });

  await scenario('history redaction requires an explicit reveal action', async ({page, navigate, fixture}) => {
    let requests = 0;
    await page.route('**/api/v1/vaults/sample-vault/history/version', async route => {
      requests++;
      await route.fulfill({status: 200, json: {
        path: 'Notes/Sample.md',
        commit: fixture.vault.current_main,
        content: requests > 1 ? 'Revealed sample content' : null,
        source_diff: requests > 1 ? 'Revealed sample content' : '',
        rendered_markdown_diff: null,
        metadata_only: false,
        content_redacted: requests === 1
      }});
    });
    await navigate('History');
    await page.getByRole('textbox', {name: 'Path', exact: true}).fill('Notes/Sample.md');
    await page.getByRole('button', {name: 'Search', exact: true}).click();
    await expect(page.getByText('Plugin content is redacted', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Reveal plugin content', exact: true}).click();
    await expect(page.getByText('Revealed sample content', {exact: true})).toBeVisible();
  });

  await scenario('history restore confirms the exact target and records success', async ({page, navigate, fixture}) => {
    await page.route('**/api/v1/vaults/sample-vault/history/restore', async route => {
      await route.fulfill({status: 200, json: {restore_commit: '3'.repeat(40), main: fixture.vault.current_main, source_path: 'Notes/Sample.md'}});
    });
    await navigate('History');
    await page.getByRole('textbox', {name: 'Path', exact: true}).fill('Notes/Sample.md');
    await page.getByRole('button', {name: 'Search', exact: true}).click();
    const restore = page.getByRole('button', {name: 'Restore this version', exact: true});
    await expect(restore).toBeVisible();
    page.once('dialog', dialog => {
      assert.match(dialog.message(), /Notes\/Sample\.md/);
      assert.match(dialog.message(), new RegExp(fixture.vault.current_main));
      assert.match(dialog.message(), /new history entry/);
      void dialog.accept();
    });
    await restore.click();
    await expect(page.getByRole('status')).toContainText('Note restored.');
  });

  await scenario('history controls remain keyboard reachable on mobile', async ({page, navigate}) => {
    await navigate('History');
    const path = page.getByRole('textbox', {name: 'Path', exact: true});
    await path.fill('Notes/Sample.md');
    await path.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', {name: 'Search', exact: true})).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(path).toBeFocused();
  }, {viewport: {width: 390, height: 844}});

  await scenario('diagnostics refresh and pagination retain consented event provenance', async ({page, navigate, fixture}) => {
    const event = (code, id) => ({event_id: id, plugin_version: '0.3.25', obsidian_version: '1.8.0', platform_family: 'linux', flow: 'sync', stage: 'upload', failure_code: code, error_class: 'network', retryable: true, breadcrumbs: [], received_at: new Date().toISOString()});
    fixture.routes['/diagnostic-events'] = {ingestion_enabled: true, retention_days: 30, events: [event('page_one', 'diagnostic-one')], next_cursor: 'page-2'};
    await navigate('Settings');
    const diagnostics = page.locator('.diagnostics-settings');
    await diagnostics.getByRole('button', {name: 'Refresh', exact: true}).click();
    await expect(diagnostics).toContainText('page one');
    await page.route(url => new URL(url).pathname.endsWith('/diagnostic-events') && new URL(url).searchParams.get('cursor') === 'page-2', async route => {
      await route.fulfill({status: 200, json: {ingestion_enabled: true, retention_days: 30, events: [event('page_two', 'diagnostic-two')], next_cursor: null}});
    });
    await diagnostics.getByRole('button', {name: 'Load more', exact: true}).click();
    await expect(diagnostics).toContainText('page two');
    await expect(diagnostics).toContainText('30 days');
  });

  await scenario('delayed diagnostics from the previous account cannot repopulate the new session', async ({page, navigate, fixture}) => {
    let release;
    let first = true;
    const gate = new Promise(resolve => release = resolve);
    const event = (code, id) => ({event_id: id, plugin_version: '0.3.25', obsidian_version: '1.8.0', platform_family: 'linux', flow: 'sync', stage: 'upload', failure_code: code, error_class: 'network', retryable: true, breadcrumbs: [], received_at: new Date().toISOString()});
    await page.route('**/api/v1/diagnostic-events', async route => {
      if (!first) return route.fallback();
      first = false;
      await gate;
      await route.fulfill({status: 200, json: {ingestion_enabled: true, retention_days: 30, events: [event('old_account', 'old-diagnostic')], next_cursor: null}});
    });
    try {
      const pending = page.waitForRequest('**/api/v1/diagnostic-events');
      await navigate('Settings');
      const diagnostics = page.locator('.diagnostics-settings');
      await pending;
      await page.locator('.app-sidebar').getByRole('button', {name: 'Sign out', exact: true}).click();
      await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
      fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
      fixture.routes['/diagnostic-events'] = {ingestion_enabled: true, retention_days: 30, events: [event('new_account', 'new-diagnostic')], next_cursor: null};
      await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
      await page.getByLabel('Password', {exact: true}).fill('fixture-only');
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
      await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
      release();
      await navigate('Settings');
      await expect(diagnostics).toContainText('new account');
      await expect(diagnostics).not.toContainText('old account');
    } finally { release(); }
  });

  await scenario('vault sync rules preview and save use a reviewed snapshot', async ({page, fixture, capture, navigate}) => {
    await navigate('Settings');
    const panel = page.locator('.vault-sync-settings');
    await expect(panel).toContainText('Sync rules');
    await capture('settings-desktop-light');
    await page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true}).check();
    await page.getByRole('textbox', {name: 'Excluded files and folders', exact: true}).fill('private/\n');
    await expect(page.getByRole('textbox', {name: /Frontmatter fields/u})).toHaveAttribute('placeholder', 'updated\nmodified');
    await page.getByRole('textbox', {name: /Frontmatter fields/u}).fill('updated');
    await page.getByRole('button', {name: 'Preview changes', exact: true}).click();
    await expect(panel).toContainText('Preview is current');
    await expect.poll(() => fixture.requests.some(request => request.path.endsWith('/sync-settings/preview'))).toBe(true);
    fixture.setFailure({path:'/vaults/sample-vault/sync-settings',status:409});
    await page.getByRole('button', {name: 'Save settings', exact: true}).click();
    await expect(panel).toContainText('temporarily unavailable');
    await expect(panel).not.toContainText('Settings saved.');
    await expect(page.getByRole('textbox', {name: 'Excluded files and folders', exact: true})).toHaveValue('private/\n');
    await expect(page.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
    fixture.setFailure(null);
    await page.getByRole('button', {name: 'Save settings', exact: true}).click();
    await expect(panel).toContainText('Settings saved.');
    await page.setViewportSize({width: 390, height: 844});
    await capture('settings-mobile-light');
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 391, 'Settings fit mobile viewport');
  });

  await scenario('newer main invalidates a settings preview without erasing its draft', async ({page, fixture, navigate}) => {
    await navigate('Settings');
    await page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true}).check();
    await page.getByRole('textbox', {name: 'Excluded files and folders', exact: true}).fill('private/\n');
    await page.getByRole('button', {name: 'Preview changes', exact: true}).click();
    await expect(page.locator('.settings-preview')).toBeVisible();
    fixture.summary.vault.current_main = 'c'.repeat(40);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dashboard'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(page.locator('.vault-sync-settings')).toContainText('Vault main advanced');
    await expect(page.getByRole('textbox', {name: 'Excluded files and folders', exact: true})).toHaveValue('private/\n');
    await expect(page.getByRole('button', {name: 'Save settings', exact: true})).toBeDisabled();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', {name: 'Reload settings', exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'Excluded files and folders', exact: true})).toHaveValue('private/\n');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', {name: 'Reload settings', exact: true}).click();
    await expect(page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true})).not.toBeChecked();
  });

  await scenario('a previous vault preview cannot publish results or clear a newer busy request', async ({page, fixture, navigate}) => {
    let releaseOld;
    let releaseNew;
    const oldGate = new Promise(resolve => releaseOld = resolve);
    const newGate = new Promise(resolve => releaseNew = resolve);
    await page.route('**/api/v1/vaults/*/sync-settings/preview', async route => {
      const body = route.request().postDataJSON();
      const old = new URL(route.request().url()).pathname.includes('/sample-vault/');
      await (old ? oldGate : newGate);
      await route.fulfill({status: 200, json: {
        vault_id: old ? 'sample-vault' : 'old-test-vault', expected_main: body.expected_main,
        expected_root_ignore_oid: null, preview_tree: 'b'.repeat(40), review_fingerprint: 'c'.repeat(64),
        root_ignore_oid: null, affected_paths: old ? ['old-private.md'] : [], affected_directories: [],
        metadata_conflict_rules: body.metadata_conflict_rules, changes_main: false
      }});
    });
    try {
      await navigate('Settings');
      const oldRequest = page.waitForRequest('**/vaults/sample-vault/sync-settings/preview');
      await page.getByRole('button', {name: 'Preview changes', exact: true}).click();
      await oldRequest;
      await page.getByRole('combobox', {name: 'Current vault', exact: true}).selectOption('old-test-vault');
      const newerRequest = page.waitForRequest('**/vaults/old-test-vault/sync-settings/preview');
      await page.getByRole('button', {name: 'Preview changes', exact: true}).click();
      await newerRequest;
      const oldResponse = page.waitForResponse('**/vaults/sample-vault/sync-settings/preview');
      releaseOld();
      await oldResponse;
      await page.waitForTimeout(30);
      await expect(page.getByRole('button', {name: 'Preview changes', exact: true})).toBeDisabled();
      await expect(page.getByRole('button', {name: 'Save settings', exact: true})).toBeDisabled();
      await expect(page.locator('.vault-sync-settings')).not.toContainText('old-private.md');
      releaseNew();
      await expect(page.getByRole('button', {name: 'Preview changes', exact: true})).toBeEnabled();
      await expect(page.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
    } finally { releaseOld(); releaseNew(); }
  });

  await scenario('blocked vault settings explain why editing is unavailable', async ({page, navigate}) => {
    await navigate('Settings');
    await expect(page.locator('.vault-sync-settings')).toContainText('vault is blocked');
    await expect(page.getByRole('button', {name: 'Reload settings', exact: true})).toBeDisabled();
    await expect(page.getByRole('textbox', {name: /Frontmatter fields/u})).toHaveCount(0);
  }, {prepare: async ({fixture}) => { fixture.vault.status = 'blocked_integrity'; }});

  await scenario('vault query deep links select only an owned vault and open Settings', async ({page}) => {
    await page.goto(new URL('/?vault=old-test-vault', server.resolvedUrls.local[0]).toString());
    await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
  });

  await scenario('vault deletion requires the exact full-ID phrase and states server-only consequences', async ({page, fixture}) => {
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    const settings = page.locator('.deletion-settings');
    await expect(settings).toContainText('Personal notes');
    await expect(settings).toContainText('sample-vault');
    await settings.getByRole('button', {name: 'Delete this server vault', exact: true}).click();
    const modal = page.getByRole('dialog', {name: 'Delete server vault?', exact: true});
    await expect(page.locator('.shell')).toHaveAttribute('inert', '');
    await expect(modal.getByRole('textbox', {name: 'Type DELETE sample-vault', exact: true})).toBeFocused();
    await modal.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(modal).toHaveCount(0);
    await expect(settings.getByRole('button', {name: 'Delete this server vault', exact: true})).toBeFocused();
    await settings.getByRole('button', {name: 'Delete this server vault', exact: true}).click();
    await expect(modal).toContainText('Git content and history');
    await expect(modal).toContainText('transfers and temporary material');
    await expect(modal).toContainText('devices, tokens, connections, and vault diagnostics');
    await expect(modal).toContainText('local client files, independent Bridge state, and existing backups');
    await expect(modal).toContainText('without a password or recent-authentication step');
    const confirmation = modal.getByRole('textbox', {name: 'Type DELETE sample-vault', exact: true});
    const submit = modal.getByRole('button', {name: 'Delete server vault', exact: true});
    await expect(confirmation).toHaveValue('');
    await expect(submit).toBeDisabled();
    await confirmation.fill('DELETE sample-vault-typo');
    assert.equal(fixture.requests.filter(request => request.method === 'DELETE' && request.path === '/vaults/sample-vault').length, 0);
    await confirmation.fill('DELETE sample-vault');
    await expect(submit).toBeEnabled();
    const deletionRequest = page.waitForRequest(request => request.method() === 'DELETE' && new URL(request.url()).pathname.endsWith('/vaults/sample-vault'));
    await submit.click();
    await deletionRequest;
    const request = fixture.requests.find(request => request.method === 'DELETE' && request.path === '/vaults/sample-vault');
    assert.deepEqual(request.body, {confirmation: 'DELETE sample-vault'});
    assert.equal(fixture.requests.some(request => request.path === '/auth/reauthenticate'), false, 'deletion does not request recent authentication');
    await expect(modal).toHaveCount(0);
    await expect(page.getByText('Vault deletion accepted.', {exact: false})).toBeVisible();
    await expect(page.locator('.deletion-status-list')).toContainText('Deleting');
    await expect(page.locator('.deletion-status-list')).toContainText('not yet confirmed');
  });

  await scenario('completed deletion clears target presentation and selects another active vault', async ({page, fixture, navigate}) => {
    await navigate('History');
    await page.getByRole('textbox', {name: 'Path', exact: true}).fill('Notes/Sample.md');
    await page.getByRole('button', {name: 'Search', exact: true}).click();
    await expect(page.locator('.preview')).toContainText('Sample content from vault A');
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await page.locator('.deletion-settings').getByRole('button', {name: 'Delete this server vault', exact: true}).click();
    await page.getByRole('textbox', {name: 'Type DELETE sample-vault', exact: true}).fill('DELETE sample-vault');
    await page.getByRole('button', {name: 'Delete server vault', exact: true}).click();
    await expect(page.locator('.deletion-status-list')).toContainText('Deleting');
    fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
    fixture.setDeletionStatus([{vault_id: 'sample-vault', status: 'deleted', requested_at: new Date(Date.now() - 1000).toISOString(), completed_at: new Date().toISOString(), receipt_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), retry_at: null, error_code: null}]);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/vault-deletions'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
    await expect(page.locator('.preview')).toHaveCount(0);
    await expect(page.locator('.deletion-status-list')).toContainText('Completed deletion receipt');
    await expect(page.locator('.deletion-status-list')).toContainText('sample-vault');
    await expect(page.locator('.header-context')).toContainText('Old test vault');
  });

  await scenario('last-vault completed receipt survives a reload-style reset and keeps create available', async ({page, fixture}) => {
    fixture.routes['/vaults'] = {vaults: []};
    fixture.setDeletionStatus([{vault_id: 'sample-vault', status: 'deleted', requested_at: new Date(Date.now() - 86400000).toISOString(), completed_at: new Date(Date.now() - 3600000).toISOString(), receipt_expires_at: new Date(Date.now() + 29 * 86400000).toISOString(), retry_at: null, error_code: null}]);
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
    await expect(page.locator('.deletion-status-list')).toContainText('Completed deletion receipt');
    await expect(page.locator('.deletion-status-list')).toContainText('sample-vault');
    await expect(page.getByRole('button', {name: 'New vault', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'New vault', exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'Vault name', exact: true})).toBeVisible();
  });

  await scenario('pending last-vault deletion polling retains Settings receipt truth', async ({page, fixture}) => {
    fixture.routes['/vaults'] = {vaults: []};
    fixture.setDeletionStatus([{vault_id: 'sample-vault', status: 'deleting', requested_at: new Date().toISOString(), completed_at: null, receipt_expires_at: null, retry_at: null, error_code: null}]);
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
    await expect(page.locator('.deletion-status-list')).toContainText('Deleting');
    fixture.setDeletionStatus([{vault_id: 'sample-vault', status: 'deleted', requested_at: new Date(Date.now() - 1000).toISOString(), completed_at: new Date().toISOString(), receipt_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), retry_at: null, error_code: null}]);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/vault-deletions'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(page.locator('.deletion-status-list')).toContainText('Completed deletion receipt');
    await expect(page.locator('.deletion-status-list')).not.toContainText('not yet confirmed');
  });

  await scenario('deletion modal remains owned while submission is pending', async ({page, fixture}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/sample-vault', async route => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await gate;
      await route.fallback();
    });
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await page.locator('.deletion-settings').getByRole('button', {name: 'Delete this server vault', exact: true}).click();
    const modal = page.getByRole('dialog', {name: 'Delete server vault?', exact: true});
    await modal.getByRole('textbox', {name: 'Type DELETE sample-vault', exact: true}).fill('DELETE sample-vault');
    const request = page.waitForRequest(request => request.method() === 'DELETE' && new URL(request.url()).pathname.endsWith('/vaults/sample-vault'));
    await modal.getByRole('button', {name: 'Delete server vault', exact: true}).click();
    await request;
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', {name: 'Cancel', exact: true})).toBeDisabled();
    release();
    await expect(modal).toHaveCount(0);
  });

  await scenario('not-found deletion target clears scoped presentation and selects another vault', async ({page, fixture}) => {
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await page.route('**/api/v1/vaults/sample-vault/dashboard', async route => await route.fulfill({status: 404, json: {error: {code: 'not_found', message: 'Not found.'}}}));
    fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/vaults/sample-vault/dashboard'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Delete this server vault', exact: true})).toBeVisible();
  });

  await scenario('deleting stays distinct from blocked integrity and suppresses target actions', async ({page, fixture}) => {
    fixture.setDeletionStatus([{vault_id: 'sample-vault', status: 'deleting', requested_at: new Date().toISOString(), completed_at: null, receipt_expires_at: null, retry_at: null, error_code: null}]);
    fixture.oldVault.status = 'blocked_integrity';
    fixture.oldSummary.vault.status = 'blocked_integrity';
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Vault deletion in progress', exact: true})).toBeVisible();
    await expect(page.getByText('Integrity failure', {exact: true})).toHaveCount(0);
    await page.getByRole('combobox', {name: 'Current vault', exact: true}).selectOption('old-test-vault');
    await expect(page.getByText('Integrity blocked', {exact: true}).first()).toBeVisible();
    await expect(page.getByRole('button', {name: 'Rename vault', exact: true})).toBeEnabled();
  });

  await scenario('deletion failure remains pending with a safe retry state', async ({page, fixture}) => {
    const retryAt = new Date(Date.now() + 60000).toISOString();
    fixture.setDeletionStatus([{vault_id: 'sample-vault', status: 'deleting', requested_at: new Date().toISOString(), completed_at: null, receipt_expires_at: null, retry_at: retryAt, error_code: 'storage_unavailable'}]);
    await page.reload();
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    const statuses = page.locator('.deletion-status-list');
    await expect(statuses).toContainText('Deleting');
    await expect(statuses).toContainText('Retry needed');
    await expect(statuses).toContainText('Server storage is temporarily unavailable.');
    await expect(statuses).not.toContainText('Deleted');
  });

  await scenario('stale deletion responses cannot overwrite a switched target or account', async ({page, fixture}) => {
    let held = false;
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vault-deletions', async route => {
      if (!held) return route.fallback();
      await gate;
      await route.fulfill({status: 200, json: {deletions: [{vault_id: 'sample-vault', status: 'deleting', requested_at: new Date().toISOString(), completed_at: null, receipt_expires_at: null, retry_at: null, error_code: null}]}});
    });
    held = true;
    const firstRequest = page.waitForRequest('**/api/v1/vault-deletions');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await firstRequest;
    held = false;
    await page.getByRole('combobox', {name: 'Current vault', exact: true}).selectOption('old-test-vault');
    await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
    release();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.locator('.header-context')).toContainText('Old test vault');
    await expect(page.locator('.header-context')).not.toContainText('Deleting');

    let accountRelease;
    const accountGate = new Promise(resolve => accountRelease = resolve);
    held = true;
    await page.route('**/api/v1/vault-deletions', async route => {
      if (!held) return route.fallback();
      await accountGate;
      await route.fulfill({status: 200, json: {deletions: [{vault_id: 'sample-vault', status: 'deleting', requested_at: new Date().toISOString(), completed_at: null, receipt_expires_at: null, retry_at: null, error_code: null}]}});
    });
    const secondRequest = page.waitForRequest('**/api/v1/vault-deletions');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await secondRequest;
    held = false;
    fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
    fixture.setDeletionStatus([]);
    await page.locator('.app-sidebar').getByRole('button', {name: 'Sign out', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
    await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
    await page.getByLabel('Password', {exact: true}).fill('fixture-only');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page.getByRole('combobox', {name: 'Current vault', exact: true})).toHaveValue('old-test-vault');
    accountRelease();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(page.locator('[aria-labelledby="vault-deletions-title"]')).toContainText('No pending or recent server vault deletions.');
  });

  await scenario('backup requirements are reachable from Overview',async({page})=>{
    const button=page.getByRole('button',{name:'Backup requirements',exact:true});
    await button.click();
    await expect(page.getByRole('heading',{name:'Maintenance',level:1,exact:true})).toBeVisible();
    await expect(page.getByText('Backups must cover metadata and the server Git store', {exact:false})).toBeVisible();
  });
  const baseUrl = server.resolvedUrls.local[0];
  const visit = async (page, path) => { await page.goto(new URL(path, baseUrl).toString()); };
  const pathOf = page => new URL(page.url()).pathname + new URL(page.url()).search;
  const getCount = (fixture, path) => fixture.requests.filter(request => request.method === 'GET' && request.path === path).length;
  const waitForPath = (page, expected) => expect.poll(() => pathOf(page)).toBe(expected);
  const vaultSelect = page => page.getByRole('combobox', {name: 'Current vault', exact: true});

  await scenario('deep links open their own section with nav state and a route title', async ({page}) => {
    const cases = [
      ['/dashboard/vaults/sample-vault/overview', 'Overview', 'Overview'],
      ['/dashboard/vaults/sample-vault/devices', 'Devices', 'Devices'],
      ['/dashboard/vaults/sample-vault/history', 'History', 'History'],
      ['/dashboard/vaults/sample-vault/maintenance', 'Maintenance', 'Maintenance'],
      ['/dashboard/vaults/sample-vault/settings', 'Settings', 'Settings'],
      ['/dashboard/vaults/sample-vault/conflicts/sample-conflict', 'Conflicts', 'Conflicts']
    ];
    for (const [path, heading, current] of cases) {
      await visit(page, path);
      await expect(page.getByRole('heading', {name: heading, level: 1, exact: true})).toBeVisible();
      assert.equal(pathOf(page), path, `${path} is already canonical and stays put`);
      await expect(vaultSelect(page)).toHaveValue('sample-vault');
      await expect(page.locator('nav [aria-current="page"]')).toContainText(current);
      await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);
      await expect.poll(() => page.title()).toBe(`${heading} \u00b7 Personal notes \u00b7 OBTS`);
    }
    await visit(page, '/dashboard/vaults/old-test-vault/devices');
    await expect(vaultSelect(page)).toHaveValue('old-test-vault');
    await expect(page.locator('.header-context')).toContainText('Old test vault');
  }, {initialPath: '/dashboard/vaults/sample-vault/overview'});

  await scenario('account settings deep link opens Settings without selecting a vault', async ({page}) => {
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/settings');
    await expect.poll(() => page.title()).toBe('Settings \u00b7 OBTS');
    await expect(page.locator('nav [aria-current="page"]')).toContainText('Settings');
  }, {initialPath: '/dashboard/settings'});

  await scenario('root canonicalizes to the first vault overview by replacing history', async ({page}) => {
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeVisible();
    await page.goBack();
    assert.equal(page.url(), 'about:blank', 'canonicalization replaced the entry instead of adding one');
  }, {initialPath: '/'});

  await scenario('non-canonical dashboard URLs are rewritten in place', async ({page}) => {
    const cases = [
      ['/dashboard', '/dashboard/vaults/sample-vault/overview'],
      ['/dashboard/', '/dashboard/vaults/sample-vault/overview'],
      ['/dashboard/vaults/sample-vault', '/dashboard/vaults/sample-vault/overview'],
      ['/dashboard/vaults/sample-vault/devices/', '/dashboard/vaults/sample-vault/devices'],
      ['/dashboard/vaults/sample-vault/conflicts', '/dashboard/vaults/sample-vault/conflicts/sample-conflict'],
      ['/dashboard/vaults/sample-vault/devices?devices=active', '/dashboard/vaults/sample-vault/devices'],
      ['/dashboard/vaults/sample-vault/overview?devices=revoked', '/dashboard/vaults/sample-vault/overview'],
      ['/dashboard/vaults/sample-vault/devices?devices=revoked', '/dashboard/vaults/sample-vault/devices?devices=revoked']
    ];
    for (const [from, to] of cases) {
      await visit(page, from);
      await waitForPath(page, to);
      await expect(page.locator('.shell')).toBeVisible();
    }
  }, {initialPath: '/dashboard/vaults/sample-vault/overview'});

  await scenario('legacy ?vault links redirect to that vault Settings and unknown ones are not found', async ({page}) => {
    await waitForPath(page, '/dashboard/vaults/old-test-vault/settings');
    await expect(vaultSelect(page)).toHaveValue('old-test-vault');
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
    await visit(page, '/?vault=missing-vault');
    await expect(page.getByRole('heading', {name: 'Vault not found', level: 2, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/?vault=missing-vault', 'the unowned legacy link is kept, not replaced by another vault');
    await expect(page.getByRole('heading', {name: 'Overview', level: 1})).toHaveCount(0);
  }, {initialPath: '/?vault=old-test-vault'});

  await scenario('no vaults sends the root to account Settings', async ({page, fixture}) => {
    fixture.routes['/vaults'] = {vaults: []};
    await visit(page, '/');
    await waitForPath(page, '/dashboard/settings');
    await expect(page.getByRole('heading', {name: 'Settings', level: 1, exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'New vault', exact: true})).toBeVisible();
  });

  await scenario('unknown pages and vaults render a not-found state without opening another vault', async ({page, fixture, capture}) => {
    await visit(page, '/dashboard/nope');
    await expect(page.getByRole('heading', {name: 'Page not found', level: 2, exact: true})).toBeVisible();
    await capture('not-found-desktop-light');
    await page.setViewportSize({width: 390, height: 844});
    await capture('not-found-mobile-light');
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 391, 'not-found fits mobile viewport');
    await page.setViewportSize({width: 1440, height: 1000});
    await expect(page.getByRole('heading', {name: 'Page not found', level: 1, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/nope', 'the URL is not rewritten');
    await expect.poll(() => page.title()).toBe('Page not found \u00b7 OBTS');
    await expect(page.locator('nav [aria-current="page"]')).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Rename vault', exact: true})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Remove vault', exact: false})).toHaveCount(0);

    await visit(page, '/dashboard/vaults/sample-vault/bogus');
    await expect(page.getByRole('heading', {name: 'Page not found', level: 2, exact: true})).toBeVisible();

    fixture.requests.length = 0;
    await visit(page, '/dashboard/vaults/missing-vault/devices');
    await expect(page.getByRole('heading', {name: 'Vault not found', level: 2, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/missing-vault/devices');
    await expect(vaultSelect(page)).toHaveValue('');
    await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
    assert.equal(getCount(fixture, '/vaults/sample-vault/dashboard'), 0, 'no other vault is opened behind the not-found state');
    assert.equal(getCount(fixture, '/vaults/missing-vault/dashboard'), 0, 'an unowned vault is never requested');

    await page.getByRole('link', {name: /^Open Personal notes/u}).click();
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
  }, {initialPath: '/dashboard/nope'});

  await scenario('malformed ids and percent escapes are not found without errors', async ({page}) => {
    for (const path of [
      '/dashboard/vaults/bad%2Fid/overview',
      '/dashboard/vaults/%E0%A4%A/overview',
      '/dashboard/vaults//overview',
      '/dashboard/vaults/sample-vault/devices/extra',
      '/dashboard/vaults/sample-vault/conflicts/%E0%A4%A'
    ]) {
      if (path.includes('%E0')) {
        await page.evaluate(next => {
          history.pushState(null, '', next);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, path);
      } else {
        await visit(page, path);
      }
      await expect(page.getByRole('alert').or(page.getByRole('heading', {name: /not found$/u, level: 2}))).toBeVisible();
      await expect(page.getByRole('heading', {name: /not found$/u, level: 2})).toBeVisible();
      assert.equal(pathOf(page), path, `${path} is left as typed`);
    }
  }, {initialPath: '/dashboard/nope'});

  await scenario('an unknown conflict id is not found and never requests a review', async ({page, fixture}) => {
    await expect(page.getByRole('heading', {name: 'Conflict not found', level: 2, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/conflicts/missing-conflict');
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts/missing-conflict'), 0);
    await expect(page.locator('.conflict-workbench')).toHaveCount(0);
    await page.getByRole('link', {name: 'View all conflicts', exact: true}).click();
    await waitForPath(page, '/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    await expect(page.locator('.conflict-workbench')).toBeVisible();
  }, {initialPath: '/dashboard/vaults/sample-vault/conflicts/missing-conflict'});

  await scenario('nav items are real links; modified clicks are left to the browser', async ({page, context}) => {
    const hrefs = {Overview: 'overview', Devices: 'devices', Conflicts: 'conflicts', History: 'history', Maintenance: 'maintenance', Settings: 'settings'};
    for (const [name, section] of Object.entries(hrefs)) {
      const link = page.locator('nav').getByRole('link', {name: new RegExp(`^${name}`)});
      await expect(link).toHaveAttribute('href', `/dashboard/vaults/sample-vault/${section}`);
    }
    await expect(page.locator('nav').getByRole('link', {name: /^Overview/u})).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('nav').getByRole('button')).toHaveCount(0);

    await page.evaluate(() => {
      sessionStorage.setItem('clicks', '[]');
      window.addEventListener('click', event => {
        sessionStorage.setItem('clicks', JSON.stringify([...JSON.parse(sessionStorage.getItem('clicks')), event.defaultPrevented]));
      });
    });
    const devices = page.locator('nav').getByRole('link', {name: /^Devices/u});
    for (const modifier of ['Control', 'Shift']) {
      const opened = context.waitForEvent('page');
      await devices.click({modifiers: [modifier]});
      await (await opened).close();
      assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/overview', `${modifier}-click never navigates this tab in-app`);
    }
    await devices.click({modifiers: ['Meta']});
    await page.waitForLoadState('load');
    const prevented = await page.evaluate(() => JSON.parse(sessionStorage.getItem('clicks')));
    assert.deepEqual(prevented.slice(0, 3), [false, false, false], 'ctrl, shift and meta clicks keep their default browser behavior');
    await visit(page, '/dashboard/vaults/sample-vault/overview');
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeVisible();

    await devices.click();
    await waitForPath(page, '/dashboard/vaults/sample-vault/devices');
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    await expect(devices).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');

  });

  await scenario('back, forward and reload follow the URL through every section', async ({page, navigate}) => {
    await navigate('Devices');
    await navigate('History');
    await navigate('Maintenance');
    await page.goBack();
    await expect(page.getByRole('heading', {name: 'History', level: 1, exact: true})).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    await expect(page.locator('nav [aria-current="page"]')).toContainText('Devices');
    await page.goForward();
    await expect(page.getByRole('heading', {name: 'History', level: 1, exact: true})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', {name: 'History', level: 1, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/history');
    await page.goBack();
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeVisible();
  });

  const withRevoked = async ({fixture}) => fixture.addRevokedDevices();
  const revokedUrl = '/dashboard/vaults/sample-vault/devices?devices=revoked';
  const viewSwitch = page => page.getByRole('group', {name: 'Device view', exact: true});
  const removeButton = (page, label, name) => page.getByRole('button', {name: `${label}: ${name}`, exact: true});
  const removalDialog = page => page.getByRole('dialog', {name: /^Remove device/u});

  await scenario('revoked devices view survives a reload through the URL', async ({page}) => {
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/devices?devices=revoked');
    await expect(page.getByRole('list', {name: 'Revoked devices', exact: true})).toBeVisible();
    await expect(page.getByText('Old tablet', {exact: true})).toBeVisible();
    await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/devices?devices=revoked');
    await expect(page.getByText('Old tablet', {exact: true})).toBeVisible();
    await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
    await expect(viewSwitch(page).getByRole('link', {name: /^Revoked/u})).toHaveAttribute('aria-current', 'true');
  }, {initialPath: '/dashboard/vaults/sample-vault/devices?devices=revoked', prepare: withRevoked});

  await scenario('vault selector navigates, keeps the section and drops a gated response after Back', async ({page, fixture}) => {
    let release;
    let held = 0;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/old-test-vault/dashboard', async route => {
      held++;
      await gate;
      await route.fallback();
    });
    try {
      await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
      const pending = page.waitForRequest('**/api/v1/vaults/old-test-vault/dashboard');
      await vaultSelect(page).selectOption('old-test-vault');
      await pending;
      await waitForPath(page, '/dashboard/vaults/old-test-vault/devices');
      await page.goBack();
      await waitForPath(page, '/dashboard/vaults/sample-vault/devices');
      await expect(vaultSelect(page)).toHaveValue('sample-vault');
      await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
      release();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(held, 1);
      await expect(vaultSelect(page)).toHaveValue('sample-vault');
      await expect(page.locator('.header-context')).not.toContainText('Old test vault');
      await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
    } finally { release(); }
    await vaultSelect(page).selectOption('old-test-vault');
    await waitForPath(page, '/dashboard/vaults/old-test-vault/devices');
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    await expect(page.locator('.header-context')).toContainText('Old test vault');
    await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
    assert.equal(fixture.unexpected.length, 0);
  }, {initialPath: '/dashboard/vaults/sample-vault/devices'});

  await scenario('a dirty settings draft prompts on Back, nav and vault change and cancel keeps everything', async ({page, navigate}) => {
    await navigate('Settings');
    const shared = page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true});
    const unloads = () => page.evaluate(() => {
      const event = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await unloads(), false, 'a clean page never blocks unload');
    await shared.check();
    assert.equal(await unloads(), true, 'a dirty draft blocks unload');
    const messages = [];
    page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.dismiss(); });

    await page.goBack();
    await expect.poll(() => messages.length).toBe(1);
    assert.match(messages[0], /unsaved sync rule changes/u);
    await waitForPath(page, '/dashboard/vaults/sample-vault/settings');
    await expect(shared).toBeChecked();

    await page.locator('nav').getByRole('link', {name: /^Devices/u}).click();
    await expect.poll(() => messages.length).toBe(2);
    await waitForPath(page, '/dashboard/vaults/sample-vault/settings');
    await expect(shared).toBeChecked();

    await vaultSelect(page).selectOption('old-test-vault');
    await expect.poll(() => messages.length).toBe(3);
    await expect(vaultSelect(page)).toHaveValue('sample-vault');
    await waitForPath(page, '/dashboard/vaults/sample-vault/settings');
    await expect(shared).toBeChecked();

    page.removeAllListeners('dialog');
    page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.accept(); });
    await page.goBack();
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeVisible();
    assert.equal(messages.length, 4);
    assert.equal(await unloads(), false, 'leaving clears the unload guard');
  });

  await scenario('conflict and diagnostics requests are issued once and only where needed', async ({page, fixture}) => {
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeVisible();
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
    await page.waitForTimeout(100);
    assert.equal(getCount(fixture, '/diagnostic-events'), 0, 'Overview never fetches diagnostics');
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts'), 0, 'the conflict list is read once, from the dashboard summary');
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts/sample-conflict'), 0, 'no conflict detail without a conflict route');
    assert.equal(getCount(fixture, '/vaults/sample-vault/dashboard'), 1);

    await page.locator('nav').getByRole('link', {name: /^Settings/u}).click();
    await expect(page.locator('.diagnostics-settings')).toBeVisible();
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(1);
    await page.locator('nav').getByRole('link', {name: /^Devices/u}).click();
    await page.locator('nav').getByRole('link', {name: /^Settings/u}).click();
    await expect(page.locator('.diagnostics-settings')).toBeVisible();
    await page.waitForTimeout(100);
    assert.equal(getCount(fixture, '/diagnostic-events'), 1, 'diagnostics are not refetched when returning to Settings');

    await page.locator('nav').getByRole('link', {name: /^Conflicts/u}).click();
    await waitForPath(page, '/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    await expect(page.locator('.conflict-workbench')).toBeVisible();
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts/sample-conflict'), 1, 'one detail request for the selected conflict');
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts'), 0);
  }, {initialPath: '/dashboard/vaults/sample-vault/overview'});

  await scenario('a bare conflicts route auto-selects the first open conflict by replacing history', async ({page, fixture}) => {
    await waitForPath(page, '/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    await expect(page.locator('.conflict-workbench')).toBeVisible();
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts/sample-conflict'), 1);
    assert.equal(getCount(fixture, '/vaults/sample-vault/conflicts'), 0, 'no duplicate conflicts GET');
    assert.equal(getCount(fixture, '/diagnostic-events'), 0);
    await page.goBack();
    assert.equal(page.url(), 'about:blank', 'auto-selection replaced the bare conflicts entry');
  }, {initialPath: '/dashboard/vaults/sample-vault/conflicts'});

  await scenario('a deep link survives sign-in', async ({page, fixture}) => {
    await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/history');
    fixture.setFailure(null);
    await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
    await page.getByLabel('Password', {exact: true}).fill('fixture-only');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'History', level: 1, exact: true})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/history');
  }, {initialPath: '/dashboard/vaults/sample-vault/history', prepare: async ({fixture}) => { fixture.setFailure({path: '/auth/session', status: 401}); }});

  const phraseInput = (page, id, discard = false) => page.getByRole('textbox', {name: `Type DELETE ${id}${discard ? ' AND DISCARD UNMERGED WORK' : ''}`, exact: true});
  const submitRemoval = page => removalDialog(page).getByRole('button', {name: 'Remove device permanently', exact: true});
  const deleteRequests = fixture => fixture.requests.filter(request => request.method === 'DELETE' && request.path.startsWith('/vaults/sample-vault/devices/'));
  const heading1 = page => page.getByRole('heading', {level: 1});
  const pushPath = (page, path) => page.evaluate(next => { history.pushState(null, '', next); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  const installNewVault = fixture => {
    const created = {...fixture.vault, vault_id: 'brand-new-vault', display_name: 'Brand new'};
    fixture.routes['/vaults/brand-new-vault/dashboard'] = {...fixture.oldSummary, vault: created};
    fixture.routes['/vaults/brand-new-vault/sync-settings'] = {...fixture.routes['/vaults/old-test-vault/sync-settings'], vault_id: 'brand-new-vault'};
    fixture.routes['/vaults/brand-new-vault/conflicts'] = {conflicts: []};
    return created;
  };
  const gateCreate = async (page, fixture, created) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await gate;
      fixture.routes['/vaults'] = {vaults: [fixture.vault, fixture.oldVault, created]};
      await route.fulfill({status: 200, json: created});
    });
    return release;
  };
  const startCreate = async page => {
    await page.getByRole('button', {name: 'New vault', exact: true}).click();
    await page.getByRole('textbox', {name: 'Vault name', exact: true}).fill('Brand new');
    const pending = page.waitForRequest(request => request.url().endsWith('/vaults') && request.method() === 'POST');
    await page.getByRole('button', {name: 'Create vault', exact: true}).click();
    await pending;
  };

  await scenario('overview, counts and attention exclude revoked devices', async ({page, fixture}) => {
    fixture.devices[3].blocked = true;
    fixture.devices[3].status_label = 'Blocked';
    await page.reload();
    await expect(page.getByText('3 paired', {exact: true})).toBeVisible();
    for (const name of ['Old tablet', 'Retired netbook', 'Spare phone', 'Lab desktop']) await expect(page.getByText(name, {exact: true})).toHaveCount(0);
    await expect(page.getByText('Blocked device: Old tablet')).toHaveCount(0);
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
  }, {prepare: withRevoked});

  await scenario('Active and Revoked switch shows counts, follows the URL, Back and reload', async ({page, navigate}) => {
    await navigate('Devices');
    const active = viewSwitch(page).getByRole('link', {name: 'Active (3)', exact: true});
    const revoked = viewSwitch(page).getByRole('link', {name: 'Revoked (4)', exact: true});
    await expect(active).toHaveAttribute('aria-current', 'true');
    await expect(revoked).not.toHaveAttribute('aria-current', /.*/u);
    await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);
    await expect(page.getByText('Old tablet', {exact: true})).toHaveCount(0);
    const before = await page.evaluate(() => history.length);
    await revoked.click();
    await waitForPath(page, revokedUrl);
    assert.equal(await page.evaluate(() => history.length), before + 1, 'switching pushes exactly one entry');
    await expect(revoked).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.revoked-device')).toHaveCount(4);
    await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
    await page.goBack();
    await waitForPath(page, '/dashboard/vaults/sample-vault/devices');
    await expect(active).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
    await page.goForward();
    await waitForPath(page, revokedUrl);
    await page.reload();
    await expect(page.locator('.revoked-device')).toHaveCount(4);
  }, {prepare: withRevoked});

  await scenario('revoking a device moves it to Revoked and the notice links there', async ({page, navigate}) => {
    await navigate('Devices');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', {name: 'Travel laptop actions', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Revoke device', exact: true}).click();
    const notice = page.getByRole('status').filter({hasText: 'Travel laptop was revoked.'});
    await expect(notice).toBeVisible();
    await expect(viewSwitch(page).getByRole('link', {name: 'Active (2)', exact: true})).toBeVisible();
    await expect(viewSwitch(page).getByRole('link', {name: 'Revoked (1)', exact: true})).toBeVisible();
    await notice.getByRole('link', {name: 'View revoked devices', exact: true}).click();
    await waitForPath(page, revokedUrl);
    await expect(page.locator('.revoked-device')).toHaveCount(1);
    await expect(page.locator('.revoked-device')).toContainText('Travel laptop');
    await expect(page.locator('.revoked-device')).toContainText('sample-device-1');
    await expect(removeButton(page, 'Remove permanently', 'Travel laptop')).toBeEnabled();
  });

  await scenario('an empty Revoked view explains what it is', async ({page}) => {
    await expect(page.getByText('No revoked devices', {exact: true})).toBeVisible();
    await expect(page.getByText(/it moves here/u)).toBeVisible();
    await expect(viewSwitch(page).getByRole('link', {name: 'Revoked (0)', exact: true})).toBeVisible();
  }, {initialPath: revokedUrl});

  await scenario('revoked rows show identity, times and every removal state', async ({page, fixture, capture}) => {
    fixture.devices[3].revoked_at = null;
    await page.reload();
    const rows = page.locator('.revoked-device');
    await expect(rows).toHaveCount(4);
    for (const [index, name] of [[3, 'Old tablet'], [4, 'Retired netbook'], [5, 'Spare phone'], [6, 'Lab desktop']]) {
      const row = rows.filter({hasText: name});
      await expect(row).toContainText(`sample-device-${index}`);
      await expect(row.getByText('Revoked', {exact: true})).toBeVisible();
      await expect(row.getByText('Last seen')).toBeVisible();
      await expect(row.getByRole('button', {name: `${name} actions`, exact: true})).toBeDisabled();
      await expect(row.getByRole('menuitem')).toHaveCount(0);
    }
    await expect(rows.filter({hasText: 'Old tablet'}).getByText('Revoked at')).toHaveCount(0);
    await expect(rows.filter({hasText: 'Retired netbook'}).locator('time').first()).toHaveAttribute('title', /.+/u);
    await expect(removeButton(page, 'Remove permanently', 'Old tablet')).toBeEnabled();
    await expect(removeButton(page, 'Removal in progress', 'Retired netbook')).toBeDisabled();
    await expect(removeButton(page, 'Removal failed \u2014 Retry', 'Spare phone')).toBeEnabled();
    await expect(removeButton(page, 'Needs your decision', 'Lab desktop')).toBeEnabled();
    await capture('devices-revoked-desktop-light');
    await removeButton(page, 'Removal failed \u2014 Retry', 'Spare phone').click();
    await expect(removalDialog(page).getByRole('heading', {name: 'Remove device permanently?', exact: true})).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(removalDialog(page)).toContainText('The last attempt stopped.');
    await page.keyboard.press('Escape');
    await expect(removalDialog(page)).toHaveCount(0);
    await removeButton(page, 'Needs your decision', 'Lab desktop').click();
    await expect(removalDialog(page).getByRole('heading', {name: 'Remove device permanently?', exact: true})).toBeVisible();
    await expect(removalDialog(page)).toContainText('The last attempt found unmerged work from this device.');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    assert.equal(deleteRequests(fixture).length, 0, 'opening never sends a request');
    await capture('removal-dialog-needs-decision-desktop');
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('removal happy path gates on the exact phrase and sends the exact body', async ({page, fixture, capture}) => {
    const trigger = removeButton(page, 'Remove permanently', 'Old tablet');
    await trigger.click();
    const dialog = removalDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toContainText('sample-device-3');
    await expect(dialog).toContainText('merged');
    const input = phraseInput(page, 'sample-device-3');
    await expect(input).toBeFocused();
    await expect(submitRemoval(page)).toBeDisabled();
    await input.fill('DELETE sample-device-');
    await expect(submitRemoval(page)).toBeDisabled();
    await input.fill('delete sample-device-3');
    await expect(submitRemoval(page)).toBeDisabled();
    await input.fill('DELETE sample-device-3 ');
    await expect(submitRemoval(page)).toBeDisabled();
    await capture('removal-dialog-standard-desktop');
    await input.fill('DELETE sample-device-3');
    await expect(submitRemoval(page)).toBeEnabled();
    await submitRemoval(page).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Old tablet', {exact: true})).toHaveCount(0);
    await expect(page.getByRole('status').filter({hasText: 'Old tablet permanently removed.'})).toBeVisible();
    const sent = deleteRequests(fixture);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, '/vaults/sample-vault/devices/sample-device-3');
    assert.deepEqual(sent[0].body, {confirmation: 'DELETE sample-device-3', discard_unmerged: false});
    assert.ok(sent[0].csrf !== null, 'the request carries the CSRF header');
    await expect(viewSwitch(page).getByRole('link', {name: 'Revoked (3)', exact: true})).toBeVisible();
    await expect(page.locator('main, body').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('unmerged work switches to discard mode and sends discard_unmerged', async ({page, fixture, capture}) => {
    fixture.scriptRemovalResponses([fixture.removalResponses.unmergedWork('staged_transfer')]);
    await removeButton(page, 'Removal failed \u2014 Retry', 'Spare phone').click();
    await phraseInput(page, 'sample-device-5').fill('DELETE sample-device-5');
    await submitRemoval(page).click();
    const dialog = removalDialog(page);
    await expect(dialog.getByRole('heading', {name: 'Remove device and discard unmerged work?', exact: true})).toBeVisible();
    await expect(dialog).toContainText('upload in progress');
    await expect(dialog).not.toContainText('Raw server text');
    const understood = dialog.getByRole('checkbox', {name: 'I understand unmerged work from this device will be permanently discarded', exact: true});
    const input = phraseInput(page, 'sample-device-5', true);
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(submitRemoval(page)).toBeDisabled();
    await input.fill('DELETE sample-device-5 AND DISCARD UNMERGED WORK');
    await expect(submitRemoval(page)).toBeDisabled();
    await understood.check();
    await expect(submitRemoval(page)).toBeEnabled();
    await understood.uncheck();
    await expect(submitRemoval(page)).toBeDisabled();
    await understood.check();
    await capture('removal-dialog-discard-desktop');
    await submitRemoval(page).click();
    await expect(dialog).toHaveCount(0);
    const sent = deleteRequests(fixture);
    assert.equal(sent.length, 2, 'the scripted refusal and the discard request are both recorded');
    assert.deepEqual(sent[0].body, {confirmation: 'DELETE sample-device-5', discard_unmerged: false});
    assert.deepEqual(sent[1].body, {confirmation: 'DELETE sample-device-5 AND DISCARD UNMERGED WORK', discard_unmerged: true});
    await expect(page.getByRole('status').filter({hasText: 'Spare phone permanently removed.'})).toBeVisible();
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('an inconsistent device ref offers the discard phrase', async ({page, fixture}) => {
    fixture.scriptRemovalResponses([fixture.removalResponses.refInconsistent({discardPhrase: true})]);
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    await submitRemoval(page).click();
    await expect(removalDialog(page)).toContainText('inconsistent');
    await expect(removalDialog(page).getByRole('heading', {name: 'Remove device and discard unmerged work?', exact: true})).toBeVisible();
    await expect(page.getByRole('checkbox')).toBeVisible();
    await expect(phraseInput(page, 'sample-device-3', true)).toBeFocused();
    await expect(removalDialog(page)).not.toContainText('administrator');
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('open work and other rejections map to safe inline messages and keep the dialog open', async ({page, fixture}) => {
    const responses = fixture.removalResponses;
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    const dialog = removalDialog(page);
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    const cases = [
      [responses.openWork('unsettled_operation'), /sync operation in progress/u],
      [responses.notRevoked(), /Revoke the device first/u],
      [responses.confirmationMismatch(), /did not match/u],
      [responses.unavailable(7), /Temporarily unavailable\. Try again in 7 seconds/u],
      [responses.incomplete(), /Temporarily unavailable\. Try again in 2 seconds\./u],
      [{...responses.incomplete(), headers: {}}, /Temporarily unavailable\. Try again\./u],
      [responses.internal(), /Unable to remove this device/u],
      [responses.forbidden(), /Unable to remove this device/u]
    ];
    for (const [response, expected] of cases) {
      fixture.scriptRemovalResponses([response]);
      await submitRemoval(page).click();
      await expect(dialog.getByRole('alert')).toContainText(expected);
      await expect(dialog.getByRole('alert')).not.toContainText('Raw server text');
      await expect(dialog).toBeVisible();
      await expect(phraseInput(page, 'sample-device-3')).toHaveValue('DELETE sample-device-3');
      await expect(submitRemoval(page)).toBeEnabled();
    }
    fixture.scriptRemovalResponses([responses.vaultDeleting()]);
    await submitRemoval(page).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.action-error')).toContainText('being deleted');
    assert.equal(fixture.devices.some(device => device.device_id === 'sample-device-3'), true, 'nothing was removed');
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('open conflicts link closes the dialog and opens Conflicts', async ({page, fixture}) => {
    fixture.scriptRemovalResponses([fixture.removalResponses.openWork('open_conflict')]);
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    await submitRemoval(page).click();
    const dialog = removalDialog(page);
    await expect(dialog.getByRole('alert')).toContainText('open conflicts');
    await dialog.getByRole('link', {name: 'Open conflicts', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    await waitForPath(page, '/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    await expect(heading1(page)).toHaveText('Conflicts');
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('a 404 refreshes the list and reports an already removed device', async ({page, fixture}) => {
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    fixture.devices.splice(fixture.devices.findIndex(device => device.device_id === 'sample-device-3'), 1);
    await submitRemoval(page).click();
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({hasText: 'Old tablet was already removed.'})).toBeVisible();
    await expect(page.getByText('Old tablet', {exact: true})).toHaveCount(0);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('Escape and Cancel close the removal dialog and restore focus to its trigger', async ({page, fixture}) => {
    const trigger = removeButton(page, 'Remove permanently', 'Old tablet');
    await trigger.click();
    await expect(removalDialog(page)).toBeVisible();
    await page.keyboard.press('Tab');
    for (let index = 0; index < 8; index++) {
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, 'Tab never leaves the dialog');
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Escape');
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await removalDialog(page).getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    assert.equal(deleteRequests(fixture).length, 0);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('a vault switch closes the removal dialog and a late response for the old target is ignored', async ({page, fixture}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    fixture.scriptRemovalResponses([fixture.removalResponses.succeeds({gate})]);
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    await submitRemoval(page).click();
    await expect(removalDialog(page).getByRole('button', {name: 'Removing\u2026', exact: true})).toBeDisabled();
    await pushPath(page, '/dashboard/vaults/old-test-vault/devices?devices=revoked');
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(vaultSelect(page)).toHaveValue('old-test-vault');
    await pushPath(page, revokedUrl);
    await expect(page.locator('.revoked-device')).toHaveCount(4);
    await removeButton(page, 'Removal failed \u2014 Retry', 'Spare phone').click();
    await expect(removalDialog(page)).toContainText('sample-device-5');
    release();
    await expect.poll(() => fixture.devices.some(device => device.device_id === 'sample-device-3')).toBe(false);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(removalDialog(page)).toContainText('sample-device-5');
    await expect(phraseInput(page, 'sample-device-5')).toBeVisible();
    await expect(page.getByRole('status').filter({hasText: 'permanently removed'})).toHaveCount(0);
    assert.equal(pathOf(page), revokedUrl);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  const startRemoval = async (page, {name = 'Old tablet', id = 'sample-device-3', label = 'Remove permanently'} = {}) => {
    await removeButton(page, label, name).click();
    await phraseInput(page, id).fill(`DELETE ${id}`);
    const sent = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(`/devices/${id}`));
    await submitRemoval(page).click();
    await sent;
  };
  const heldRemoval = () => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    return {gate, release};
  };
  const settle = async page => {
    for (let index = 0; index < 3; index++) await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const dashboardGets = fixture => getCount(fixture, '/vaults/sample-vault/dashboard');
  const terminalMessage = "The server can't safely remove this device from the dashboard: its server-side record is inconsistent. An administrator needs to check the server logs.";

  await scenario('Needs your decision opens the standard dialog with an explanation mapped from the failure code', async ({page, fixture}) => {
    const cases = [
      ['device_has_unmerged_work', 'The last attempt found unmerged work from this device.'],
      ['device_has_open_work', 'The last attempt stopped because of open conflicts or a sync in flight.'],
      ['device_ref_inconsistent', "The last attempt stopped because the server-side record of this device didn't match."],
      ['a_code_this_client_does_not_know', 'The last attempt stopped.'],
      [null, 'The last attempt stopped.']
    ];
    for (const [code, text] of cases) {
      fixture.devices[6].removal = {state: 'failed', retryable: false, error_code: code};
      await page.reload();
      await expect(page.locator('.revoked-device').filter({hasText: 'Lab desktop'})).toContainText(text);
      await removeButton(page, 'Needs your decision', 'Lab desktop').click();
      const dialog = removalDialog(page);
      await expect(dialog.getByRole('heading', {name: 'Remove device permanently?', exact: true})).toBeVisible();
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await expect(dialog.locator('#device-removal-failure')).toHaveText(text);
      await expect(dialog).toHaveAttribute('aria-describedby', 'device-removal-description device-removal-failure');
      await expect(phraseInput(page, 'sample-device-6')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    assert.equal(deleteRequests(fixture).length, 0, 'opening never sends a request');
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('a non-retryable 409 without a discard resolution shows a terminal message, never "Try again", and keeps submit available', async ({page, fixture}) => {
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    const dialog = removalDialog(page);
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    for (const response of [fixture.removalResponses.refInconsistent(), fixture.removalResponses.nonRetryable('a_new_blocking_code')]) {
      fixture.scriptRemovalResponses([response]);
      await submitRemoval(page).click();
      await expect(dialog.getByRole('alert')).toHaveText(terminalMessage);
      await expect(dialog).not.toContainText('Try again');
      await expect(dialog).not.toContainText('Raw server text');
      await expect(dialog.getByRole('heading', {name: 'Remove device permanently?', exact: true})).toBeVisible();
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await expect(phraseInput(page, 'sample-device-3')).toHaveValue('DELETE sample-device-3');
      await expect(submitRemoval(page)).toBeEnabled();
    }
    fixture.scriptRemovalResponses([fixture.removalResponses.succeeds()]);
    await submitRemoval(page).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status').filter({hasText: 'Old tablet permanently removed.'})).toBeVisible();
    assert.equal(deleteRequests(fixture).length, 3);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('the removal dialog error region exists before the first error, is assertive, and the discard warning is described', async ({page, fixture}) => {
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    const dialog = removalDialog(page);
    const region = dialog.getByRole('alert');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText('');
    await expect(region).toHaveAttribute('aria-live', 'assertive');
    await expect(dialog.locator('[aria-live]')).toHaveCount(1);
    const regionHandle = await region.elementHandle();
    await expect(dialog).toHaveAttribute('aria-describedby', 'device-removal-description');
    await phraseInput(page, 'sample-device-3').fill('DELETE sample-device-3');
    fixture.scriptRemovalResponses([fixture.removalResponses.openWork('unsettled_operation')]);
    await submitRemoval(page).click();
    await expect(region).toContainText('sync operation in progress');
    assert.equal(await regionHandle.evaluate(element => element.isConnected), true, 'the same region element received the text');
    fixture.scriptRemovalResponses([fixture.removalResponses.unmergedWork('device_ref')]);
    await submitRemoval(page).click();
    await expect(dialog.getByRole('heading', {name: 'Remove device and discard unmerged work?', exact: true})).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-describedby', 'device-removal-description device-removal-warning');
    await expect(dialog.locator('#device-removal-warning')).toContainText('Unmerged work will be lost');
    await expect(region).toHaveText('');
    assert.equal(await regionHandle.evaluate(element => element.isConnected), true);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('Cancel closes the dialog while the request is in flight; the late 200 only refreshes the list quietly', async ({page, fixture}) => {
    const held = heldRemoval();
    fixture.scriptRemovalResponses([fixture.removalResponses.succeeds({gate: held.gate})]);
    await startRemoval(page);
    const dialog = removalDialog(page);
    await expect(dialog.getByRole('button', {name: 'Removing\u2026', exact: true})).toBeDisabled();
    await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeEnabled();
    assert.equal(deleteRequests(fixture).length, 1, 'only one request was sent');
    const refreshesBefore = dashboardGets(fixture);
    await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    held.release();
    await expect.poll(() => fixture.devices.some(device => device.device_id === 'sample-device-3')).toBe(false);
    await expect(page.locator('.revoked-device')).toHaveCount(3);
    await expect(page.getByText('Old tablet', {exact: true})).toHaveCount(0);
    await expect(viewSwitch(page).getByRole('link', {name: 'Revoked (3)', exact: true})).toBeVisible();
    assert.ok(dashboardGets(fixture) > refreshesBefore, 'the quiet refresh ran without a manual reload');
    await settle(page);
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(page.locator('.notice')).toHaveCount(0);
    await expect(page.getByRole('status').filter({hasText: 'permanently removed'})).toHaveCount(0);
    assert.equal(pathOf(page), revokedUrl);
    assert.equal(deleteRequests(fixture).length, 1);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('Escape closes the in-flight dialog, restores focus, and keeps submit disabled while busy', async ({page, fixture}) => {
    const held = heldRemoval();
    fixture.scriptRemovalResponses([fixture.removalResponses.succeeds({gate: held.gate})]);
    const trigger = removeButton(page, 'Remove permanently', 'Old tablet');
    await startRemoval(page);
    const dialog = removalDialog(page);
    await expect(dialog.getByRole('button', {name: 'Removing\u2026', exact: true})).toBeDisabled();
    await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    held.release();
    await expect(page.locator('.revoked-device')).toHaveCount(3);
    await expect(page.locator('.notice')).toHaveCount(0);
    assert.equal(deleteRequests(fixture).length, 1);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('a late 404 for an abandoned removal refreshes the list quietly', async ({page, fixture}) => {
    const held = heldRemoval();
    fixture.scriptRemovalResponses([{...fixture.removalResponses.notFound(), gate: held.gate}]);
    await startRemoval(page);
    await page.keyboard.press('Escape');
    await expect(removalDialog(page)).toHaveCount(0);
    fixture.devices.splice(fixture.devices.findIndex(device => device.device_id === 'sample-device-3'), 1);
    held.release();
    await expect(page.locator('.revoked-device')).toHaveCount(3);
    await expect(page.getByText('Old tablet', {exact: true})).toHaveCount(0);
    await settle(page);
    await expect(page.locator('.notice')).toHaveCount(0);
    await expect(removalDialog(page)).toHaveCount(0);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('a late failure for an abandoned removal changes nothing', async ({page, fixture}) => {
    const held = heldRemoval();
    fixture.scriptRemovalResponses([{...fixture.removalResponses.unavailable(), gate: held.gate}]);
    await startRemoval(page);
    await page.keyboard.press('Escape');
    await expect(removalDialog(page)).toHaveCount(0);
    const refreshesBefore = dashboardGets(fixture);
    held.release();
    await settle(page);
    await page.waitForTimeout(300);
    assert.equal(dashboardGets(fixture), refreshesBefore, 'a failed outcome triggers no refresh');
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(page.locator('.notice')).toHaveCount(0);
    await expect(page.locator('.action-error')).toHaveCount(0);
    await expect(page.locator('.revoked-device')).toHaveCount(4);
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('same-vault Back while the removal dialog is open closes it', async ({page, navigate}) => {
    await navigate('Devices');
    await viewSwitch(page).getByRole('link', {name: /^Revoked/u}).click();
    await waitForPath(page, revokedUrl);
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    await expect(removalDialog(page)).toBeVisible();
    await expect(page.locator('.shell')).toHaveAttribute('inert', '');
    await page.goBack();
    await waitForPath(page, '/dashboard/vaults/sample-vault/devices');
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(page.locator('.shell')).not.toHaveAttribute('inert', '');
    await expect(heading1(page)).toHaveText('Devices');
    await page.goForward();
    await waitForPath(page, revokedUrl);
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(page.locator('.revoked-device')).toHaveCount(4);
  }, {prepare: withRevoked});

  await scenario('revoked view and removal dialogs fit from 320 to 1440px', async ({page, fixture, capture}) => {
    for (const width of [1440, 1100, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      await expect(page.locator('.revoked-device')).toHaveCount(4);
      const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('.revoked-device')].map(card => ({right: card.getBoundingClientRect().right, scroll: card.scrollWidth, client: card.clientWidth}))}));
      assert.ok(layout.scroll <= layout.width + 1, `revoked view at ${width}: no document overflow`);
      for (const card of layout.cards) assert.ok(card.right <= layout.width + 1 && card.scroll <= card.client + 1, `revoked card at ${width} fits`);
      if (width === 390) await capture('devices-revoked-390-light');
      for (const [label, name, id, discard] of [['Remove permanently', 'Old tablet', 'sample-device-3', false], ['Needs your decision', 'Lab desktop', 'sample-device-6', false], ['Remove permanently', 'Old tablet', 'sample-device-3', true]]) {
        await removeButton(page, label, name).click();
        const dialog = removalDialog(page);
        await expect(dialog).toBeVisible();
        if (discard) {
          fixture.scriptRemovalResponses([fixture.removalResponses.unmergedWork('device_ref')]);
          await phraseInput(page, id).fill(`DELETE ${id}`);
          await submitRemoval(page).click();
          await expect(dialog.getByRole('heading', {name: 'Remove device and discard unmerged work?', exact: true})).toBeVisible();
        }
        await phraseInput(page, id, discard).fill(`DELETE ${id}${discard ? ' AND DISCARD UNMERGED WORK' : ''}`);
        const box = await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return {left: rect.left, right: rect.right, scroll: element.scrollWidth, client: element.clientWidth, doc: document.documentElement.scrollWidth, view: innerWidth}; });
        assert.ok(box.left >= 0 && box.right <= box.view + 1 && box.scroll <= box.client + 1 && box.doc <= box.view + 1, `${name} dialog at ${width} fits`);
        const submit = await submitRemoval(page).boundingBox();
        assert.ok(submit && submit.x >= 0 && submit.x + submit.width <= width + 1, `${name} submit at ${width} is inside the viewport`);
        if (width === 390) await capture(discard ? 'removal-dialog-discard-390' : name === 'Lab desktop' ? 'removal-dialog-needs-decision-390' : 'removal-dialog-standard-390');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
    }
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('R1: a resolve completion never overrides a later navigation', async ({page, navigate}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/vaults/sample-vault/conflicts/sample-conflict/resolve', async route => { await gate; await route.fallback(); });
    page.on('dialog', dialog => dialog.accept());
    await navigate('Conflicts');
    await page.locator('.resolution-policy select').selectOption('use_device');
    await page.getByRole('button', {name: 'Review result', exact: true}).click();
    const resolved = page.waitForRequest(request => request.url().endsWith('/resolve'));
    await page.getByRole('button', {name: 'Apply resolution', exact: true}).click();
    await resolved;
    await navigate('History');
    await waitForPath(page, '/dashboard/vaults/sample-vault/history');
    release();
    await expect(page.locator('.notice')).toContainText('Conflict resolved');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/history', 'the completion left the newer route alone');
    await expect(heading1(page)).toHaveText('History');
  });

  await scenario('R1: a resolve completion on the same conflict still leaves the resolved conflict', async ({page, navigate}) => {
    await navigate('Conflicts');
    await page.locator('.resolution-policy select').selectOption('use_device');
    await page.getByRole('button', {name: 'Review result', exact: true}).click();
    await page.getByRole('button', {name: 'Apply resolution', exact: true}).click();
    await expect(page.locator('.notice')).toContainText('Conflict resolved');
    await expect(heading1(page)).toHaveText('Conflicts');
  });

  await scenario('R1/R2: login completion follows the newest route', async ({page, fixture}) => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/auth/login', async route => { await gate; await route.fallback(); });
    await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
    await page.getByLabel('Password', {exact: true}).fill('fixture-only');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await pushPath(page, '/dashboard/vaults/sample-vault/maintenance');
    fixture.setFailure(null);
    release();
    await expect(heading1(page)).toHaveText('Maintenance');
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/maintenance');
  }, {initialPath: '/dashboard/vaults/sample-vault/history', prepare: async ({fixture}) => { fixture.setFailure({path: '/auth/session', status: 401}); }});

  await scenario('R2: a clean vault creation opens the new vault Overview', async ({page, fixture}) => {
    const created = installNewVault(fixture);
    const release = await gateCreate(page, fixture, created);
    page.on('dialog', dialog => { throw new Error(`unexpected dialog: ${dialog.message()}`); });
    await startCreate(page);
    release();
    await waitForPath(page, '/dashboard/vaults/brand-new-vault/overview');
    await expect(page.locator('.notice')).toContainText('Vault created');
    await expect(heading1(page)).toHaveText('Overview');
    await expect(heading1(page)).toBeFocused();
  });

  await scenario('R2: a vault created after the user navigated away shows a notice with an Open link and no prompt', async ({page, fixture, navigate}) => {
    const created = installNewVault(fixture);
    const release = await gateCreate(page, fixture, created);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await startCreate(page);
    await navigate('Devices');
    release();
    const notice = page.getByRole('status').filter({hasText: 'Vault Brand new created.'});
    await expect(notice).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/devices', 'the route did not change');
    assert.equal(dialogs.length, 0, 'a background completion never opens confirm()');
    await notice.getByRole('link', {name: 'Open', exact: true}).click();
    await waitForPath(page, '/dashboard/vaults/brand-new-vault/overview');
  });

  await scenario('R2: a dirty draft keeps the user in place when a vault is created', async ({page, fixture, navigate}) => {
    const created = installNewVault(fixture);
    await navigate('Settings');
    const release = await gateCreate(page, fixture, created);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    const shared = page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true});
    await shared.check();
    await startCreate(page);
    release();
    await expect(page.getByRole('status').filter({hasText: 'Vault Brand new created.'})).toBeVisible();
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/settings');
    await expect(shared).toBeChecked();
    assert.equal(dialogs.length, 0);
  });

  await scenario('R2: returning to the starting URL during the create request still counts as navigating away', async ({page, fixture, navigate}) => {
    const created = installNewVault(fixture);
    await navigate('Settings');
    const release = await gateCreate(page, fixture, created);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await startCreate(page);
    await navigate('Overview');
    await navigate('Settings');
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/settings', 'the URL equals the one the request started from');
    release();
    const notice = page.getByRole('status').filter({hasText: 'Vault Brand new created.'});
    await expect(notice).toBeVisible();
    await settle(page);
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/settings', 'the completion did not navigate');
    await expect(heading1(page)).toHaveText('Settings');
    assert.equal(dialogs.length, 0);
    await notice.getByRole('link', {name: 'Open', exact: true}).click();
    await waitForPath(page, '/dashboard/vaults/brand-new-vault/overview');
  });

  await scenario('R3: a cancelled dirty Back keeps forward history intact', async ({page, navigate}) => {
    await navigate('Settings');
    const shared = page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true});
    await shared.check();
    let accept = false;
    page.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
    const length = await page.evaluate(() => history.length);
    await page.goBack();
    await page.waitForTimeout(300);
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/settings');
    await expect(shared).toBeChecked();
    assert.equal(await page.evaluate(() => history.length), length, 'cancelling never adds or truncates entries');
    await shared.uncheck();
    await page.goBack();
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');
    await page.goForward();
    await waitForPath(page, '/dashboard/vaults/sample-vault/settings');
    await expect(heading1(page)).toHaveText('Settings');
    accept = true;
  });

  await scenario('R4: vault switches keep the Revoked view and the Devices nav returns to Active', async ({page}) => {
    await vaultSelect(page).selectOption('old-test-vault');
    await waitForPath(page, '/dashboard/vaults/old-test-vault/devices?devices=revoked');
    await expect(page.getByText('No revoked devices', {exact: true})).toBeVisible();
    await vaultSelect(page).selectOption('sample-vault');
    await waitForPath(page, revokedUrl);
    await expect(page.locator('.revoked-device')).toHaveCount(4);
    const devices = page.locator('nav').getByRole('link', {name: /^Devices/u});
    await expect(devices).toHaveAttribute('href', '/dashboard/vaults/sample-vault/devices');
    await devices.click();
    await waitForPath(page, '/dashboard/vaults/sample-vault/devices');
    await expect(viewSwitch(page).getByRole('link', {name: 'Active (3)', exact: true})).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('R5: go never pushes an entry equal to the current URL', async ({page, navigate}) => {
    await navigate('Conflicts');
    await waitForPath(page, '/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    const length = await page.evaluate(() => history.length);
    await page.locator('nav').getByRole('link', {name: /^Conflicts/u}).click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(() => history.length), length, 'clicking the current section adds no entry');
    assert.equal(pathOf(page), '/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    await page.goBack();
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');
  }, {initialPath: '/dashboard/vaults/sample-vault/overview'});

  await scenario('R6: route changes move focus to the page heading but never on load', async ({page, navigate}) => {
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'initial load leaves focus alone');
    await navigate('History');
    await expect(heading1(page)).toBeFocused();
    const ring = await heading1(page).evaluate(element => getComputedStyle(element).outlineStyle);
    assert.equal(ring, 'none', 'programmatic focus shows no ring');
    await page.goBack();
    await expect(heading1(page)).toHaveText('Overview');
    await expect(heading1(page)).toBeFocused();
  });

  await scenario('R6: a not-found recovery link focuses the heading', async ({page}) => {
    await page.getByRole('link', {name: /^Open Personal notes/u}).click();
    await waitForPath(page, '/dashboard/vaults/sample-vault/overview');
    await expect(heading1(page)).toHaveText('Overview');
    await expect(heading1(page)).toBeFocused();
  }, {initialPath: '/dashboard/vaults/missing-vault/devices'});

  await scenario('R6: closing the mobile drawer through a nav click ends with focus on the heading', async ({page, navigate}) => {
    await navigate('History');
    await expect(page.locator('.app-sidebar')).toHaveAttribute('inert', '');
    await expect(heading1(page)).toBeFocused();
  }, {viewport: {width: 390, height: 844}});

  await scenario('R6: a modal keeps focus when the route is refreshed in the background', async ({page}) => {
    await removeButton(page, 'Remove permanently', 'Old tablet').click();
    await expect(phraseInput(page, 'sample-device-3')).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(phraseInput(page, 'sample-device-3')).toBeFocused();
  }, {initialPath: revokedUrl, prepare: withRevoked});

  await scenario('R6: a real focusToken bump (same-vault popstate) never focuses the heading while a modal is open', async ({page, navigate}) => {
    const focusedHeadings = () => page.evaluate(() => window.__focusCalls.filter(call => call === 'H1').length);
    await navigate('Settings');
    await page.locator('.deletion-settings').getByRole('button', {name: 'Delete this server vault', exact: true}).click();
    const modal = page.getByRole('dialog', {name: 'Delete server vault?', exact: true});
    const input = modal.getByRole('textbox', {name: 'Type DELETE sample-vault', exact: true});
    await expect(input).toBeFocused();
    await page.evaluate(() => { window.__focusCalls.length = 0; });
    await pushPath(page, '/dashboard/vaults/sample-vault/settings');
    await settle(page);
    await expect(modal).toBeVisible();
    await expect(input).toBeFocused();
    assert.equal(await focusedHeadings(), 0, 'the modal guard kept the heading from being focused');
    await modal.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(modal).toHaveCount(0);
    await page.evaluate(() => { window.__focusCalls.length = 0; });
    await pushPath(page, '/dashboard/vaults/sample-vault/settings');
    await expect(heading1(page)).toBeFocused();
    assert.ok(await focusedHeadings() >= 1, 'positive control: the same bump focuses the heading once no modal is open');
  }, {prepare: async ({page}) => {
    await page.addInitScript(() => {
      const real = HTMLElement.prototype.focus;
      window.__focusCalls = [];
      HTMLElement.prototype.focus = function focus(...args) { window.__focusCalls.push(this.tagName); return real.apply(this, args); };
    });
  }});

  await scenario('R7: entering Settings refetches stale diagnostics in the background; Overview never does', async ({page, fixture, navigate}) => {
    let release;
    let gated = 0;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/v1/diagnostic-events', async route => {
      if (route.request().method() === 'GET' && ++gated === 2) await gate;
      await route.fallback();
    });
    const skew = ms => page.evaluate(value => { window.__skew = value; }, ms);
    await navigate('Settings');
    await expect(page.locator('.diagnostics-settings')).toBeVisible();
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(1);
    await navigate('Overview');
    await skew(61000);
    await navigate('Devices');
    await page.waitForTimeout(150);
    assert.equal(getCount(fixture, '/diagnostic-events'), 1, 'Overview and Devices never fetch diagnostics');
    await navigate('Settings');
    await expect.poll(() => gated).toBe(2);
    await expect(page.locator('.diagnostics-settings')).toBeVisible();
    release();
    await page.waitForTimeout(150);
    await navigate('Devices');
    await navigate('Settings');
    await page.waitForTimeout(150);
    assert.equal(getCount(fixture, '/diagnostic-events'), 2, 'fresh diagnostics are not refetched');
  }, {prepare: async ({page}) => {
    await page.addInitScript(() => { const real = Date.now.bind(Date); window.__skew = 0; Date.now = () => real() + window.__skew; });
  }});

  // ---- Live updates (stream, scheduler, honest status); dashboardGets is defined above ----
  const sidebarStatus = page => page.locator('.sidebar-status');
  const announcer = page => page.locator('.live-announcer');
  /** Waits until a counter stops changing, so assertions about "no more requests" are not racing a late one. */
  async function stable(page, read) {
    let last = -1;
    for (;;) {
      const value = read();
      if (value === last) return value;
      last = value;
      await page.waitForTimeout(250);
    }
  }
  async function goLive(page, es, fixture) {
    await es.emit('refresh', '{}');
    await expect(sidebarStatus(page)).toContainText('Live');
    await stable(page, () => dashboardGets(fixture) * 1000 + getCount(fixture, '/vaults'));
  }

  await scenario('live: the status is Connecting until the refresh frame, opens one plain same-origin stream and refreshes fully', async ({page, fixture, es, capture}) => {
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    await expect(sidebarStatus(page)).not.toContainText('Auto-refresh');
    const opened = await es.counts();
    assert.deepEqual(opened.urls, ['/api/v1/dashboard/events'], 'one stream on the exact path, no query string or token');
    assert.deepEqual(opened.inits, [null], 'no withCredentials or other init');
    await es.emit('open');
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    const vaultsBefore = await stable(page, () => getCount(fixture, '/vaults'));
    const dashboardBefore = dashboardGets(fixture);
    await es.emit('refresh', '{}');
    await expect(sidebarStatus(page)).toContainText('Live');
    await expect(announcer(page)).toContainText('Live updates connected');
    await expect.poll(() => getCount(fixture, '/vaults')).toBe(vaultsBefore + 1);
    await expect.poll(() => dashboardGets(fixture)).toBe(dashboardBefore + 1);
    await expect(sidebarStatus(page).locator('span.live')).toBeVisible();
    await capture('sidebar-live-desktop');
    assert.equal((await es.counts()).instances, 1, 'still exactly one stream');
  });

  await scenario('live: the sidebar is not Live until the connect snapshot has landed', async ({page, fixture, es}) => {
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    const hold = fixture.holdNext('/vaults/sample-vault/dashboard');
    await es.emit('refresh', '{}');
    await hold.started;
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    await page.waitForTimeout(400);
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    await expect(sidebarStatus(page)).not.toContainText('Live');
    await expect(sidebarStatus(page).locator('span.live')).toHaveCount(0);
    hold.release();
    await expect(sidebarStatus(page)).toContainText('Live');
    await expect(sidebarStatus(page).locator('span.live')).toBeVisible();
  });

  await scenario('live: a failed connect snapshot shows Status needs refresh, never Live, and recovers on the next success', async ({page, fixture, es}) => {
    fixture.setFailure({path: '/vaults/sample-vault/dashboard', status: 500});
    await es.emit('refresh', '{}');
    await expect(sidebarStatus(page)).toContainText('Status needs refresh');
    await page.waitForTimeout(300);
    await expect(sidebarStatus(page)).not.toContainText('Live');
    fixture.setFailure(null);
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await expect(sidebarStatus(page)).toContainText('Live');
  });

  await scenario('live: an invalidate for the selected vault refreshes it once; other vault ids refresh nothing', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const base = dashboardGets(fixture);
    const vaultsBase = getCount(fixture, '/vaults');
    await es.invalidate({account: false, vault_ids: ['old-test-vault', 'another-vault']});
    await es.invalidate({account: false, vault_ids: []});
    await page.waitForTimeout(400);
    assert.equal(dashboardGets(fixture), base, 'other vault ids cause no dashboard request');
    await es.invalidate({account: false, vault_ids: ['old-test-vault', 'sample-vault']});
    await expect.poll(() => dashboardGets(fixture)).toBe(base + 1);
    await page.waitForTimeout(400);
    assert.equal(dashboardGets(fixture), base + 1, 'exactly one dashboard GET');
    assert.equal(getCount(fixture, '/vaults'), vaultsBase, 'a vault-scope event does not refetch the vault list');
  });

  await scenario('live: heartbeat comments and unknown frames never refresh', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const base = dashboardGets(fixture);
    await es.emit('message', ': heartbeat');
    await es.emit('heartbeat', '');
    await page.waitForTimeout(400);
    assert.equal(dashboardGets(fixture), base);
  });

  await scenario('live: an account invalidation refetches the vault list and the selected vault', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const vaultsBase = getCount(fixture, '/vaults');
    const dashboardBase = dashboardGets(fixture);
    await es.invalidate({account: true, vault_ids: []});
    await expect.poll(() => getCount(fixture, '/vaults')).toBe(vaultsBase + 1);
    await expect.poll(() => dashboardGets(fixture)).toBe(dashboardBase + 1);
    await page.waitForTimeout(400);
    assert.equal(getCount(fixture, '/vaults'), vaultsBase + 1);
    assert.equal(dashboardGets(fixture), dashboardBase + 1);
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
  });

  await scenario('live: malformed invalidate data falls back to a full refresh without errors', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const vaultsBase = getCount(fixture, '/vaults');
    await es.invalidate('{not json');
    await expect.poll(() => getCount(fixture, '/vaults')).toBe(vaultsBase + 1);
    await expect(sidebarStatus(page)).toContainText('Live');
  });

  await scenario('live: an account invalidation that drops the selected vault reuses the not-found handling', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    fixture.routes['/vaults'] = {vaults: [fixture.oldVault]};
    const base = dashboardGets(fixture);
    await es.invalidate({account: true, vault_ids: []});
    await expect(page.getByRole('heading', {name: 'Vault not found', level: 2})).toBeVisible();
    await page.waitForTimeout(400);
    assert.equal(dashboardGets(fixture), base, 'the vanished vault is not requested again');
    await expect(page.getByText('Desktop workstation', {exact: true})).toHaveCount(0);
  });

  await scenario('live: a burst of invalidations during an in-flight refresh yields exactly one trailing refresh', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const base = dashboardGets(fixture);
    const hold = fixture.holdNext('/vaults/sample-vault/dashboard');
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await hold.started;
    for (let i = 0; i < 5; i++) await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await page.waitForTimeout(400);
    assert.equal(dashboardGets(fixture), base + 1, 'nothing runs concurrently with the gated request');
    hold.release();
    await expect.poll(() => dashboardGets(fixture)).toBe(base + 2);
    await page.waitForTimeout(600);
    assert.equal(dashboardGets(fixture), base + 2, 'five events collapse into exactly one trailing GET');
  });

  await scenario('live: an account event during a gated vault refresh trails as one full refresh', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const base = dashboardGets(fixture);
    const vaultsBase = getCount(fixture, '/vaults');
    const hold = fixture.holdNext('/vaults/sample-vault/dashboard');
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await hold.started;
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await es.invalidate({account: true, vault_ids: []});
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    hold.release();
    await expect.poll(() => getCount(fixture, '/vaults')).toBe(vaultsBase + 1);
    await expect.poll(() => dashboardGets(fixture)).toBe(base + 2);
    await page.waitForTimeout(600);
    assert.equal(getCount(fixture, '/vaults'), vaultsBase + 1);
    assert.equal(dashboardGets(fixture), base + 2);
  });

  await scenario('live: a manual refresh in flight is never superseded by an event', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    const base = dashboardGets(fixture);
    const hold = fixture.holdNext('/vaults/sample-vault/dashboard');
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    await hold.started;
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await page.waitForTimeout(400);
    assert.equal(dashboardGets(fixture), base + 1);
    hold.release();
    await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
    await expect.poll(() => dashboardGets(fixture)).toBe(base + 2);
    await page.waitForTimeout(500);
    assert.equal(dashboardGets(fixture), base + 2);
  });

  await scenario('live: a stream error shows Reconnecting, announces it and checks the session', async ({page, fixture, es, capture}) => {
    await goLive(page, es, fixture);
    const sessionBase = getCount(fixture, '/auth/session');
    await es.error(false);
    await expect(sidebarStatus(page)).toContainText('Reconnecting\u2026');
    await expect(announcer(page)).toContainText('Reconnecting');
    await expect.poll(() => getCount(fixture, '/auth/session')).toBe(sessionBase + 1);
    await expect(sidebarStatus(page).locator('span.offline')).toBeVisible();
    await capture('sidebar-reconnecting-desktop');
    await es.emit('refresh', '{}');
    await expect(sidebarStatus(page)).toContainText('Live');
    await expect(announcer(page)).toContainText('Live updates connected');
  });

  await scenario('live: a CONNECTING stream error leaves reconnecting to the browser: no second stream, then refresh returns to Live', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    await es.error(false);
    await expect(sidebarStatus(page)).toContainText('Reconnecting\u2026');
    // The controller's own reconnect delay is 5s plus up to 20% jitter; run the page clock past it.
    await page.clock.runFor(7000);
    await expect(sidebarStatus(page)).toContainText('Reconnecting\u2026');
    const counts = await es.counts();
    assert.equal(counts.instances, 1, 'the controller did not open a second stream');
    assert.equal(counts.open, 1, 'the original stream stays open');
    assert.deepEqual(counts.urls, ['/api/v1/dashboard/events']);
    assert.equal(fixture.eventRequests.length, 0, 'no extra events request');
    await es.emit('refresh', '{}');
    await expect(sidebarStatus(page)).toContainText('Live');
    assert.equal((await es.counts()).instances, 1, 'still the same stream');
  }, {prepare: async ({page}) => { await page.clock.install(); }});

  await scenario('live: a 401 after a stream error shows the logged-out screen and closes the stream', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    fixture.setFailure({path: '/auth/session', status: 401});
    await es.error(true);
    await expect(page.getByRole('heading', {name: 'Sign in', exact: true})).toBeVisible();
    await expect(page.locator('.shell')).toHaveCount(0);
    await expect.poll(async () => (await es.counts()).open).toBe(0);
    await page.waitForTimeout(400);
    assert.equal((await es.counts()).instances, 1, 'no reconnect after the session ended');
  });

  await scenario('live: without EventSource the sidebar says Polling every 15s', async ({page, es}) => {
    await expect(sidebarStatus(page)).toContainText('Polling every 15s');
    await expect(announcer(page)).toHaveText('');
    assert.equal(await page.evaluate(() => typeof window.EventSource), 'undefined');
    void es;
  }, {liveMode: 'none'});

  await scenario('live: the real EventSource requests the plain events path with no query string', async ({page, fixture}) => {
    await expect.poll(() => fixture.eventRequests.length).toBeGreaterThanOrEqual(1);
    const [first] = fixture.eventRequests;
    assert.equal(first.method, 'GET');
    assert.equal(first.path, '/dashboard/events');
    assert.equal(first.search, '', 'no query parameters');
    assert.equal(first.credentialsHeader, null, 'no authorization header');
    assert.match(first.accept ?? '', /text\/event-stream/u);
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
  }, {liveMode: 'real'});

  await scenario('live: a conflict draft survives an event-driven refresh', async ({page, fixture, navigate, es}) => {
    await navigate('Conflicts');
    await page.locator('.resolution-policy select').selectOption('manual');
    const draft = page.locator('.manual-file-editor textarea').first();
    await draft.fill('Unsubmitted live draft');
    await goLive(page, es, fixture);
    await expect(draft).toHaveValue('Unsubmitted live draft');
    const base = dashboardGets(fixture);
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await expect.poll(() => dashboardGets(fixture)).toBe(base + 1);
    await page.waitForTimeout(300);
    await expect(draft).toHaveValue('Unsubmitted live draft');
    await expect(page.getByRole('button', {name: 'Review result', exact: true})).toBeVisible();
    await es.invalidate({account: true, vault_ids: []});
    await expect.poll(() => dashboardGets(fixture)).toBe(base + 2);
    await page.waitForTimeout(300);
    await expect(draft).toHaveValue('Unsubmitted live draft');
  });

  await scenario('live: a settings draft survives an event-driven refresh and diagnostics refetch only on Settings', async ({page, fixture, navigate, es}) => {
    await navigate('Settings');
    await expect(page.locator('.diagnostics-settings')).toBeVisible();
    await page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true}).check();
    await page.getByRole('textbox', {name: 'Excluded files and folders', exact: true}).fill('private/\n');
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(1);
    await goLive(page, es, fixture);
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(2);
    await page.waitForTimeout(300);
    assert.equal(getCount(fixture, '/diagnostic-events'), 2, 'the connect refresh refetches diagnostics once even though they are fresh');
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(3);
    await page.waitForTimeout(400);
    assert.equal(getCount(fixture, '/diagnostic-events'), 3, 'one event, one diagnostics refetch');
    await expect(page.getByRole('textbox', {name: 'Excluded files and folders', exact: true})).toHaveValue('private/\n');
    await expect(page.getByRole('checkbox', {name: 'Use shared sync exclusions', exact: true})).toBeChecked();
    page.once('dialog', dialog => dialog.accept());
    await navigate('Overview');
    await page.waitForTimeout(200);
    const onOverview = getCount(fixture, '/diagnostic-events');
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await es.invalidate({account: true, vault_ids: []});
    await page.waitForTimeout(600);
    assert.equal(getCount(fixture, '/diagnostic-events'), onOverview, 'events never fetch diagnostics while Overview is shown');
  });

  await scenario('live: a connect frame within 60s of the last diagnostics fetch refetches them on Settings only', async ({page, fixture, navigate, es}) => {
    await navigate('Settings');
    await expect(page.locator('.diagnostic-card')).toHaveCount(1);
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(1);
    await es.emit('refresh', '{}');
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(2);
    await stable(page, () => getCount(fixture, '/diagnostic-events'));
    assert.equal(getCount(fixture, '/diagnostic-events'), 2, 'one connect, one refetch');
    await navigate('Overview');
    await es.error(false);
    await es.emit('refresh', '{}');
    await stable(page, () => dashboardGets(fixture) * 1000 + getCount(fixture, '/vaults'));
    assert.equal(getCount(fixture, '/diagnostic-events'), 2, 'a connect on Overview never fetches diagnostics');
  });

  await scenario('live: an event on Settings recovers diagnostics whose previous load failed, without a click', async ({page, fixture, navigate, es}) => {
    fixture.setFailure({path: '/diagnostic-events', status: 500});
    await navigate('Settings');
    await expect(page.getByRole('alert').filter({hasText: 'Diagnostics unavailable'})).toBeVisible();
    await expect(page.locator('.diagnostic-card')).toHaveCount(0);
    await goLive(page, es, fixture);
    await expect(page.getByRole('alert').filter({hasText: 'Diagnostics unavailable'})).toBeVisible();
    fixture.setFailure(null);
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await expect(page.locator('.diagnostic-card')).toHaveCount(1);
    await expect(page.getByRole('alert').filter({hasText: 'Diagnostics unavailable'})).toHaveCount(0);
  });

  await scenario('live: an automatic diagnostics refetch keeps loaded pages and offers a manual refresh instead', async ({page, fixture, navigate, es}) => {
    let pageTwoRequests = 0;
    await page.route(/\/api\/v1\/diagnostic-events\?cursor=/u, async route => {
      pageTwoRequests++;
      const [first] = fixture.routes['/diagnostic-events'].events;
      await route.fulfill({status: 200, json: {ingestion_enabled: false, retention_days: 30, events: [{...first, event_id: 'sample-diagnostic-1', flow: 'older-page'}], next_cursor: null}});
    });
    fixture.routes['/diagnostic-events'] = {...fixture.routes['/diagnostic-events'], next_cursor: 'cursor-page-2'};
    await navigate('Settings');
    await expect(page.locator('.diagnostic-card')).toHaveCount(1);
    await goLive(page, es, fixture);
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(2);
    await page.getByRole('button', {name: 'Load more', exact: true}).click();
    await expect(page.locator('.diagnostic-card')).toHaveCount(2);
    assert.equal(pageTwoRequests, 1);
    await expect(page.locator('.diagnostics-new-activity')).toHaveCount(0);
    const firstPageGets = getCount(fixture, '/diagnostic-events');
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await expect(page.getByRole('button', {name: 'New activity \u2014 Refresh diagnostics', exact: true})).toBeVisible();
    await stable(page, () => dashboardGets(fixture));
    assert.equal(getCount(fixture, '/diagnostic-events'), firstPageGets, 'the automatic refetch did not request the first page');
    await expect(page.locator('.diagnostic-card')).toHaveCount(2);
    await es.invalidate({account: false, vault_ids: ['sample-vault']});
    await stable(page, () => dashboardGets(fixture));
    await expect(page.locator('.diagnostic-card')).toHaveCount(2);
    await page.getByRole('button', {name: 'New activity \u2014 Refresh diagnostics', exact: true}).click();
    await expect.poll(() => getCount(fixture, '/diagnostic-events')).toBe(firstPageGets + 1);
    await expect(page.locator('.diagnostic-card')).toHaveCount(1);
    await expect(page.locator('.diagnostics-new-activity')).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Load more', exact: true})).toBeVisible();
  });

  await scenario('live: logout closes the stream and the next login opens exactly one', async ({page, fixture, es}) => {
    await goLive(page, es, fixture);
    assert.deepEqual({instances: (await es.counts()).instances, open: (await es.counts()).open}, {instances: 1, open: 1});
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
    await expect.poll(async () => (await es.counts()).open).toBe(0);
    const base = dashboardGets(fixture);
    await es.emit('invalidate', JSON.stringify({account: true, vault_ids: []}));
    await page.waitForTimeout(300);
    assert.equal(dashboardGets(fixture), base, 'a late event after logout refreshes nothing');
    await page.getByRole('textbox', {name: 'Username', exact: true}).fill('fixture-owner');
    await page.getByLabel('Password', {exact: true}).fill('fixture-only');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page.getByText('Desktop workstation', {exact: true}).first()).toBeVisible();
    await expect.poll(async () => (await es.counts()).instances).toBe(2);
    const counts = await es.counts();
    assert.equal(counts.open, 1, 'exactly one stream after signing back in');
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    await goLive(page, es, fixture);
  });

  await scenario('live: Live and Reconnecting fit the 390px drawer without overflow', async ({page, fixture, es, capture}) => {
    const fits = async label => {
      const layout = await page.evaluate(() => {
        const status = document.querySelector('.sidebar-status');
        return {doc: document.documentElement.scrollWidth, width: innerWidth, status: status.scrollWidth, box: status.clientWidth, right: status.getBoundingClientRect().right, drawer: document.querySelector('.app-sidebar').getBoundingClientRect().right};
      });
      assert.ok(layout.doc <= layout.width + 1, `${label}: no document overflow`);
      assert.ok(layout.status <= layout.box + 1, `${label}: status text fits its box`);
      assert.ok(layout.right <= layout.drawer + 1, `${label}: status stays inside the drawer`);
    };
    await page.getByRole('button', {name: 'Open navigation', exact: true}).click();
    await expect(page.locator('.app-sidebar')).not.toHaveAttribute('inert', '');
    await expect(sidebarStatus(page)).toContainText('Connecting\u2026');
    await fits('Connecting');
    await es.emit('refresh', '{}');
    await expect(sidebarStatus(page)).toContainText('Live');
    await fits('Live');
    await capture('sidebar-live-390');
    await es.error(false);
    await expect(sidebarStatus(page)).toContainText('Reconnecting\u2026');
    await fits('Reconnecting');
    await capture('sidebar-reconnecting-390');
    void fixture;
  }, {viewport: {width: 390, height: 844}});

  // Health honesty: server rows for a non-verified sample say "unknown"/"checking" and carry the sample time or null.
  const healthVariants = {
    verified: {health: {state: 'verified', status: 'ready', stale: false, checking: false}, summary: 'Ready', header: 'Synced'},
    stale: {health: {state: 'stale', status: 'not_ready', stale: true, checking: false, detail: 'The last readiness check is out of date.'}, summary: 'Status out of date', header: 'Status out of date'},
    pending: {health: {state: 'pending', status: 'not_ready', stale: true, checking: false, checked_at: null, detail: 'Readiness has not been checked yet.'}, summary: 'Not checked yet', header: 'Not checked yet'},
    failed: {health: {state: 'failed', status: 'not_ready', stale: false, checking: false, detail: 'The last readiness check could not complete.'}, summary: 'Check could not complete', card: 'Check failed', header: 'Check could not complete'}
  };
  function applyHealth(fixture, name, extra = {}) {
    const variant = healthVariants[name];
    const base = {...fixture.summary.health, ...variant.health, ...extra};
    const observed = name === 'verified';
    fixture.summary.health = {...base, checks: Object.fromEntries(Object.keys(fixture.summary.health.checks).map(key => [key, observed]))};
    fixture.summary.maintenance = fixture.summary.maintenance.map(row => ({
      ...row,
      status_label: observed ? 'Synced' : base.checking ? 'Checking' : 'Status unknown',
      last_checked_at: base.checked_at,
      detail: observed ? row.detail : base.detail ?? 'Readiness is not verified.'
    }));
  }
  const readiness = page => page.locator('section.summary', {hasText: 'Server readiness'});

  for (const name of ['stale', 'pending', 'failed']) {
    await scenario(`health: a ${name} sample is never shown as healthy on Overview or Maintenance`, async ({page, fixture, navigate, capture}) => {
      const variant = healthVariants[name];
      // The compact Overview card may use a shorter label than the attention list and Maintenance header.
      await expect(readiness(page).locator('strong')).toHaveText(variant.card ?? variant.summary);
      await expect(readiness(page)).not.toContainText('Ready');
      if (name === 'failed') {
        await expect(readiness(page).locator('.summary-detail')).toContainText('could not complete');
        const heights = await page.locator('.summary-strip .summary strong').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
        assert.ok(Math.max(...heights) - Math.min(...heights) <= 2, `summary headings stay on one line: ${heights.join(',')}`);
      }
      await expect(page.locator('.attention')).toContainText(variant.summary);
      await expect(page.locator('.maintenance-checks')).toHaveAttribute('open', '');
      await expect(page.locator('.maintenance-checks .status.success')).toHaveCount(0);
      await expect(page.locator('.maintenance-checks')).toContainText(name === 'pending' ? 'Never checked' : 'Checked');
      await capture(`health-${name}-overview`);
      await navigate('Maintenance');
      await expect(page.locator('.maintenance-health')).toContainText(variant.header);
      await expect(page.locator('.maintenance-health .status.success')).toHaveCount(0);
      await expect(page.locator('.maintenance-health')).not.toContainText('Synced');
      await expect(page.locator('.maintenance-health-detail')).toContainText(name === 'pending' ? 'not been checked' : name === 'stale' ? 'out of date' : 'could not complete');
      await expect(page.locator('.maintenance-health-detail')).not.toHaveAttribute('role', 'alert');
      await expect(page.locator('.checklist .status.success')).toHaveCount(0);
      await expect(page.locator('.checklist')).toContainText('Status unknown');
      await expect(page.locator('.checklist small').first()).toHaveText(/[^.\s] \u00b7 (Checked|Never checked)/u);
      if (name === 'pending') {
        await expect(page.locator('.checklist')).toContainText('Never checked');
        await expect(page.locator('.checklist')).not.toContainText('Invalid Date');
        await expect(page.locator('.maintenance-health')).toContainText('Never checked');
      } else {
        await expect(page.locator('.maintenance-health .health-checked')).toContainText(/Checked (just now|\d+[smh] ago)/u);
      }
      await capture(`health-${name}-maintenance`);
    }, {prepare: async ({fixture}) => applyHealth(fixture, name, name === 'stale' ? {checked_at: new Date(Date.now() - 20 * 60000).toISOString()} : {})});
  }

  await scenario('health: a verified sample shows Ready with a relative age and an absolute title', async ({page, navigate, capture}) => {
    await expect(readiness(page)).toContainText('Ready');
    await expect(readiness(page)).toContainText(/Checked (just now|\d+[smh] ago)/u);
    await expect(page.locator('.attention')).not.toContainText(/Status out of date|Not checked yet|Check could not complete|Integrity failure/u);
    await expect(page.locator('.maintenance-checks')).not.toHaveAttribute('open', '');
    await navigate('Maintenance');
    await expect(page.locator('.maintenance-health .status.success')).toContainText('Synced');
    const checked = page.locator('.maintenance-health .health-checked');
    await expect(checked).toContainText(/Checked (just now|\d+[smh] ago)/u);
    const title = await checked.getAttribute('title');
    assert.ok(title && title !== 'Never checked' && !/Invalid/u.test(title), 'absolute time title');
    await expect(page.locator('.maintenance-health .health-checking')).toHaveCount(0);
    await expect(page.locator('.checklist .status.success').first()).toBeVisible();
    await capture('health-verified-maintenance');
  });

  await scenario('health: a running check is annotated without changing the verdict', async ({page, navigate}) => {
    await expect(readiness(page)).toContainText('Ready');
    await expect(readiness(page)).toContainText('Checking\u2026');
    await navigate('Maintenance');
    await expect(page.locator('.maintenance-health .health-checking')).toHaveText('Checking\u2026');
    await expect(page.locator('.maintenance-health .status.success')).toContainText('Synced');
  }, {prepare: async ({fixture}) => { fixture.summary.health = {...fixture.summary.health, checking: true}; }});

  await scenario('health: a maintenance row without a check time says Never checked, never a date', async ({page, navigate}) => {
    await navigate('Maintenance');
    await expect(page.locator('.checklist')).toContainText('Never checked');
    await expect(page.locator('.checklist')).not.toContainText(/Invalid Date|1970|1\/1\/70/u);
  }, {prepare: async ({fixture}) => { fixture.summary.maintenance = fixture.summary.maintenance.map(row => ({...row, last_checked_at: null})); }});

  await scenario('name repair: attention opens a reviewed, stale-safe rename for Android devices', async ({page, fixture, navigate, capture}) => {
    const attention = page.locator('.attention');
    await expect(attention).toContainText("6 file names can't sync to Android");
    await expect(attention).not.toContainText('Blocked device: Android phone');
    await capture('name-repair-overview');
    await attention.getByRole('button', {name: 'Repair names', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Devices', level: 1, exact: true})).toBeVisible();
    const panel = page.locator('section.name-repair');
    await expect(panel.getByRole('heading', {name: 'File names need repair'})).toBeVisible();
    await expect(panel.locator('.name-repair-devices li.blocked')).toContainText('Android phone');
    await expect(panel.locator('.name-repair-devices li.blocked')).toContainText('Sync paused until the names are repaired');
    await expect(page.locator('.device-table')).toContainText('Out of sync — file names need repair');
    const apply = panel.getByRole('button', {name: /^(Apply repair|Rename \d+ items?)$/u});
    await expect(apply).toBeDisabled();
    await capture('name-repair-devices');
    await panel.getByRole('button', {name: 'Preview repair', exact: true}).click();
    await expect(panel.locator('.name-repair-table tbody tr')).toHaveCount(6);
    await expect(panel.locator('.name-repair-facts')).toContainText('Renames6');
    await expect(panel.locator('.name-repair-facts')).toContainText('Links rewritten6');
    await expect(panel.locator('.name-repair-table')).toContainText('Meeting - Q3 plan.md');
    await expect(panel.locator('.name-repair-table')).toContainText('Case clash');
    await expect(apply).toHaveText('Rename 6 items');
    await panel.locator('.name-repair-links summary').click();
    await expect(panel.locator('.name-repair-links')).toContainText('Projects/Index.md');
    await capture('name-repair-preview');
    await page.setViewportSize({width: 390, height: 900});
    await expect(panel.locator('.name-repair-table thead')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `name repair panel fits a phone viewport (overflow ${overflow}px)`);
    await capture('name-repair-preview-mobile');
    await page.setViewportSize({width: 1440, height: 1000});
    fixture.nameRepair.staleNext = true;
    await apply.click();
    await expect(panel.getByRole('status')).toContainText('The vault changed after this preview');
    await expect(panel.locator('.name-repair-table')).toHaveCount(0);
    await expect(apply).toBeDisabled();
    await panel.getByRole('button', {name: 'Preview repair', exact: true}).click();
    await expect(apply).toHaveText('Rename 6 items');
    await apply.click();
    await expect(page.locator('.notice')).toContainText('Renamed 6 items and updated links in 3 notes. Devices pick up the new names on their next sync.');
    await expect(panel).toHaveCount(0);
    const applied = fixture.requests.filter(request => request.method === 'POST' && request.path === '/vaults/sample-vault/name-repair');
    assert.equal(applied.length, 2, 'stale attempt plus the reviewed apply');
    assert.deepEqual(fixture.nameRepair.applied, {expected_main: fixture.main ?? 'a14f802ef33a591076d34504551bd5473a71000c', preview_tree: 'd'.repeat(40), review_fingerprint: 'e'.repeat(64)});
    assert.ok(applied.every(request => request.csrf !== null), 'apply sends the CSRF header');
    await expect(page.locator('.device-table')).not.toContainText('file names need repair');
    await navigate('Overview');
    await expect(page.locator('.attention')).not.toContainText("can't sync to Android");
    await capture('name-repair-done');
  }, {prepare: async ({fixture}) => { fixture.enableNameRepair(); }});

  await scenario('name repair: the preview stays legible in dark mode', async ({page, navigate, capture}) => {
    await navigate('Devices');
    const panel = page.locator('section.name-repair');
    await panel.getByRole('button', {name: 'Preview repair', exact: true}).click();
    await expect(panel.locator('.name-repair-table tbody tr')).toHaveCount(6);
    await capture('name-repair-preview-dark');
  }, {colorScheme: 'dark', prepare: async ({fixture}) => { fixture.enableNameRepair(); }});

  await scenario('name repair: the panel stays hidden while every name is portable', async ({page, navigate}) => {
    await expect(page.locator('.attention')).not.toContainText("can't sync to Android");
    await navigate('Devices');
    await expect(page.locator('section.name-repair')).toHaveCount(0);
  });

  console.log(`${count-failures}/${count} dashboard browser scenarios passed.`);
  if(failures) process.exitCode=1;
} finally {await browser?.close();await server.close();await rm(cache,{recursive:true,force:true});}
