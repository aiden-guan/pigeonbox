/** Development-only visual fixture. Not an extension build entry. No real mail. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { DEFAULT_SETTINGS } from "@pigeonbox/shared";
import { PigeonBoxWorkspace } from "../workspace/PigeonBoxWorkspace";
import { SettingsApp } from "../settings/SettingsApp";
import { OnboardingApp } from "../onboarding/OnboardingApp";
import { ThreadPanel } from "../content/thread/ThreadPanel";
import { SURFACE_CSS } from "../content/shell/surface";
import { AppearanceButton, useAppearance } from '../ui/appearance';
import { DotField, type DotState } from '../ui/DotField';
import { ensureWorkspace } from '../content/shell/workspace';
import { Pigeon, type PigeonState } from "../ui/Pigeon";
import "../styles.css";
import "../ui/dispatch.css";
import "../ui/system.css";
import "./preview.css";

const demoThreads = [
  { threadId:"sample-1", sender:"Maya Chen", subject:"A few thoughts on the new direction", snippet:"Love where this is going. Two small things before Friday…", timestamp:new Date(Date.now()-720000).toISOString(), priority:"HIGH" },
  { threadId:"sample-2", sender:"Oliver at Fieldwork", subject:"The samples are on their way", snippet:"Your material samples should arrive tomorrow morning.", timestamp:new Date(Date.now()-3600000).toISOString() },
  { threadId:"sample-3", sender:"Nina & Alex", subject:"Coffee next week?", snippet:"We’ll be in your neighborhood on Tuesday. Free at 10?", timestamp:new Date(Date.now()-7200000).toISOString() },
];
const ago = (minutes:number)=>new Date(Date.now()-minutes*60000).toISOString();
const demoTracked = [
  { trackingId:"trk-1", status:"SENT", subject:"Updated screens for Friday", sender:"ada@example.com", recipients:["Maya Chen"], gmailThreadId:"sample-1", gmailMessageId:null, sentAt:ago(300), firstOpenedAt:ago(262), lastOpenedAt:ago(41), openCount:3, clickCount:1, notifyIfNoReply:false },
  { trackingId:"trk-2", status:"SENT", subject:"Invoice #2041", sender:"ada@example.com", recipients:["billing@fieldwork.test"], gmailThreadId:"sample-2", gmailMessageId:null, sentAt:ago(1500), firstOpenedAt:null, lastOpenedAt:null, openCount:0, clickCount:0, notifyIfNoReply:true },
  { trackingId:"trk-3", status:"SENT", subject:"Coffee Tuesday works", sender:"ada@example.com", recipients:["Nina","Alex"], gmailThreadId:"sample-3", gmailMessageId:null, sentAt:ago(4400), firstOpenedAt:ago(4380), lastOpenedAt:ago(4380), openCount:1, clickCount:0, notifyIfNoReply:false },
];
const demoTimeline = [
  { type:"OPEN", timestamp:ago(262), viaProxy:true },
  { type:"CLICK", timestamp:ago(258), destination:"https://www.figma.com/file/demo" },
  { type:"OPEN", timestamp:ago(120) },
  { type:"OPEN", timestamp:ago(41) },
];
const demoDraft = { answer:"Here's a draft to Maya Chen.", coverageNote:"Preview uses fictional messages.", citations:[], draft:{ to:[{ email:"maya@fieldwork.test", name:"Maya Chen" }], subject:"Friday screens", body:"Hi Maya,\n\nThanks for sending the updated screens. I'll go through them tonight and send notes before Friday.\n\nBest,\nAiden" } };
const demoAsk = { answer:"Your 3 most recent sent emails.", coverageNote:"Preview uses fictional messages.", citations:[], items:[
  { threadId:"sample-1", subject:"Updated screens for Friday", who:"to Maya Chen", timestamp:ago(300), status:"Opened 3×", opened:true },
  { threadId:"sample-2", subject:"Invoice #2041", who:"to billing@fieldwork.test", timestamp:ago(1500), status:"Not opened", opened:false },
  { threadId:"sample-3", subject:"Coffee Tuesday works", who:"to Nina and Alex", timestamp:ago(4400) },
]};
const previewParams = new URLSearchParams(location.search);
const demoIntel = { classification:{category:'RESPOND',needsReply:true}, summary:{source:'model',aiStatus:'success',summary:{oneLine:'Maya needs two small changes before Friday’s review.',keyPoints:['Use a warmer tone for the main screen.','Keep the pigeon and simplify the controls.'],actionItems:['Send updated screens before the review.'],dates:['Friday, October 9']}} };
let empty = false;
const listeners = new Set<(changes: unknown, area: string) => void>();
const messages = new Set<(message: {type:string;appearance?:unknown}) => void>();
const demoSettings = {...DEFAULT_SETTINGS, aiMode:"disabled", trackerBaseUrl:"", personalApiToken:"", aiApiKey:"", aiEndpoint:""};
const demoSession = new Map<string, unknown>();
if (previewParams.has('theme')) demoSession.set('pigeonboxAppearance', previewParams.get('theme'));
function demoWrite(items:Record<string,unknown>, area:string) { const changes:Record<string,unknown>={};Object.entries(items).forEach(([key,value])=>{changes[key]={oldValue:demoSession.get(key),newValue:value};demoSession.set(key,value);});listeners.forEach(fn=>fn(changes,area)); if ('pigeonboxAppearance' in items) messages.forEach(fn=>fn({type:'WORKSPACE_APPEARANCE_CHANGED',appearance:items.pigeonboxAppearance})); }
// Product state for the run-mode UI. `#cloud` pretends this build has a Cloud URL.
const demoProduct = { runMode:"local", cloudAvailable: location.search.includes("cloud"), cloudConsentAt:null as string|null,
  cloud:{status: location.search.includes("cloud") ? "signed_out" : "not_configured", email:null as string|null, plan:null as string|null, capabilities:[] as string[]},
  capabilities:["ask_inbox"], aiDestination:"none", experimental:true, cloudOrigins:[] as string[] };
function productReply(message:{type:string;mode?:string}): unknown {
  if (message.type==="SET_RUN_MODE") { demoProduct.runMode = message.mode ?? "local"; demoProduct.cloudConsentAt = message.mode==="cloud" ? new Date().toISOString() : demoProduct.cloudConsentAt; demoProduct.aiDestination = message.mode==="cloud" ? "pigeonbox_cloud" : "none"; }
  if (message.type==="CLOUD_SIGN_IN") demoProduct.cloud = { status:"ready", email:"ada@example.com", plan:"cloud", capabilities:["cloud_ai","cloud_tracking"] };
  if (message.type==="CLOUD_SIGN_OUT") demoProduct.cloud = { status:"signed_out", email:null, plan:null, capabilities:[] };
  demoProduct.capabilities = demoProduct.runMode==="cloud" ? [...demoProduct.cloud.capabilities, "ask_inbox"] : ["ask_inbox"];
  return message.type==="GET_PRODUCT_STATE" ? demoProduct : { ok:true, state:{...demoProduct} };
}
const PRODUCT_MESSAGES = new Set(["GET_PRODUCT_STATE","SET_RUN_MODE","CLOUD_SIGN_IN","CLOUD_SIGN_OUT","CLOUD_REFRESH","CLOUD_BILLING"]);
// This shim lives only on this standalone preview URL.
Object.defineProperty(window, "chrome", { configurable:true, value: {
  runtime: { getURL:(p:string)=>p==='workspace.html' ? '/src/preview/index.html?surface=workspace' : `/${p}`, onMessage:{addListener:(fn:(message:{type:string;appearance?:unknown})=>void)=>messages.add(fn),removeListener:(fn:(message:{type:string;appearance?:unknown})=>void)=>messages.delete(fn)}, openOptionsPage:()=>{location.hash="settings";location.reload();},
    sendMessage:(message:{type:string;category?:string}, callback?:(r:unknown)=>void)=>{
      if (message.type==='WORKSPACE_PRESENTATION' || message.type==='WORKSPACE_NAVIGATE') { const value=message as unknown as {patch?:Record<string,unknown>;mode?:string;splitCategory?:string;cloudSection?:string};demoWrite({workspaceState:{...(demoSession.get('workspaceState') as object || {}),...(value.patch || {}),...(value.mode ? {mode:value.mode,splitCategory:value.splitCategory,cloudSection:value.cloudSection} : {})}},'local'); }
      const response = message.type==='GET_WORKSPACE_CONTEXT' ? {context:previewParams.has('thread') ? {tabId:7,threadId:'sample-1',subject:'A few thoughts on the new direction',sender:'Maya Chen',owner:{email:'ada@example.com',name:'Ada'}} : null} : message.type==='GET_THREAD_INTEL' ? demoIntel : message.type==='GET_WORKSPACE_PRESENTATION' ? {state:demoSession.get('workspaceState') || {display:'float',open:true,mode:'home'},appearance:demoSession.get('pigeonboxAppearance') || 'system'} : PRODUCT_MESSAGES.has(message.type) ? productReply(message) : message.type==="GET_SETTINGS" ? {settings:demoSettings} : message.type==="LIST_SPLIT" ? {threads:empty || message.category!=="RESPOND" ? [] : demoThreads} : message.type==="RUN_DIAGNOSTICS" ? {gmailTab:"connected",ai:{status:"ready"},tracking:"healthy",coverage:"Preview uses fictional messages."} : message.type==="ASK_INBOX" ? (/^(draft|write|email)\b/i.test(String((message as {query?:string}).query||"")) ? demoDraft : demoAsk) : message.type==="OPEN_COMPOSE_DRAFT" ? {opened:true} : message.type==="GET_TRACKED_EMAILS" ? {emails:empty ? [] : demoTracked} : message.type==="GET_TRACKING_TIMELINE" ? {timeline:(message as {trackingId?:string}).trackingId==="trk-1" ? demoTimeline : (message as {trackingId?:string}).trackingId==="trk-3" ? [{type:"OPEN",timestamp:ago(4380)}] : []} : {};
      if (message.type==="RUN_DIAGNOSTICS") (response as {indexedThreads?:number}).indexedThreads = demoThreads.length;
      setTimeout(()=>callback?.(response),message.type==="ASK_INBOX" ? 1800 : 0); return Promise.resolve(response);
    } },
  storage:{session:{get:(key:string,cb?:(v:unknown)=>void)=>{const value={[key]:demoSession.get(key)};cb?.(value);return Promise.resolve(value);},set:(items:Record<string,unknown>,cb?:()=>void)=>{demoWrite(items,'session');cb?.();return Promise.resolve();}},local:{get:(key:string,cb?:(v:unknown)=>void)=>{const value={[key]:demoSession.get(key)};cb?.(value);return Promise.resolve(value);},set:(items:Record<string,unknown>)=>{demoWrite(items,'local');return Promise.resolve();}},onChanged:{addListener:(fn:(changes:unknown,area:string)=>void)=>listeners.add(fn),removeListener:(fn:(changes:unknown,area:string)=>void)=>listeners.delete(fn)}},
  tabs:{update:()=>Promise.resolve({id:7}),create:()=>Promise.resolve({id:8}),query:()=>Promise.resolve([{id:7,windowId:4,url:"https://mail.google.com/mail/u/0/#inbox"}])},
  sidePanel:{open:()=>Promise.resolve()},
}});

// Nested development fixture uses the parent's in-memory Chrome shim.
if (window.parent !== window && window.parent.location.origin === location.origin) Object.defineProperty(window, 'chrome', {configurable:true,value:window.parent.chrome});
function ThreadPreview({state}:{state:PigeonState}) {
 const {appearance}=useAppearance();
 const ref=useRef<HTMLDivElement>(null); const [mount,setMount]=useState<ShadowRoot|null>(null); const [drafting,setDrafting]=useState(false); const [notice,setNotice]=useState("");
 useLayoutEffect(()=>{ if(ref.current) setMount(ref.current.shadowRoot || ref.current.attachShadow({mode:"open"})); },[]);
 return <><div ref={ref} data-pb-theme={appearance} data-gi-ui="thread-sidebar"/>{mount ? createPortal(<><style>{SURFACE_CSS}</style><div id="gi-mount"><ThreadPanel canDraft drafting={drafting || state==="drafting"}
   pending={state==="indexing" || state==="thinking" ? "Analyzing this thread…" : null}
   intel={{classification:{category:"RESPOND",needsReply:true},summary:{source:"model",aiStatus:state==="error" ? "failed":"success",summary:{oneLine:"Maya likes the direction. She needs two small changes before Friday’s review.",keyPoints:["Try a warmer tone for the main screen.","Keep the pigeon. Give it a little personality."],actionItems:["Send the updated screens before the review."],dates:["Friday, October 9"]}}}}
   tracking={state==="opened" ? {opened:true,markLabel:"Open detected",headline:"An open was recorded for your email.",detail:"Image loading is a signal, not proof of reading.",countLabel:"1 open detected"}:null}
   onRetrySummary={()=>setNotice("Preview: summary retry requested.")}
   onDraft={()=>{setDrafting(true);setTimeout(()=>{setDrafting(false);setNotice("Preview: draft ready to review.");},2200);}}
   onRemind={()=>setNotice("Preview: reminder requested.")}/></div></>,mount):null}{notice ? <p role="status" className="preview-notice">{notice}</p>:null}</>;
}
function MotionPreview() {
 const [state,setState]=useState<DotState>('analyzing');
 return <div className="preview preview-motion"><header className="preview-nav"><span className="preview-wordmark">PigeonBox / Motion</span><AppearanceButton /></header><main><p className="gi-kicker">Contour study</p><h1>Intelligence, in motion.</h1><p>One copper language. A different gesture for every kind of work.</p><div className="preview-orb-stage"><DotField state={state} size={136}/></div><nav aria-label="Orb states">{(['idle','listening','analyzing','searching','connecting','drafting','resolving','success'] as DotState[]).map(item=><button key={item} aria-pressed={state===item} onClick={()=>setState(item)}>{item}</button>)}</nav><div className="preview-orb-gallery" aria-label="Compare motion states">{(['analyzing','searching','listening','connecting','drafting','resolving'] as const).map(item=><button key={item} aria-pressed={state===item} onClick={()=>setState(item)}><DotField state={item} size={60}/><strong>{item}</strong><small>{{analyzing:'Orbiting contours',searching:'Radar sweep',listening:'Breathing waveform',connecting:'Meeting hemispheres',drafting:'Writing ribbons',resolving:'Focusing aperture'}[item]}</small></button>)}</div><div className="preview-orb-sizes">{[14,20,32,48,72].map(size=><div key={size}><DotField state={state} size={size}/><small>{size}px</small></div>)}</div><div className="preview-orb-context"><p role="status" className="gi-orb-line"><DotField state="searching" size={20}/>Looking through your mail…</p><button className="gi-btn" disabled><DotField state="drafting" onAccent size={16}/>Drafting…</button></div><p className="preview-fixture">Development preview · same artwork used in Gmail and the workspace</p></main></div>;
}
function Preview(){
 const [dotState,setDotState]=useState<DotState>('analyzing');
 const [view,setView]=useState(location.hash==="#settings"?"settings":"overview"); const [state,setState]=useState<PigeonState>("idle"); const [isEmpty,setEmpty]=useState(false); const [panelKey,setPanelKey]=useState(0);
 return <div className="preview"><header className="preview-nav"><span className="preview-wordmark">PigeonBox<span> / Correspondence</span></span><nav aria-label="Preview screens">{["overview","settings","onboarding"].map(v=><button key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v}</button>)}</nav><div className="preview-controls"><AppearanceButton /><span className="preview-fixture">Fictional mail · local preview</span></div></header>
 {view==="overview" ? <><section className="preview-intro"><div><h1>Correspondence, in order.</h1></div><p>One quiet workspace. A little intelligence when it matters.</p></section><section className="preview-grid"><article><div className="preview-caption">Your workspace <button onClick={()=>{empty=!isEmpty;setEmpty(!isEmpty);setPanelKey(k=>k+1);}}>{isEmpty?"Show mail":"Empty state"}</button></div><div className="preview-panel"><PigeonBoxWorkspace key={panelKey}/></div></article><article><div className="preview-caption">Current conversation <span>Thread companion</span></div><ThreadPreview state={state}/></article></section><section className="preview-states" aria-label="Pigeon animation states">{(["idle","thinking","searching","drafting","ready","success","attention","warning","error","sleeping"] as PigeonState[]).map(s=><button key={s} aria-pressed={state===s} onClick={()=>setState(s)}><Pigeon state={s} size={40}/><strong>{s==="opened"?"Open detected":s}</strong><span>{["thinking","searching","drafting","success"].includes(s) ? "Finite response" : "At rest"}</span></button>)}</section><section className="preview-dots" aria-label="Intelligence states"><DotField state={dotState} size={72} /><div><h2>A little movement. A clear signal.</h2><nav>{(['idle','listening','analyzing','searching','connecting','drafting','resolving','success'] as DotState[]).map(item=><button key={item} aria-pressed={dotState===item} onClick={()=>setDotState(item)}>{item}</button>)}</nav></div><a href="?surface=float&thread=1">Inspect Pidgy unfolding ↗</a></section></> : view==="settings" ? <SettingsApp/> : <OnboardingApp/>}
 </div>;
}
const previewRoot = createRoot(document.getElementById("root")!);
function FloatPreview(){
 useEffect(()=>{ensureWorkspace();},[]);
 return <div className="preview-gmail"><header>Gmail fixture <span>Fictional conversation · shell and iframe use the production components</span></header><aside>Inbox<br/><br/>Sent<br/><br/>Drafts</aside><main><h1>A few thoughts on the new direction</h1><p>Maya Chen</p><p>Love where this is going. Can we make two small changes before Friday?</p><label>Reply<textarea aria-label="Fixture reply body" placeholder="Your reply…" /></label></main></div>;
}
previewRoot.render(previewParams.get('surface')==='motion' ? <MotionPreview/> : previewParams.get('surface')==='workspace' ? <PigeonBoxWorkspace/> : previewParams.get('surface')==='float' ? <FloatPreview/> : <Preview/>);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
