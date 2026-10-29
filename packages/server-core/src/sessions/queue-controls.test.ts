import {afterEach,beforeEach,describe,expect,it,mock,spyOn} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SessionManager,createManagedSession} from './SessionManager'
import * as backendFactory from '@craft-agent/shared/agent/backend'
import {saveSession,loadSession} from '@craft-agent/shared/sessions'

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
describe('owner-controlled queue',()=>{
 let sm:SessionManager,managed:any,dir:string,events:any[]
 beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'craft-queue-'))
  sm=new SessionManager();events=[]
  managed=createManagedSession({id:'queue',name:'Queue'}, {id:'ws',name:'Fixture',rootPath:dir,createdAt:1} as any,{messagesLoaded:true})
  ;(sm as any).sessions.set(managed.id,managed)
  ;(sm as any).persistSession=()=>{}
  ;(sm as any).flushSession=async()=>{}
  sm.setEventSink((_a,_b,event)=>events.push(event))
 })
 afterEach(()=>{mock.restore();rmSync(dir,{recursive:true,force:true})})
 function add(id:string,text=id){
  const payload={message:text,messageId:id,optimisticMessageId:'optimistic-'+id}
  managed.messageQueue.push(payload);managed.messages.push({id,role:'user',content:text,timestamp:1,isQueued:true})
  return payload
 }
 it('does not lose or merge the payload while editing and removing by optimistic identity',async()=>{
  const a=add('a'),b:any=add('b')
  b.attachments=[{id:'file'}];b.storedAttachments=[{id:'stored'}];b.options={skillSlugs:['ship'],badges:[{label:'old'}]}
  await sm.queueMessage('queue','pause','optimistic-b')
  await sm.queueMessage('queue','edit','optimistic-b','new text')
  expect(managed.queuePaused).toBe(true)
  expect(managed.messageQueue).toEqual([a,b])
  expect(b.message).toBe('new text');expect(b.attachments).toEqual([{id:'file'}]);expect(b.options.skillSlugs).toEqual(['ship'])
  expect(managed.messages[1].content).toBe('new text')
  await sm.queueMessage('queue','remove','optimistic-a')
  expect(managed.messageQueue).toEqual([b]);expect(managed.messages.map((m:any)=>m.id)).toEqual(['b'])
  expect(events.find(e=>e.type==='queued_message_removed')).toMatchObject({messageId:'a',optimisticMessageId:'optimistic-a'})
 })
 it('rejects editing or pausing a message which has already been delivered',async()=>{
  add('waiting');await expect(sm.queueMessage('queue','pause','gone')).rejects.toThrow('already left')
  await expect(sm.queueMessage('queue','edit','gone','new')).rejects.toThrow('already left')
  expect(managed.queuePaused).not.toBe(true);expect(managed.messageQueue[0].message).toBe('waiting')
 })
 it('sends the selected item as a non-destructive steer and preserves the rest of the FIFO',async()=>{
  const a=add('a'),b=add('b');managed.isProcessing=true
  managed.agent={canSteerNow:()=>true,redirect:mock(()=>true),takePendingSteers:()=>[]}
  await sm.queueMessage('queue','send','optimistic-b')
  expect(managed.agent.redirect.mock.calls).toEqual([['b',{messageId:'b'}]])
  expect(managed.messageQueue).toEqual([a]);expect(managed.acceptedSteers.get('b')).toBe(b)
  expect(managed.messages[1].isQueued).toBe(false)
 })
 it('does not drop attachments or abort a running turn when it cannot accept that steer',async()=>{
  const a:any=add('a');a.storedAttachments=[{id:'image'}];managed.isProcessing=true
  managed.agent={canSteerNow:()=>true,redirect:mock(()=>true),forceAbort:mock(()=>{})}
  await expect(sm.queueMessage('queue','send','a')).rejects.toThrow('cannot steer')
  expect(managed.messageQueue).toEqual([a]);expect(managed.agent.redirect).not.toHaveBeenCalled();expect(managed.agent.forceAbort).not.toHaveBeenCalled()
 })
 it('keeps the reservation across asynchronous preflight and cannot schedule the same head twice',async()=>{
  add('a');add('b')
  let release!:()=>void;const gate=new Promise<void>(r=>release=r)
  ;(sm as any).sendMessage=mock(async()=>{await gate})
  ;(sm as any).processNextQueuedMessage('queue')
  ;(sm as any).processNextQueuedMessage('queue')
  expect(managed.queueReplayScheduled).toBe(true);expect(managed.messageQueue.map((x:any)=>x.messageId)).toEqual(['a','b'])
  await tick();expect((sm as any).sendMessage).toHaveBeenCalledTimes(1)
  expect(managed.messageQueue.map((item:any)=>item.messageId)).toEqual(['a','b'])
  expect(managed.messages.every((item:any)=>item.isQueued)).toBe(true)
  expect(managed.queueReplayScheduled).toBe(true);expect(managed.queueReplayMessageId).toBe('a')
  ;(sm as any).processNextQueuedMessage('queue');await tick();expect((sm as any).sendMessage).toHaveBeenCalledTimes(1)
  release()
 })
 it('revalidates edited, paused, or removed messages before committing a replay',async()=>{
  const a=add('a');add('b');managed.queueReplayEntries=[a];managed.queueReplayScheduled=true;managed.queueReplayMessageId='a'
  managed.queuePaused=true
  expect((sm as any).claimQueuedReplay(managed,'a',undefined)).toBe(false)
  expect(managed.messageQueue).toHaveLength(2);expect(managed.messages[0].isQueued).toBe(true)
  managed.queueReplayEntries=[a];managed.queueReplayScheduled=true;managed.queueReplayMessageId='a'
  a.message='edited'
  expect((sm as any).claimQueuedReplay(managed,'a',undefined)).toBe(false)
  expect(managed.messageQueue[0].message).toBe('edited')
 })
 it('gives legacy anonymous recovery payloads durable identity instead of requeueing the replay itself',async()=>{
  const payload:any={message:'legacy recovery',options:{hidden:true}}
  managed.messageQueue.push(payload)
  const replay=mock(async(..._args:unknown[])=>{})
  ;(sm as any).sendMessage=replay
  ;(sm as any).processNextQueuedMessage('queue');await tick()
  expect(typeof payload.messageId).toBe('string')
  expect(managed.queueReplayMessageId).toBe(payload.messageId)
  expect(managed.messages[0]).toMatchObject({id:payload.messageId,isQueued:true,hidden:true,content:'legacy recovery'})
  expect(replay.mock.calls[0]?.[5]).toBe(payload.messageId)
 })
 it('checks pause/archive at dispatch time before dequeuing or changing delivery state',async()=>{
  add('a');(sm as any).sendMessage=mock(async()=>{})
  ;(sm as any).processNextQueuedMessage('queue');managed.queuePaused=true
  await tick();expect((sm as any).sendMessage).not.toHaveBeenCalled();expect(managed.messages[0].isQueued).toBe(true)
  managed.queuePaused=false;(sm as any).processNextQueuedMessage('queue');managed.isArchived=true
  await tick();expect((sm as any).sendMessage).not.toHaveBeenCalled();expect(managed.messageQueue).toHaveLength(1)
 })
 it('retains a failed replay as paused pending work instead of losing it or looping retries',async()=>{
  const a=add('a');(sm as any).sendMessage=mock(async()=>{throw Error('preflight failed')})
  ;(sm as any).processNextQueuedMessage('queue');await tick();await tick()
  expect(managed.messageQueue).toEqual([a]);expect(managed.messages[0].isQueued).toBe(true)
  expect(managed.queuePaused).toBe(true);expect((sm as any).sendMessage).toHaveBeenCalledTimes(1)
 })
 it('honors an explicit queue over connection defaults and the optional decision model',async()=>{
  spyOn(backendFactory,'resolveSessionConnection').mockReturnValue({providerType:'pi',midStreamBehavior:'steer'} as any)
  managed.isProcessing=true;managed.agent={redirect:mock(()=>true)}
  ;(sm as any).decisionFeatureActive=()=>true
  ;(sm as any).markQueuedContinuation=mock(async()=>{})
  await sm.sendMessage('queue','wait',undefined,undefined,{deliveryMode:'queue'})
  expect(managed.messageQueue).toHaveLength(1);expect(managed.agent.redirect).not.toHaveBeenCalled()
  expect((sm as any).markQueuedContinuation).not.toHaveBeenCalled()
 })
 it.each(['paused','edited'])('ignores a late automatic steering decision after the owner %s the queue',async kind=>{
  const payload=add('a');managed.isProcessing=true
  const redirect=mock(()=>true);managed.agent={canSteerNow:()=>true,redirect}
  let resolve!: (choice:'steer')=>void
  ;(sm as any).decideMidTurnDelivery=()=>new Promise<'steer'>(r=>resolve=r)
  const decision=(sm as any).steerQueuedIfDecided(managed,payload,managed.messages[0],'steer')
  if(kind==='paused')managed.queuePaused=true
  else payload.message='owner edit'
  resolve('steer');await decision
  expect(redirect).not.toHaveBeenCalled();expect(managed.messageQueue).toEqual([payload])
 })
 it('rejects archived queue operations and persists pause state for reconnects',async()=>{
  managed.isArchived=true
  await expect(sm.queueMessage('queue','resume')).rejects.toThrow()
  managed.isArchived=false
  await saveSession({id:'persist',workspaceRootPath:dir,createdAt:1,lastUsedAt:1,queuePaused:true,messages:[]} as any)
  const saved=loadSession(dir,'persist')
  expect(saved?.queuePaused).toBe(true)
 })
})
