/** Fictional mail for the onboarding stage, and where each piece sits before and after the sort. */

export type Lane = 'needs' | 'waiting' | 'updates' | 'archive';
/** Features the board can spotlight while a setup step is open. */
export type Focus = 'sort' | 'summaries' | 'drafts' | 'followups' | 'tracking' | 'archive';
type Agent = { kind: 'draft' | 'summary' | 'nudge' | 'opened'; text: string };
export type Mail = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  time: string;
  lane: Lane;
  labels?: Array<[string, string]>;
  agent?: Agent;
};

const m = (from: string, subject: string, snippet: string, time: string, lane: Lane, extra: Partial<Mail> = {}): Mail =>
  ({ id: `${lane}-${from}-${subject}`.replace(/\W+/g, '-'), from, subject, snippet, time, lane, ...extra });

// Gmail label palette, roughly.
const PROMO: [string, string] = ['Promotions', '#1a7f37'];
const SOCIAL: [string, string] = ['Social', '#1a73e8'];
const UPD: [string, string] = ['Updates', '#b06000'];
const FORUM: [string, string] = ['Forums', '#8430ce'];
const IMP: [string, string] = ['Important', '#c5221f'];

/** Interleaved the way a real inbox is: the mail that matters is buried. */
export const MAIL: Mail[] = [
  m('Flash Sale', 'LAST CHANCE: 70% off ends at midnight!!!', 'Don’t miss out. Your cart is waiting', '9:41 AM', 'archive', { labels: [PROMO] }),
  m('Maya Chen', 'A few thoughts on the new direction', 'Love where this is going. Two small things before Friday', '9:38 AM', 'needs', { labels: [IMP], agent: { kind: 'draft', text: 'Draft ready' } }),
  m('LinkedIn', 'You appeared in 14 searches this week', 'See who’s looking at your profile', '9:30 AM', 'archive', { labels: [SOCIAL] }),
  m('GitHub', '[pigeonbox] CI failed on main', 'Run #2041 failed in 3m 12s', '9:22 AM', 'updates', { labels: [UPD] }),
  m('Slack', 'You have 23 unread messages in #general', 'Catch up on what you missed', '9:15 AM', 'archive', { labels: [UPD] }),
  m('Oliver at Fieldwork', 'Contract redlines, need sign-off by Monday', 'Attached the latest. Clause 4 changed', '9:02 AM', 'needs', { labels: [IMP], agent: { kind: 'summary', text: 'Sign by Mon · clause 4' } }),
  m('Uber Eats', 'Your order is on the way 🍜', 'Arriving in 12–17 minutes', '8:57 AM', 'archive', { labels: [UPD] }),
  m('Medium Daily Digest', '10 productivity hacks you need', 'Stories picked for you', '8:50 AM', 'archive', { labels: [PROMO] }),
  m('Nina & Alex', 'Coffee next week?', 'We’ll be in your neighborhood Tuesday. Free at 10?', '8:44 AM', 'needs', { agent: { kind: 'draft', text: 'Draft ready' } }),
  m('Calendar', 'Updated invitation: Weekly sync @ Thu 2pm', 'The organizer changed the time', '8:31 AM', 'updates', { labels: [UPD] }),
  m('Figma', 'Sam commented on “Onboarding v3”', '“Can we try a warmer tone here?”', '8:20 AM', 'updates', { labels: [UPD] }),
  m('Twitter', 'Trending in Technology', 'See what people are talking about', '8:12 AM', 'archive', { labels: [SOCIAL] }),
  m('You → Priya Raman', 'Proposal for Q4 partnership', 'Sent Monday. No reply yet', 'Mon', 'waiting', { agent: { kind: 'opened', text: 'Opened 3×' } }),
  m('Bank of Somewhere', 'Your statement is ready', 'View your October statement', '7:58 AM', 'updates', { labels: [UPD] }),
  m('Groupon', 'Deals near you: 60% off spa days', 'Treat yourself this weekend', '7:45 AM', 'archive', { labels: [PROMO] }),
  m('Hiring team, Acme', 'Next steps: final round interview', 'Please pick a time that works this week', '7:32 AM', 'needs', { labels: [IMP], agent: { kind: 'summary', text: 'Pick a slot by Wed' } }),
  m('Product Hunt', 'Top 5 launches today', 'Including 3 AI tools you’ll love', '7:20 AM', 'archive', { labels: [PROMO] }),
  m('You → Dana Brooks', 'Invoice #2041', 'Sent last Thursday', 'Thu', 'waiting', { agent: { kind: 'nudge', text: 'Nudge Thu' } }),
  m('Reddit', 'r/webdev: “What’s your inbox zero trick?”', 'Trending in communities you follow', '7:02 AM', 'archive', { labels: [FORUM] }),
  m('Notion', 'Weekly digest for your workspace', '5 pages updated', '6:51 AM', 'updates', { labels: [UPD] }),
  m('Spotify', 'Your Daily Mix is ready', 'Fresh picks just for you', '6:40 AM', 'archive', { labels: [PROMO] }),
  m('Jordan Lee', 'Quick question about the launch date', 'Is the 14th still realistic?', '6:28 AM', 'needs'),
  m('Amazon', 'Your package was delivered', 'Left at front door', '6:15 AM', 'updates', { labels: [UPD] }),
  m('Webinar Team', 'Starting soon: Scale your growth', 'Join 2,000+ marketers live', '6:02 AM', 'archive', { labels: [PROMO] }),
  m('You → Studio Ten', 'Re: Re: Fwd: Q3 numbers', 'Sent Tuesday', 'Tue', 'waiting', { agent: { kind: 'opened', text: 'Opened 1×' } }),
  m('Instagram', 'sam.designs and 12 others liked your post', 'See your activity', '5:48 AM', 'archive', { labels: [SOCIAL] }),
  m('Duolingo', '🦉 You’re about to lose your streak!', 'A quick lesson takes 5 minutes', '5:30 AM', 'archive', { labels: [PROMO] }),
  m('You → Marcus', 'Follow-up on the design review', 'Sent Friday', 'Fri', 'waiting', { agent: { kind: 'nudge', text: 'Nudge Mon' } }),
  m('Airline Co.', 'Check in now for your flight', 'Your flight departs in 24 hours', '5:12 AM', 'updates', { labels: [UPD] }),
  m('Survey Monkey', 'We value your feedback!', 'Take our 2-minute survey', '4:58 AM', 'archive', { labels: [PROMO] }),
  m('Zoom', 'Cloud recording is now available', 'Recording of “Standup”', '4:40 AM', 'archive', { labels: [UPD] }),
  m('Newsletter', 'This week in AI: 47 things', 'You won’t believe #12', '4:22 AM', 'archive', { labels: [PROMO] }),
  m('Facebook', 'You have 9 new notifications', 'See what you missed', '4:01 AM', 'archive', { labels: [SOCIAL] }),
  m('Hotel Rewards', 'Your points are expiring soon', 'Use 4,200 points before Oct 31', '3:44 AM', 'archive', { labels: [PROMO] }),
  m('Dropbox', 'Your storage is 98% full', 'Upgrade to keep syncing', '3:20 AM', 'archive', { labels: [UPD] }),
  m('Event Bot', 'Reminder: RSVP for the mixer', 'Spots are filling up', '2:58 AM', 'archive', { labels: [PROMO] }),
];

