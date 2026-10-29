import {describe,expect,it} from 'bun:test'
import {processEvent} from '../../processor'
import type {SessionState} from '../../types'
const state=(messages:any[]):SessionState=>({session:{id:'queue',isProcessing:true,messages,lastMessageAt:1} as any,streaming:null})
const queued=(id:string)=>({id,role:'user' as const,content:'continue',timestamp:100,isQueued:true,isPending:true})
describe('queue renderer delivery identity',()=>{
 it('keeps all undelivered messages pending when the active turn completes',()=>{
  const original=state([queued('a'),queued('b')])
  const after=processEvent(original,{type:'complete',sessionId:'queue'}).state
  expect(after.session.isProcessing).toBe(false)
  expect(after.session.messages.map(m=>m.isQueued)).toEqual([true,true])
  expect(original.session.messages.map(m=>m.isQueued)).toEqual([true,true])
 })
 it('uses the exact optimistic identity for identical consecutive messages',()=>{
  const original=state([queued('opt-a'),queued('opt-b')])
  const after=processEvent(original,{type:'user_message',sessionId:'queue',optimisticMessageId:'opt-b',status:'processing',message:{...queued('backend-b'),timestamp:200}}).state
  expect(after.session.messages[0]).toMatchObject({id:'opt-a',isQueued:true,isPending:true})
  expect(after.session.messages[1]).toMatchObject({id:'opt-b',isQueued:false,isPending:false,timestamp:200})
 })
 it('does not merge an unknown explicit identity into another same-text message',()=>{
  const after=processEvent(state([queued('a')]),{type:'user_message',sessionId:'queue',optimisticMessageId:'opt-b',status:'queued',message:queued('backend-b')}).state
  expect(after.session.messages.map(m=>m.id)).toEqual(['a','backend-b'])
 })
 it('removes only the requested queued message without losing streaming state',()=>{
  const original=state([queued('opt-a'),queued('opt-b')]);original.streaming={turnId:'active'} as any
  const after=processEvent(original,{type:'queued_message_removed',sessionId:'queue',messageId:'backend-b',optimisticMessageId:'opt-b'}).state
  expect(after.session.messages.map(m=>m.id)).toEqual(['opt-a']);expect(after.streaming).toBe(original.streaming)
 })
 it('accepts a recovered steer, but ignores an older queued acknowledgement',()=>{
  const original=state([{...queued('a'),isQueued:false,isPending:false,timestamp:200}])
  const recovered=processEvent(original,{type:'user_message',sessionId:'queue',status:'queued',message:{...queued('a'),timestamp:201}}).state
  expect(recovered.session.messages[0].isQueued).toBe(true)
  const late=processEvent(original,{type:'user_message',sessionId:'queue',status:'queued',message:{...queued('a'),timestamp:100}}).state
  expect(late.session.messages[0].isQueued).toBe(false)
 })
 it('updates edited text while retaining the queued attachment',()=>{
  const original=state([{...queued('a'),attachments:[{id:'image',type:'image',name:'image.png',mimeType:'image/png',size:1,storedPath:'/tmp/image.png'}]}])
  const after=processEvent(original,{type:'user_message',sessionId:'queue',status:'queued',message:{...queued('a'),content:'edited',badges:undefined}}).state
  expect(after.session.messages[0].content).toBe('edited');expect(after.session.messages[0].attachments).toMatchObject([{id:'image'}])
 })
})
