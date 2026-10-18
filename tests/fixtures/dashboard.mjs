const rawServerText = 'Raw server text that must never be shown.';
const errorEnvelope = (code, details = {}) => ({error: {code, message: rawServerText, request_id: 'fixture-request', details}});
const errorResponse = (status, code, details = {}, headers = {}) => ({status, headers, body: errorEnvelope(code, details)});

/**
 * Scripted DELETE responses that mirror the server's real error envelope, codes and details. Pass them to
 * `scriptRemovalResponses`; `succeeds()` performs the real removal (optionally held back by a `gate` promise).
 */
export const removalResponses = {
  succeeds: (extra = {}) => ({status: 200, ...extra}),
  notFound: () => errorResponse(404, 'not_found'),
  notRevoked: () => errorResponse(409, 'device_not_revoked'),
  confirmationMismatch: () => errorResponse(400, 'confirmation_mismatch'),
  unmergedWork: (reason = 'device_ref') => errorResponse(409, 'device_has_unmerged_work', {reason}),
  openWork: (reason = 'open_conflict') => errorResponse(409, 'device_has_open_work', {reason}),
  refInconsistent: ({discardPhrase = false} = {}) => errorResponse(409, 'device_ref_inconsistent', discardPhrase ? {retryable: false, reason: 'ref_missing', resolution: 'discard_phrase'} : {retryable: false}),
  vaultDeleting: () => errorResponse(409, 'vault_deleting'),
  nonRetryable: (code = 'device_removal_blocked') => errorResponse(409, code, {retryable: false}),
  unavailable: (retryAfter = 2) => errorResponse(503, 'device_removal_unavailable', {retryable: true}, {'retry-after': String(retryAfter)}),
  incomplete: () => errorResponse(503, 'device_removal_incomplete', {retryable: true}, {'retry-after': '2'}),
  internal: () => errorResponse(500, 'internal_error'),
  forbidden: () => errorResponse(403, 'forbidden')
};