/** Pop-ups that pile on top of the inbox before the sort. They are swept into the archive. */
export const POPUPS: Array<{ id: string; icon: string; title: string; body: string; x: number; y: number; r: number }> = [
  { id: 'p1', icon: '🔔', title: '47 new notifications', body: 'From 9 apps', x: 0.70, y: 0.16, r: 3 },
  { id: 'p2', icon: '%', title: 'FLASH SALE · 70% OFF', body: 'Ends tonight. Don’t miss out!', x: 0.52, y: 0.62, r: -4 },
  { id: 'p3', icon: '📅', title: 'Invitation updated', body: 'Weekly sync moved (again)', x: 0.83, y: 0.48, r: 5 },
  { id: 'p4', icon: '💬', title: 'Slack · 23 unread', body: '#general, #random, +6', x: 0.28, y: 0.80, r: -2 },
  { id: 'p5', icon: '📦', title: 'Your order shipped', body: 'Track package →', x: 0.80, y: 0.82, r: -6 },
  { id: 'p6', icon: '!', title: 'Storage 98% full', body: 'Upgrade to keep syncing', x: 0.36, y: 0.30, r: 4 },
];

export const LANES: Array<{ id: Lane; title: string; hint: string }> = [
  { id: 'needs', title: 'Needs you', hint: 'Replies waiting on you' },
  { id: 'waiting', title: 'Waiting', hint: 'Nudged if no reply' },
  { id: 'updates', title: 'Updates', hint: 'Summarized, no action' },
  { id: 'archive', title: 'Archived', hint: 'Noise, out of the way' },
];

