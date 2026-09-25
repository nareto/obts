export function createFixtures() {
  const now = new Date().toISOString();
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const main = 'a14f802ef33a591076d34504551bd5473a71000c';
  const vault = {vault_id:'sample-vault',display_name:'Personal notes',owner_user_id:'sample-owner',current_main:main,status:'active',created_at:ago(8000),updated_at:now};
  const oldVault = {...vault,vault_id:'old-test-vault',display_name:'Old test vault',current_main:'f'.repeat(40)};
  const devices = ['Desktop workstation','Travel laptop','Android phone'].map((name,i)=>({device_id:`sample-device-${i}`,device_name:name,status:'active',status_label:['Synced','Applying','Offline'][i],last_seen_at:ago([0,1,360][i]),device_ref_head:main,last_applied_main:main,last_successful_sync_at:ago([2,15,360][i]),local_status_label:['Synced','Applying','Synced'][i],local_error_code:null,local_queue_status:i===1?'applying':null,local_main:main,local_head:main,plugin_version:i===2?'0.3.23':'0.3.25',path_capabilities:null,last_status_report_at:ago([0,1,360][i]),status_report_fresh:i!==2,status_report_age_seconds:[5,30,21600][i],ahead_of_main:false,behind_main:i===1,blocked:false,offline:i===2}));
  const conflict = {conflict_id:'sample-conflict',vault_id:vault.vault_id,device_id:devices[1].device_id,device_name:devices[1].device_name,conflict_type:'Content conflict',stale:false,status_label:'Review needed',status:'open',base_commit:'1'.repeat(40),current_main:main,device_commit:'2'.repeat(40),expected_main:main,affected_paths:['Projects/Weekend plans.md','Notes/Reading list.md'],affected_path_count:2,merge_sequence:7,merge_policy_version:'1',conflict_kind:'content',validator_results:{},validator_summary:{},created_at:ago(10)};
  const files = conflict.affected_paths.map((path,i)=>({path,content_kind:'text',base_content:i?'# Reading list\n\n- The Dispossessed\n':'# Weekend plans\n\n- Visit the market\n- Read a book\n',server_content:i?'# Reading list\n\n- The Dispossessed\n- Piranesi\n':'# Weekend plans\n\n- Visit the market on Saturday\n- Read a book\n',device_content:i?'# Reading list\n\n- The Dispossessed\n- Solaris\n':'# Weekend plans\n\n- Visit the market on Sunday\n- Read a book\n',base_bytes:51,server_bytes:63,device_bytes:61,base_sha256:'1'.repeat(64),server_sha256:'2'.repeat(64),device_sha256:'3'.repeat(64),source_diff:'',rendered_markdown_diff:null}));
  const review = {conflict,stale:false,expected_main:main,current_main:main,device_name:devices[1].device_name,path_conflicts:files.map((f,i)=>({group_id:`path-${i}`,kind:'same_path',base_path:f.path,server_path:f.path,device_path:f.path,server_operation:'modified',device_operation:'modified',affected_paths:[f.path]})),files,directory_conflicts:[],choices:['keep_server','use_device','keep_both_files','insert_both_blocks','manual']};
  const checks = ['metadata_store','git_store','temp_workspace','migrations','git','filesystem_permissions','event_delivery','persistent_state'];
  const labels = ['Metadata database','Server Git store','Temporary workspace','Migrations','Native Git','Filesystem permissions','Event delivery','Persistent-state backup contract'];
  const summary = {vault,devices,recommended_plugin_version:'0.3.25',unresolved_conflict_count:1,conflicts:[conflict],recent_activity:['Device synchronized','Changes merged into server main','Conflict recorded','Device connected'].map((label,i)=>({event_id:`sample-event-${i}`,event_seq:100-i,event_type:'sample',label,created_at:ago(i*8),device_id:devices[i%3].device_id,main})),maintenance:checks.map((key,i)=>({key,label:labels[i],status_label:'Synced',last_checked_at:now,detail:i===7?'Backup must include metadata and Git stores.':'Check passed',...(i===1?{action:'start_git_maintenance'}:i===7?{action:'view_backup_contract'}:{})})),health:{status:'ready',checks:Object.fromEntries(checks.map(k=>[k,true])),detail:null,git_version:'git version 2.49.0'}};
  const oldSummary = {...summary,vault:oldVault,devices:[],conflicts:[],unresolved_conflict_count:0,recent_activity:[]};
  const diagnostic = {event_id:'sample-diagnostic-0',plugin_version:'0.3.25',obsidian_version:'1.8.0',platform_family:'linux',flow:'sync',stage:'upload',failure_code:'sample_failure',error_class:'network',retryable:true,breadcrumbs:[{point:'request',outcome:'failed',value_kind:'none',size_bucket:'small',error_code:'timeout'}],received_at:now};
  const routes = {'/setup/status':{setup_complete:true},'/auth/session':{user_id:'sample-owner',csrf_token:'',recent_auth_expires_at:'2099-01-01T00:00:00Z'},'/vaults':{vaults:[vault,oldVault]},'/vault-deletions':{deletions:[]},'/diagnostic-events':{ingestion_enabled:false,retention_days:30,events:[diagnostic],next_cursor:null},'/vaults/sample-vault/dashboard':summary,'/vaults/old-test-vault/dashboard':oldSummary,'/vaults/sample-vault/conflicts':{conflicts:[conflict]},'/vaults/old-test-vault/conflicts':{conflicts:[]},'/vaults/sample-vault/conflicts/sample-conflict':review};
  const requests = [];
  const unexpected = [];
  let failure = null;
  let delay = 0;
  async function install(page) {
    await page.route('**/api/v1/**',async route=>{
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api/v1','');
      const method = request.method();
      let body = null;
      try { body = request.postDataJSON(); } catch {}
      requests.push({method,path,csrf:request.headers()['x-obts-csrf'] ?? null,body});
      if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
      if(failure && (!failure.path || failure.path===path)) {
        await route.fulfill({status:failure.status ?? 503,json:{error:{code:'fixture_unavailable',message:'The sample server is temporarily unavailable.'}}});
        return;
      }
      if(method==='GET'&&routes[path]!==undefined){await route.fulfill({status:200,json:routes[path]});return;}
      if(method==='POST'&&path==='/auth/login'){await route.fulfill({status:200,json:routes['/auth/session']});return;}
      if(method==='POST'&&path==='/auth/reauthenticate'){await route.fulfill({status:200,json:routes['/auth/session']});return;}
      if(method==='POST'&&path==='/vaults/sample-vault/history/query'){
        await route.fulfill({status:200,json:{path:'Notes/Sample.md',current_main:main,versions:[{commit:main,parent_commit:'1'.repeat(40),tree:'2'.repeat(40),path:'Notes/Sample.md',operation_type:'update',timestamp:now,author_name:'Sample owner',author_email:'',subject:'Sample note update'}]}});return;
      }
      if(method==='POST'&&path==='/vaults/sample-vault/history/version'){
        await route.fulfill({status:200,json:{path:'Notes/Sample.md',commit:main,content:'Sample content from vault A',source_diff:'Sample content from vault A',rendered_markdown_diff:null,metadata_only:false,content_redacted:false}});return;
      }
      const deviceMatch = path.match(/^\/vaults\/sample-vault\/devices\/(sample-device-\d)(\/revoke)?$/u);
      if(deviceMatch){
        const device = devices.find(device=>device.device_id===deviceMatch[1]);
        if(device&&method==='PATCH'&&!deviceMatch[2]) {
          const body = request.postDataJSON();
          if(!body.device_name?.trim()) {await route.fulfill({status:400,json:{error:{code:'invalid_request',message:'Enter a device name.'}}});return;}
          device.device_name=body.device_name;
          await route.fulfill({status:200,json:{device_id:device.device_id,device_name:device.device_name}});return;
        }
        if(device&&method==='POST'&&deviceMatch[2]) {device.status='revoked';device.status_label='Offline';await route.fulfill({status:200,json:{status:'ok'}});return;}
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
  return {vault,oldVault,devices,summary,oldSummary,conflict,review,routes,requests,unexpected,install,setFailure(value){failure=value;},setDelay(value){delay=value;},setDeletionStatus(statuses){routes['/vault-deletions']={deletions:statuses};}};
}
