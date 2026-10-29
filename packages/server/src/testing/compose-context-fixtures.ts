import { MemoryFixtureAI } from './memory-fixtures.js';
import type { ChatRequest, InferenceContext } from '../ai/backends.js';
import { readDataBlock } from '../intel/prompts.js';
import type { MemoryCandidate } from '../intel/memory/types.js';
import { composeInferenceFixture } from './compose-inference-fixture.js';

/** Synthetic extraction/arbitration; database, provenance, RLS and routing remain real. */
export class ComposeContextFixtureAI extends MemoryFixtureAI {
  checks: ChatRequest[]=[];
  judgment: Record<string,unknown> | 'malformed' | null = null;
  beforeAnswer?: () => Promise<void>;
  override async chat(request:ChatRequest,context:InferenceContext) {
    if(context.operation==='compose_check') {
      this.checks.push(request);
      await this.beforeAnswer?.();
      const data=readDataBlock(request.messages.at(-1)!.content) as {sentence:string;evidence:Array<{id:string;kind:string;advisories:string[];text:string}>};
      const calendar=data.evidence.find(item=>item.kind==='calendar_event');
      const selected=calendar ?? data.evidence.find(item=>item.advisories.length);
      const value=this.judgment ?? {surface:true,kind:'overlooked_context',message:selected?.advisories[0] ?? '',confidence:0.96,sourceIds:data.evidence.map(item=>item.id).slice(0,4),suggestedText:null,highlightText:data.sentence.includes('any upcoming hackathons')?'any upcoming hackathons':null};
      return {text:this.judgment==='malformed'?'not JSON':JSON.stringify(composeInferenceFixture(value as Record<string,unknown>,data.evidence)),model:'fixture',provider:'mock',serviceTier:request.serviceTier,usage:{inputTokens:300,outputTokens:60}};
    }
    if(context.operation==='memory_extract') {
      const data=JSON.parse(request.messages.find(part=>part.role==='user')!.content) as {owner:string;messages:Array<{gmailMessageId:string;from:string;to:string[];text:string}>};
      const memories=data.messages.flatMap(source=>{
        const text=source.text.match(/CalHacks is a hackathon\.|You submitted TreeHacks\.|Your TreeHacks application was submitted\.|Daniel received the deck\./)?.[0];
        if(!text)return [];
        const candidate:MemoryCandidate={op:'add',ref:null,subject:text.startsWith('Daniel')?{type:'topic',key:'deck',label:'Deck'}:{type:'self',key:'self',label:'You'},kind:'semantic',category:'projects',canonicalText:text,importance:0.9,confidence:0.96,usefulness:0.9,entities:[{type:'email',key:source.from===data.owner?source.to[0]!:source.from},{type:'event',key:text.includes('CalHacks')?'CalHacks':'TreeHacks'}],gmailMessageId:source.gmailMessageId,evidence:text,sensitivity:'ordinary',validFrom:null,validUntil:null,temporary:false,concept:null,explicitUpdate:false};
        return [candidate];
      });
      if(memories.length) return {text:JSON.stringify({memories}),model:'fixture',provider:'mock',serviceTier:request.serviceTier,usage:{inputTokens:40,outputTokens:50}};
    }
    return super.chat(request,context);
  }
}