/** Which spotlight each card answers to. */
export function tagsFor(mail: Mail): Focus[] {
  const tags: Focus[] = ['sort'];
  if (mail.agent?.kind === 'summary' || mail.lane === 'updates') tags.push('summaries');
  if (mail.agent?.kind === 'draft') tags.push('drafts');
  if (mail.agent?.kind === 'nudge' || mail.lane === 'waiting') tags.push('followups');
  if (mail.agent?.kind === 'opened') tags.push('tracking');
  if (mail.lane === 'archive') tags.push('archive');
  return tags;
}

export type Box = { x: number; y: number; w: number; h: number; z?: number; o?: number };

export const GMAIL = { top: 64, side: 232, tabs: 48, row: 36 };

/** Gmail list rows: dense, full width, one after another. */
export function clutterBox(index: number, vw: number): Box {
  const narrow = vw < 760;
  const left = narrow ? 8 : GMAIL.side;
  return { x: left, y: GMAIL.top + GMAIL.tabs + index * GMAIL.row, w: vw - left - 16, h: GMAIL.row };
}

/** The board the mail settles into. Leaves room on the left for the setup panel on wide screens. */
export function boardFrame(vw: number, vh: number) {
  const wide = vw >= 1040;
  const panel = wide ? Math.min(440, Math.max(380, vw * 0.3)) : 0;
  const x = wide ? 40 + panel + 48 : 16;
  const top = wide ? 112 : 88;
  const width = vw - x - (wide ? 40 : 16);
  const gap = wide ? 14 : 8;
  const laneW = (width - gap * 3) / 4;
  return { wide, panel, x, top, width, gap, laneW, bottom: vh - 24 };
}

const CARD = 62;
const AGENT = 26;

/** Card position after the sort. Archived mail collapses into a deck. */
export function sortedBox(mail: Mail, vw: number, vh: number): Box {
  const frame = boardFrame(vw, vh);
  const laneIndex = LANES.findIndex((lane) => lane.id === mail.lane);
  const peers = MAIL.filter((item) => item.lane === mail.lane);
  const rank = peers.indexOf(mail);
  const x = frame.x + laneIndex * (frame.laneW + frame.gap);
  const y0 = frame.top + 60;
  if (mail.lane === 'archive') {
    const depth = Math.min(rank, 5);
    return { x: x + depth * 4, y: y0 + depth * 9, w: frame.laneW - depth * 6, h: CARD, z: 40 - rank, o: rank > 5 ? 0 : 1 - depth * 0.13 };
  }
  let y = y0;
  for (const peer of peers.slice(0, rank)) y += (peer.agent ? CARD + AGENT : CARD) + 10;
  return { x, y, w: frame.laneW, h: mail.agent ? CARD + AGENT : CARD, z: 50 };
}

export function laneCount(lane: Lane): number {
  return MAIL.filter((mail) => mail.lane === lane).length;
}
