import test from 'node:test';
import assert from 'node:assert/strict';

import { navigateToHistoryPrompt } from '../src/navigation.ts';

test('current-session prompt navigates directly without switching sessions', async () => {
  const calls:string[]=[];
  const ctx:any={
    sessionManager:{getSessionFile:()=>'/current'},
    navigateTree:async(id:string)=>{calls.push(`navigate:${id}`);return{cancelled:false}},
    switchSession:async()=>{calls.push('switch');return{cancelled:false}},
  };
  assert.equal(await navigateToHistoryPrompt(ctx,{sessionPath:'/current',userEntryId:'u1'}),'navigated');
  assert.deepEqual(calls,['navigate:u1']);
});

test('old-session navigation uses only the fresh replacement context', async () => {
  const calls:string[]=[];
  const fresh:any={navigateTree:async(id:string)=>{calls.push(`fresh:${id}`);return{cancelled:false}}};
  const stale:any={
    sessionManager:{getSessionFile:()=>'/current'},
    navigateTree:async()=>{throw new Error('stale navigate must not run')},
    switchSession:async(path:string,options:any)=>{calls.push(`switch:${path}`);await options.withSession(fresh);return{cancelled:false}},
  };
  assert.equal(await navigateToHistoryPrompt(stale,{sessionPath:'/old',userEntryId:'u9'}),'navigated');
  assert.deepEqual(calls,['switch:/old','fresh:u9']);
});

test('navigation cancellation and missing targets are non-fatal states', async () => {
  const current:any={sessionManager:{getSessionFile:()=>'/current'},navigateTree:async()=>({cancelled:true}),switchSession:async()=>({cancelled:false})};
  assert.equal(await navigateToHistoryPrompt(current,{sessionPath:'/current',userEntryId:'u'}),'cancelled');

  const failing:any={sessionManager:{getSessionFile:()=>'/current'},navigateTree:async()=>{throw new Error('missing')},switchSession:async()=>({cancelled:false})};
  await assert.doesNotReject(()=>navigateToHistoryPrompt(failing,{sessionPath:'/current',userEntryId:'missing'}));
  assert.equal(await navigateToHistoryPrompt(failing,{sessionPath:'/current',userEntryId:'missing'}),'unavailable');

  const cancelledSwitch:any={sessionManager:{getSessionFile:()=>'/current'},navigateTree:async()=>({cancelled:false}),switchSession:async()=>({cancelled:true})};
  assert.equal(await navigateToHistoryPrompt(cancelledSwitch,{sessionPath:'/old',userEntryId:'u'}),'cancelled');
});

test('unavailable prompt target reports a non-fatal warning', async () => {
  const notices: Array<[string, string | undefined]> = [];
  const ctx:any = {
    sessionManager: { getSessionFile: () => '/current' },
    navigateTree: async () => { throw new Error('missing entry'); },
    switchSession: async () => ({ cancelled: false }),
    ui: { notify: (message:string, type?:string) => notices.push([message, type]) },
  };

  const result = await navigateToHistoryPrompt(ctx, { sessionPath: '/current', userEntryId: 'missing' });

  assert.equal(result, 'unavailable');
  assert.deepEqual(notices, [['Prompt location is unavailable', 'warning']]);
});
