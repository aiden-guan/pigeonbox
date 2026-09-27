/** Development-only visual fixture. Not an extension build entry. No real mail. */
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { DEFAULT_SETTINGS } from "@pigeonbox/shared";
import { PopupApp } from "../popup/PopupApp";
import { SidePanelApp } from "../sidepanel/SidePanelApp";
import { SettingsApp } from "../settings/SettingsApp";
import { OnboardingApp } from "../onboarding/OnboardingApp";
import { ThreadIntelCard } from "../content/thread-panel";
import { SURFACE_CSS, shadowMount } from "../content/surface";
import { installFloatDrag, placeFloat } from "../content/float-drag";
import { Pigeon, type PigeonState } from "../ui/Pigeon";
import "../styles.css";
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
let empty = false;
const listeners = new Set<(changes: unknown, area: string) => void>();
const demoSettings = {...DEFAULT_SETTINGS, aiMode:"disabled", trackerBaseUrl:"", personalApiToken:"", aiApiKey:"", aiEndpoint:""};
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
  runtime: { getURL:(p:string)=>`/${p}`, onMessage:{addListener:()=>undefined,removeListener:()=>undefined}, openOptionsPage:()=>{location.hash="settings";location.reload();},
    sendMessage:(message:{type:string;category?:string}, callback?:(r:unknown)=>void)=>{
      const response = PRODUCT_MESSAGES.has(message.type) ? productReply(message) : message.type==="GET_SETTINGS" ? {settings:demoSettings} : message.type==="LIST_SPLIT" ? {threads:empty || message.category!=="RESPOND" ? [] : demoThreads} : message.type==="RUN_DIAGNOSTICS" ? {gmailTab:"connected",ai:{status:"ready"},tracking:"healthy",coverage:"Preview uses fictional messages."} : message.type==="ASK_INBOX" ? (/^(draft|write|email)\b/i.test(String((message as {query?:string}).query||"")) ? demoDraft : demoAsk) : message.type==="OPEN_COMPOSE_DRAFT" ? {opened:true} : message.type==="GET_TRACKED_EMAILS" ? {emails:empty ? [] : demoTracked} : message.type==="GET_TRACKING_TIMELINE" ? {timeline:(message as {trackingId?:string}).trackingId==="trk-1" ? demoTimeline : (message as {trackingId?:string}).trackingId==="trk-3" ? [{type:"OPEN",timestamp:ago(4380)}] : []} : {};
      setTimeout(()=>callback?.(response),message.type==="ASK_INBOX" ? 1800 : 0); return Promise.resolve(response);
    } },
  storage:{session:{get:(_k:string,cb:(v:unknown)=>void)=>cb({}),set:()=>Promise.resolve()},local:{set:()=>Promise.resolve()},onChanged:{addListener:(fn:(changes:unknown,area:string)=>void)=>listeners.add(fn),removeListener:(fn:(changes:unknown,area:string)=>void)=>listeners.delete(fn)}},
  tabs:{create:()=>Promise.resolve(),query:()=>Promise.resolve([])},
}});