export function createFixtures() {
  const now = new Date().toISOString();
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const main = 'a14f802ef33a591076d34504551bd5473a71000c';
  const vault = {vault_id:'sample-vault',display_name:'Personal notes',owner_user_id:'sample-owner',current_main:main,status:'active',created_at:ago(8000),updated_at:now};
  const oldVault = {...vault,vault_id:'old-test-vault',display_name:'Old test vault',current_main:'f'.repeat(40)};
  const devices = ['Desktop workstation','Travel laptop','Android phone'].map((name,i)=>({device_id:`sample-device-${i}`,device_name:name,status:'active',revoked_at:null,removal:null,status_label:['Synced','Applying','Offline'][i],last_seen_at:ago([0,1,360][i]),device_ref_head:main,last_applied_main:main,last_successful_sync_at:ago([2,15,360][i]),local_status_label:['Synced','Applying','Synced'][i],local_error_code:null,local_queue_status:i===1?'applying':null,local_main:main,local_head:main,plugin_version:i===2?'0.3.23':'0.3.25',path_capabilities:null,last_status_report_at:ago([0,1,360][i]),status_report_fresh:i!==2,status_report_age_seconds:[5,30,21600][i],ahead_of_main:false,behind_main:i===1,blocked:false,offline:i===2}));
  const conflict = {conflict_id:'sample-conflict',vault_id:vault.vault_id,device_id:devices[1].device_id,device_name:devices[1].device_name,conflict_type:'Content conflict',stale:false,status_label:'Review needed',status:'open',base_commit:'1'.repeat(40),current_main:main,device_commit:'2'.repeat(40),expected_main:main,affected_paths:['Projects/Weekend plans.md','Notes/Reading list.md'],affected_path_count:2,merge_sequence:7,merge_policy_version:'1',conflict_kind:'content',validator_results:{},validator_summary:{},created_at:ago(10)};
  const files = conflict.affected_paths.map((path,i)=>({path,content_kind:'text',base_content:i?'# Reading list\n\n- The Dispossessed\n':'# Weekend plans\n\n- Visit the market\n- Read a book\n',server_content:i?'# Reading list\n\n- The Dispossessed\n- Piranesi\n':'# Weekend plans\n\n- Visit the market on Saturday\n- Read a book\n',device_content:i?'# Reading list\n\n- The Dispossessed\n- Solaris\n':'# Weekend plans\n\n- Visit the market on Sunday\n- Read a book\n',base_bytes:51,server_bytes:63,device_bytes:61,base_sha256:'1'.repeat(64),server_sha256:'2'.repeat(64),device_sha256:'3'.repeat(64),source_diff:'',rendered_markdown_diff:null}));
  const review = {conflict,stale:false,expected_main:main,current_main:main,device_name:devices[1].device_name,path_conflicts:files.map((f,i)=>({group_id:`path-${i}`,kind:'same_path',base_path:f.path,server_path:f.path,device_path:f.path,server_operation:'modified',device_operation:'modified',affected_paths:[f.path]})),files,directory_conflicts:[],choices:['keep_server','use_device','keep_both_files','insert_both_blocks','manual']};
  const checks = ['metadata_store','git_store','temp_workspace','migrations','git','filesystem_permissions','event_delivery','persistent_state'];
  const labels = ['Metadata database','Server Git store','Temporary workspace','Migrations','Native Git','Filesystem permissions','Event delivery','Persistent-state backup contract'];
  const summary = {vault,devices,recommended_plugin_version:'0.3.25',unresolved_conflict_count:1,conflicts:[conflict],recent_activity:['Device synchronized','Changes merged into server main','Conflict recorded','Device connected'].map((label,i)=>({event_id:`sample-event-${i}`,event_seq:100-i,event_type:'sample',label,created_at:ago(i*8),device_id:devices[i%3].device_id,main})),maintenance:checks.map((key,i)=>({key,label:labels[i],status_label:'Synced',last_checked_at:now,detail:i===7?'Backup must include metadata and Git stores.':'Check passed',...(i===1?{action:'start_git_maintenance'}:i===7?{action:'view_backup_contract'}:{})})),health:{status:'ready',checks:Object.fromEntries(checks.map(k=>[k,true])),detail:null,git_version:'git version 2.49.0',checked_at:ago(1),checking:false,stale:false,state:'verified'}};
  summary.name_portability = {rule_version:1,restricted_platforms:['android'],unportable_path_count:0,restricted_devices:[{device_id:devices[2].device_id,device_name:devices[2].device_name,platform:'android',blocked:false}]};
  const oldSummary = {...summary,vault:oldVault,devices:[],conflicts:[],unresolved_conflict_count:0,recent_activity:[],name_portability:{...summary.name_portability,restricted_devices:[]}};
  const nameRepair = {staleNext:false,applied:null,preview:{vault_id:vault.vault_id,rule_version:1,expected_main:main,preview_tree:'d'.repeat(40),review_fingerprint:'e'.repeat(64),changes_main:true,
    renames:[
      {from:'Inbox/Meeting: Q3 plan.md',to:'Inbox/Meeting - Q3 plan.md',kind:'file',reasons:['reserved_characters']},
      {from:'Notes/todo.md',to:'Notes/todo (2).md',kind:'file',reasons:['case_collision']},
      {from:'Projects/Why? Ideas.md',to:'Projects/Why Ideas.md',kind:'file',reasons:['reserved_characters']},
      {from:'Reading/"Piranesi" notes.md',to:"Reading/'Piranesi' notes.md",kind:'file',reasons:['reserved_characters']},
      {from:'Recipes/Pasta | quick.md',to:'Recipes/Pasta - quick.md',kind:'file',reasons:['reserved_characters']},
      {from:'Travel/lisbon',to:'Travel/Lisbon',kind:'directory',reasons:['case_collision']}
    ],
    link_updates:[{path:'Daily/2026-10-12.md',link_count:3},{path:'Home.canvas',link_count:1},{path:'Projects/Index.md',link_count:2}]}};
  function enableNameRepair() {
    summary.name_portability.unportable_path_count = 6;
    summary.name_portability.restricted_devices[0].blocked = true;
    Object.assign(devices[2],{status_label:'Out of sync — file names need repair',local_status_label:'Out of sync — file names need repair',local_error_code:'unportable_target_paths',status_report_fresh:true,status_report_age_seconds:20,last_seen_at:ago(0),last_status_report_at:ago(0),offline:false,blocked:true,plugin_version:'0.3.25'});
  }
  const syncSettings = {vault_id:vault.vault_id,current_main:main,root_ignore_oid:null,root_ignore:null,metadata_conflict_rules:[]};
  const diagnostic = {event_id:'sample-diagnostic-0',plugin_version:'0.3.25',obsidian_version:'1.8.0',platform_family:'linux',flow:'sync',stage:'upload',failure_code:'sample_failure',error_class:'network',retryable:true,breadcrumbs:[{point:'request',outcome:'failed',value_kind:'none',size_bucket:'small',error_code:'timeout'}],received_at:now};
  const routes = {'/setup/status':{setup_complete:true},'/auth/session':{user_id:'sample-owner',csrf_token:'',recent_auth_expires_at:'2099-01-01T00:00:00Z'},'/vaults':{vaults:[vault,oldVault]},'/vault-deletions':{deletions:[]},'/diagnostic-events':{ingestion_enabled:false,retention_days:30,events:[diagnostic],next_cursor:null},'/vaults/sample-vault/dashboard':summary,'/vaults/old-test-vault/dashboard':oldSummary,'/vaults/sample-vault/sync-settings':syncSettings,'/vaults/old-test-vault/sync-settings':{...syncSettings,vault_id:oldVault.vault_id,current_main:oldVault.current_main},'/vaults/sample-vault/conflicts':{conflicts:[conflict]},'/vaults/old-test-vault/conflicts':{conflicts:[]},'/vaults/sample-vault/conflicts/sample-conflict':review};
  const requests = [];
  const eventRequests = [];
  const holds = [];
  const unexpected = [];
  let failure = null;
  let delay = 0;
  const removalScript = [];
  async function install(page) {
    await page.route('**/api/v1/**',async route=>{
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api/v1','');
      const method = request.method();
      if(path==='/dashboard/events'){
        // Only reached when a scenario lets the browser open its real EventSource; recorded apart from `requests`.
        const url = new URL(request.url());
        eventRequests.push({method,path,search:url.search,accept:request.headers().accept ?? null,credentialsHeader:request.headers().authorization ?? null});
        await route.fulfill({status:200,headers:{'content-type':'text/event-stream','cache-control':'no-store'},body:'retry: 5000\n\nevent: refresh\ndata: {}\n\n'});
        return;
      }
      let body = null;
      try { body = request.postDataJSON(); } catch {}
      requests.push({method,path,csrf:request.headers()['x-obts-csrf'] ?? null,body});
      const hold = holds.find(candidate=>!candidate.used&&candidate.method===method&&candidate.path===path);
      if(hold){hold.used=true;hold.markStarted();await hold.gate;}
      if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
      if(failure && (!failure.path || failure.path===path)) {
        await route.fulfill({status:failure.status ?? 503,json:{error:{code:'fixture_unavailable',message:'The sample server is temporarily unavailable.'}}});
        return;
      }
      const dashboardMatch = path.match(/^(\/vaults\/[^/]+)\/dashboard$/u);
      if(method==='GET'&&dashboardMatch&&routes[path]!==undefined){
        const listed = routes[`${dashboardMatch[1]}/conflicts`];
        await route.fulfill({status:200,json:listed ? {...routes[path],conflicts:listed.conflicts} : routes[path]});return;
      }
      if(method==='GET'&&routes[path]!==undefined){await route.fulfill({status:200,json:routes[path]});return;}
      if(method==='POST'&&path==='/auth/login'){await route.fulfill({status:200,json:routes['/auth/session']});return;}
      if(method==='POST'&&path==='/vaults/sample-vault/sync-settings/preview'){
        const body=request.postDataJSON();
        const fingerprint='b'.repeat(64);
        await route.fulfill({status:200,json:{vault_id:'sample-vault',expected_main:body.expected_main,expected_root_ignore_oid:null,preview_tree:main,review_fingerprint:fingerprint,root_ignore_oid:null,affected_paths:[],affected_directories:[],metadata_conflict_rules:body.metadata_conflict_rules,changes_main:false}});return;
      }
      if(method==='PUT'&&path==='/vaults/sample-vault/sync-settings'){
        const body=request.postDataJSON();
        if(body.review_fingerprint!=='b'.repeat(64)){await route.fulfill({status:409,json:{error:{code:'stale_settings',message:'Review settings again.'}}});return;}
        Object.assign(syncSettings,{root_ignore:body.root_ignore,metadata_conflict_rules:body.metadata_conflict_rules});
        await route.fulfill({status:200,json:syncSettings});return;
      }
      if(method==='POST'&&path==='/vaults/sample-vault/name-repair/preview'){
        await route.fulfill({status:200,json:{...nameRepair.preview,expected_main:vault.current_main}});return;
      }
      if(method==='POST'&&path==='/vaults/sample-vault/name-repair'){
        const body=request.postDataJSON();
        if(nameRepair.staleNext||body.expected_main!==vault.current_main||body.review_fingerprint!==nameRepair.preview.review_fingerprint){
          nameRepair.staleNext=false;
          await route.fulfill({status:409,json:{error:{code:'stale_name_repair',message:'The vault changed since the preview; review the repair again.'}}});return;
        }
        const previous=vault.current_main;
        vault.current_main='c'.repeat(40);
        summary.name_portability.unportable_path_count=0;
        summary.name_portability.restricted_devices[0].blocked=false;
        Object.assign(devices[2],{status_label:'Synced',local_status_label:'Synced',local_error_code:null,blocked:false,last_applied_main:vault.current_main,local_main:vault.current_main});
        nameRepair.applied=body;
        await route.fulfill({status:200,json:{vault_id:vault.vault_id,previous_main:previous,current_main:vault.current_main,renamed_count:nameRepair.preview.renames.length,link_updated_count:nameRepair.preview.link_updates.length}});return;
      }
      if(method==='POST'&&path==='/auth/reauthenticate'){await route.fulfill({status:200,json:routes['/auth/session']});return;}
      if(method==='POST'&&path==='/vaults/sample-vault/history/query'){
        await route.fulfill({status:200,json:{path:'Notes/Sample.md',current_main:main,versions:[{commit:main,parent_commit:'1'.repeat(40),tree:'2'.repeat(40),path:'Notes/Sample.md',operation_type:'update',timestamp:now,author_name:'Sample owner',author_email:'',subject:'Sample note update'}]}});return;
      }
      if(method==='POST'&&path==='/vaults/sample-vault/history/version'){
        await route.fulfill({status:200,json:{path:'Notes/Sample.md',commit:main,content:'Sample content from vault A',source_diff:'Sample content from vault A',rendered_markdown_diff:null,metadata_only:false,content_redacted:false}});return;
      }
      const deviceMatch = path.match(/^\/vaults\/sample-vault\/devices\/([^/]+)(\/revoke)?$/u);
      if(deviceMatch){
        const device = devices.find(device=>device.device_id===deviceMatch[1]);
        if(device&&method==='PATCH'&&!deviceMatch[2]) {
          const body = request.postDataJSON();
          if(!body.device_name?.trim()) {await route.fulfill({status:400,json:{error:{code:'invalid_request',message:'Enter a device name.'}}});return;}
          device.device_name=body.device_name;
          await route.fulfill({status:200,json:{device_id:device.device_id,device_name:device.device_name}});return;
        }
        if(device&&method==='POST'&&deviceMatch[2]) {device.status='revoked';device.status_label='Offline';device.revoked_at=new Date().toISOString();await route.fulfill({status:200,json:{status:'ok'}});return;}
        if(method==='DELETE'&&!deviceMatch[2]) {
          const scripted = removalScript.shift();
          if(scripted) {
            if(scripted.gate) await scripted.gate;
            if(scripted.status===200&&scripted.body===undefined) {
              if(device) devices.splice(devices.indexOf(device),1);
              await route.fulfill({status:200,headers:scripted.headers ?? {},json:{status:'removed',device_id:deviceMatch[1]}});return;
            }
            await route.fulfill({status:scripted.status,headers:scripted.headers ?? {},json:scripted.body});return;
          }
          const refuse = response => route.fulfill({status:response.status,headers:response.headers,json:response.body});
          if(!device) {await refuse(removalResponses.notFound());return;}
          if(device.status!=='revoked'&&device.revoked_at===null) {await refuse(removalResponses.notRevoked());return;}
          const requested = request.postDataJSON();
          const expected = requested?.discard_unmerged===true ? `DELETE ${device.device_id} AND DISCARD UNMERGED WORK` : `DELETE ${device.device_id}`;
          if(requested?.confirmation!==expected) {await refuse(removalResponses.confirmationMismatch());return;}
          devices.splice(devices.indexOf(device),1);
          await route.fulfill({status:200,json:{status:'removed',device_id:device.device_id}});return;
        }
      }
      if(method==='POST'&&path==='/auth/logout'){await route.fulfill({status:200,json:{status:'ok'}});return;}
      if(method==='DELETE'&&path==='/vaults/sample-vault'){
        const requested = request.postDataJSON();
        if(requested?.confirmation !== 'DELETE sample-vault') { await route.fulfill({status:400,json:{error:{code:'invalid_confirmation',message:'Type the exact vault confirmation phrase.'}}}); return; }
        const status = {vault_id:'sample-vault',status:'deleting',requested_at:now,completed_at:null,receipt_expires_at:null,retry_at:null,error_code:null};
        routes['/vault-deletions'] = {deletions:[status]};
        vault.status = 'deleting';
        summary.vault.status = 'deleting';
        await route.fulfill({status:202,json:status});
        return;
      }
      if(method==='DELETE'&&path==='/diagnostic-events'){await route.fulfill({status:200,json:{deleted_count:routes['/diagnostic-events'].events.length}});return;}
      if(method==='POST'&&path==='/vaults/sample-vault/conflicts/sample-conflict/preview'){
        const body = request.postDataJSON();
        const kind = body.resolution_kind;
        const tree = 'e'.repeat(40);
        const files = review.files.map(file=>{
          const base = {path:file.path,source_path:null,content_kind:'text',bytes:null,sha256:null,content:null,provenance:'server',operation:'retained'};
          if(kind==='use_device') return {...base,provenance:'device',operation:'updated',content:file.device_content,bytes:file.device_bytes,sha256:file.device_sha256};
          if(kind==='keep_both_files') return {...base,provenance:'device',operation:'copied',source_path:file.path,path:file.path.replace(/(\.[^.]+)$/u,'.device-abcdef12-conflict$1'),content:file.device_content,bytes:file.device_bytes};
          if(kind==='insert_both_blocks') return {...base,provenance:'both',operation:'updated',content:`## Server version\n\n${file.server_content}\n## Device version\n\n${file.device_content}`,bytes:(file.server_bytes??0)+(file.device_bytes??0)};
          if(kind==='manual'){
            const value = Object.prototype.hasOwnProperty.call(body.manual_files ?? {},file.path) ? body.manual_files[file.path] : '';
            if(value===null) return {...base,operation:'deleted',provenance:'manual',content:null};
            return {...base,operation:'updated',provenance:'manual',content:value,bytes:value.length};
          }
          return {...base,content:file.server_content,bytes:file.server_bytes,sha256:file.server_sha256};
        });
        await route.fulfill({status:200,json:{conflict_id:'sample-conflict',resolution_kind:kind,expected_main:main,current_main:main,tree,files,directory_conflicts:[]}});return;
      }
      if(method==='POST'&&path==='/vaults/sample-vault/conflicts/sample-conflict/resolve'){
        const body = request.postDataJSON();
        if(body.expected_tree && body.expected_tree !== 'e'.repeat(40)){
          await route.fulfill({status:409,json:{error:{code:'stale_conflict_preview',message:'The reviewed resolution result changed; review the result again.'}}});return;
        }
        await route.fulfill({status:200,json:{status:'resolved',conflict_id:'sample-conflict',main:'f'.repeat(40),resolution_commit:'f'.repeat(40),event_seq:101,idempotent:false}});return;
      }
      unexpected.push({method,path});
      await route.fulfill({status:400,json:{error:{code:'fixture_missing',message:'This sample request is not configured.'}}});
    });
  }
  /** Opt-in revoked devices: plain revoked, removal pending, removal failed (retryable) and failed (needs a decision). */
  function addRevokedDevices() {
    const base = devices[0];
    const revoked = (index,name,minutesAgo,removal)=>({...base,device_id:`sample-device-${index}`,device_name:name,status:'revoked',status_label:'Offline',revoked_at:ago(minutesAgo),removal,last_seen_at:ago(minutesAgo+30),last_status_report_at:ago(minutesAgo+30),status_report_fresh:false,status_report_age_seconds:(minutesAgo+30)*60,last_successful_sync_at:ago(minutesAgo+40),local_queue_status:null,behind_main:false,blocked:false,offline:true});
    devices.push(
      revoked(3,'Old tablet',90,null),
      revoked(4,'Retired netbook',200,{state:'pending',retryable:true,error_code:null}),
      revoked(5,'Spare phone',400,{state:'failed',retryable:true,error_code:'device_removal_incomplete'}),
      revoked(6,'Lab desktop',800,{state:'failed',retryable:false,error_code:'device_has_unmerged_work'})
    );
  }
  /** Hold the next matching request until `release()` is called; `started` resolves once it reached the route. */
  function holdNext(path,method='GET') {
    let release = () => {};
    let markStarted = () => {};
    const gate = new Promise(resolve=>{release=resolve;});
    const started = new Promise(resolve=>{markStarted=resolve;});
    holds.push({path,method,gate,markStarted,used:false});
    return {release,started};
  }
  return {eventRequests,holdNext,nameRepair,enableNameRepair,vault,oldVault,devices,addRevokedDevices,summary,oldSummary,conflict,review,routes,requests,unexpected,install,setFailure(value){failure=value;},scriptRemovalResponses(responses){removalScript.push(...responses);},removalResponses,setDelay(value){delay=value;},setDeletionStatus(statuses){routes['/vault-deletions']={deletions:statuses};}};
}
