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
  async function scenario(name, run, options = {}) {
    count++;
    const {initialPath = '', prepare, ...contextOptions} = options;
    const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'en-GB',...contextOptions});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    const fixture = createFixtures();
    await fixture.install(page);
    if (prepare) await prepare({page, fixture});
    async function capture(name) {
      if (screenshots) await page.screenshot({path: join(screenshots, `${name}.png`), fullPage: true, animations: 'disabled'});
    }
    async function navigate(name) {
      const button = page.locator('nav').getByRole('button',{name:new RegExp(`^${name}`)});
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
      await run({page,fixture,navigate,context,capture});
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
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
    await expect(page.getByRole('button',{name:'Resolve conflict',exact:true})).toHaveCount(0);
  });

  await scenario('manual refresh owns its request while focus polling is suppressed',async({page,fixture})=>{
    const before=fixture.requests.filter(request=>request.path.endsWith('/dashboard')).length;
    fixture.setDelay(200);
    const requested=page.waitForRequest('**/api/v1/vaults/sample-vault/dashboard');
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await requested;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
    assert.equal(fixture.requests.filter(request=>request.path.endsWith('/dashboard')).length,before+1);
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
    await expect(page.getByRole('button', {name: 'Resolve conflict', exact: true})).toHaveCount(0);
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
      await expect(page.getByRole('button', {name: 'Resolve conflict', exact: true})).toHaveCount(0);
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
    await page.locator('nav').getByRole('button', {name: 'Devices', exact: true}).focus();
    await page.setViewportSize({width: 390, height: 844});
    await expect(page.getByRole('button', {name: 'Open navigation', exact: true})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', {name: 'Close navigation', exact: true})).toBeFocused();
    await page.setViewportSize({width: 1440, height: 1000});
    await expect(page.getByRole('heading', {name: 'Overview', level: 1, exact: true})).toBeFocused();
  });

  await scenario('remaining pages stay compact and fit responsive widths', async ({page, navigate}) => {
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      for (const view of ['History', 'Maintenance', 'Settings']) {
        await navigate(view);
        const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
        assert.ok(layout.scroll <= layout.width + 1, `${view} at ${width}: no document overflow`);
      }
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
      await navigate('Settings');
      const diagnostics = page.locator('.diagnostics-settings');
      const pending = page.waitForRequest('**/api/v1/diagnostic-events');
      await diagnostics.getByRole('button', {name: 'Refresh', exact: true}).click();
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

  await scenario('vault deletion requires the exact full-ID phrase and states server-only consequences', async ({page, fixture}) => {
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
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
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await expect(page.locator('[aria-labelledby="vault-deletions-title"]')).toContainText('No pending or recent server vault deletions.');
  });

  await scenario('backup requirements are reachable from Overview',async({page})=>{
    const button=page.getByRole('button',{name:'Backup requirements',exact:true});
    await button.click();
    await expect(page.getByRole('heading',{name:'Maintenance',level:1,exact:true})).toBeVisible();
    await expect(page.getByText('Backups must cover metadata and the server Git store', {exact:false})).toBeVisible();
  });
  console.log(`${count-failures}/${count} dashboard browser scenarios passed.`);
  if(failures) process.exitCode=1;
} finally {await browser?.close();await server.close();await rm(cache,{recursive:true,force:true});}