function ThreadPreview({state}:{state:PigeonState}) {
 const ref=useRef<HTMLDivElement>(null); const [mount,setMount]=useState<ShadowRoot|null>(null); const [drafting,setDrafting]=useState(false); const [notice,setNotice]=useState("");
 useLayoutEffect(()=>{ if(ref.current) setMount(ref.current.shadowRoot || ref.current.attachShadow({mode:"open"})); },[]);
 return <><div ref={ref} data-gi-ui="thread-sidebar"/>{mount ? createPortal(<><style>{SURFACE_CSS}</style><div id="gi-mount"><ThreadIntelCard variant="sidebar" canDraft drafting={drafting || state==="drafting"}
   pending={state==="indexing" ? "Analyzing this thread…" : null}
   intel={{classification:{category:"RESPOND",needsReply:true},summary:{source:"model",aiStatus:state==="error" ? "failed":"success",summary:{oneLine:"Maya likes the direction. She needs two small changes before Friday’s review.",keyPoints:["Try a warmer tone for the main screen.","Keep the pigeon. Give it a little personality."],actionItems:["Send the updated screens before the review."],dates:["Friday, September 25"]}}}}
   tracking={state==="opened" ? {opened:true,markLabel:"Open detected",headline:"An open was recorded for your email.",detail:"Image loading is a signal, not proof of reading.",countLabel:"1 open detected"}:null}
   onRetrySummary={()=>setNotice("Preview: summary retry requested.")}
   onDraft={()=>{setDrafting(true);setTimeout(()=>{setDrafting(false);setNotice("Preview: draft ready to review.");},2200);}}
   onRemind={()=>setNotice("Preview: reminder requested.")}/></div></>,mount):null}{notice ? <p role="status" className="preview-notice">{notice}</p>:null}</>;
}
function Preview(){
 const [view,setView]=useState(location.hash==="#settings"?"settings":"overview"); const [state,setState]=useState<PigeonState>("idle"); const [isEmpty,setEmpty]=useState(false); const [panelKey,setPanelKey]=useState(0);
 return <div className="preview"><header className="preview-nav"><span className="preview-wordmark">PigeonBox<span> / Copper Perch</span></span><nav aria-label="Preview screens">{["overview","settings","onboarding"].map(v=><button key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v}</button>)}</nav><span className="preview-fixture">Design preview · fictional mail</span></header>
 {view==="overview" ? <><section className="preview-intro"><div><div className="gi-kicker">A quieter kind of clever</div><h1>Good mail.<br/><em>Better company.</em></h1></div><p>Warm copper. Smoked glass.<br/>A familiar little face, with a life of its own.</p></section><section className="preview-grid"><article><div className="preview-caption">01 / Your perch <span>Toolbar popup</span></div><PopupApp/></article><article><div className="preview-caption">02 / Room to focus <button onClick={()=>{empty=!isEmpty;setEmpty(!isEmpty);setPanelKey(k=>k+1);}}>{isEmpty?"Show mail":"Empty state"}</button></div><div className="preview-panel"><SidePanelApp key={panelKey}/></div></article><article><div className="preview-caption">03 / The important bits <span>Thread companion</span></div><ThreadPreview state={state}/></article></section><section className="preview-states" aria-label="Pigeon animation states">{(["idle","indexing","drafting","opened","error"] as PigeonState[]).map(s=><button key={s} aria-pressed={state===s} onClick={()=>setState(s)}><Pigeon state={s} size={94}/><strong>{s==="opened"?"Open detected":s}</strong><span>4 animation frames</span></button>)}</section></> : view==="settings" ? <SettingsApp/> : <OnboardingApp/>}
 </div>;
}
function FloatCard() {
 const [mode,setMode]=useState<"docked"|"open"|"expanded">("open");
 return <ThreadIntelCard mode={mode} onMode={setMode} canDraft intel={{classification:{category:"PROMOTIONS"},summary:{source:"model",aiStatus:"success",summary:{oneLine:"A Math 52 exam review is scheduled for Monday from 4:00pm to 6:00pm.",keyPoints:["Math 52 midterm review, Monday, 4:00-6:00pm"],actionItems:["Attend the review"]}}}} onDraft={()=>{}} onRemind={()=>{}}/>;
}
// `#float` mounts the draggable, resizable card the way the content script does in Gmail.
if (location.hash === "#float") {
 const host = document.createElement("aside"); host.id = "gi-thread-panel";
 Object.assign(host.style, { position:"fixed", zIndex:"10", display:"block", width:"max-content" });
 document.documentElement.append(host);
 const fallback = () => ({ right: 28, top: 72 });
 installFloatDrag(host, fallback);
 createRoot(shadowMount(host)).render(<FloatCard/>);
 placeFloat(host, fallback());
 window.addEventListener("resize", () => placeFloat(host, fallback()));
}
const previewRoot = createRoot(document.getElementById("root")!);
previewRoot.render(<Preview/>);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
