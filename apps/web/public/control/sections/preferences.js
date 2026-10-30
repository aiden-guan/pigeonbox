import { button, checkbox, combobox, field, h, input, settings, toast } from '../ui.js';

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];
const DRAFT_KINDS = [
  ['reply', 'Replies'],
  ['follow_up', 'Follow-ups'],
  ['scheduling', 'Scheduling replies'],
  ['acknowledgment', 'Acknowledgments'],
  ['info_request', 'Requests for missing information'],
];

const checked = (row) => row.querySelector('input').checked;
const time = (value) => input({ type: 'time', value, required: true });
const number = (value, min, max) => input({ type: 'number', value, min, max });

/** The time zone this browser runs in, or null when it does not say. */
function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Offset and abbreviation right now, e.g. "GMT-7 PDT", shown beside each zone and searchable. */
function zoneHint(zone, now) {
  const part = (style) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  };
  const offset = part('shortOffset');
  const short = part('short');
  return short && short !== offset && !/^GMT|^UTC/.test(short) ? `${offset} ${short}` : offset;
}

function zones(...required) {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = [];
  }
  for (const zone of ['UTC', ...required]) if (zone && !list.includes(zone)) list.push(zone);
  const now = new Date();
  return list.map((zone) => [zone, zone.replace(/_/g, ' '), zoneHint(zone, now)]);
}

export async function render({ api }) {
  const { preferences: p } = await api('/v1/preferences');

  // Nobody has picked a zone until it differs from the server default (UTC).
  // Until then, start from this browser's zone; it is saved with the form.
  const detected = browserZone();
  const guessed = p.timeZone === 'UTC' && detected && detected !== 'UTC' ? detected : null;
  const zone = combobox(zones(p.timeZone, guessed), guessed ?? p.timeZone, { placeholder: 'Search time zones', empty: 'No time zone matches.' });
  const workdays = DAYS.map(([value, label]) => checkbox(label, p.workdays.includes(value), { value }));
  const workStart = time(p.workingHours.start);
  const workEnd = time(p.workingHours.end);

  const followDays = number(p.followUp.defaultBusinessDays, 1, 30);
  const remindOpened = checkbox('Remind me when they opened but did not reply', p.followUp.remindIfOpenedNoReply);
  const remindRevived = checkbox('Tell me when an old thread comes back to life', p.followUp.remindWhenRevived);
  const morningDraft = checkbox('Prepare follow-up drafts the morning they are due', p.followUp.prepareDraftMorningOf);
  const morningAt = time(p.followUp.morningAt);

  const draftsOn = checkbox('Prepare drafts in the background', p.autoDrafts.enabled, {}, 'Drafts are grounded in the thread; missing facts become placeholders.');
  const placeInGmail = checkbox('Also put them in Gmail as drafts', p.autoDrafts.placeInGmail, {}, 'Needs the “Create drafts” permission. PigeonBox never overwrites a draft you edited.');
  const learn = checkbox('Learn from how I edit drafts', p.autoDrafts.learnFromEdits, {}, 'Only structure (length, greeting, sign-off) is kept. Your text is never stored.');
  const kinds = DRAFT_KINDS.map(([value, label]) => checkbox(label, p.autoDrafts.kinds.includes(value), { value }));

  const buffer = number(p.calendar.bufferMinutes, 0, 120);
  const duration = number(p.calendar.defaultDurationMinutes, 5, 480);
  const backToBack = checkbox('Avoid back-to-back meetings', p.calendar.avoidBackToBack);
  const mornings = checkbox('Prefer mornings', p.calendar.preferMornings);

  const morningOn = checkbox('Morning briefing on workdays', p.briefings.morning.enabled);
  const morningTime = time(p.briefings.morning.at);
  const eodOn = checkbox('End-of-day wrap-up', p.briefings.endOfDay.enabled);
  const eodTime = time(p.briefings.endOfDay.at);
  const meetingOn = checkbox('Brief me before meetings', p.briefings.meeting.enabled);
  const meetingBefore = number(p.briefings.meeting.minutesBefore, 5, 240);
  const externalOnly = checkbox('Only meetings with people outside my company', p.briefings.meeting.externalOnly);

  const notify = {
    extension: checkbox('In the PigeonBox extension', p.notifications.extension),
    web: checkbox('In this web app', p.notifications.web),
    followUpsDue: checkbox('Follow-ups due', p.notifications.followUpsDue),
    approvals: checkbox('Approvals waiting', p.notifications.approvals),
    engagement: checkbox('Engagement (opens, clicks, document views)', p.notifications.engagement),
  };
  const web = checkbox('Allow web research for drafts and Chat', false, { disabled: true }, 'Coming soon.');

  const save = button('Save preferences', async () => {
    const days = workdays.filter(checked).map((row) => Number(row.querySelector('input').value));
    if (!days.length) throw new Error('Choose at least one working day.');
    if (workStart.value >= workEnd.value) throw new Error('Working hours must end after they start.');
    const draftKinds = kinds.filter(checked).map((row) => row.querySelector('input').value);
    await api('/v1/preferences/update', {
      method: 'POST',
      body: {
        preferences: {
          timeZone: zone.value,
          workdays: days,
          workingHours: { start: workStart.value, end: workEnd.value },
          followUp: { defaultBusinessDays: Number(followDays.value), remindIfOpenedNoReply: checked(remindOpened), remindWhenRevived: checked(remindRevived), prepareDraftMorningOf: checked(morningDraft), morningAt: morningAt.value },
          autoDrafts: { enabled: checked(draftsOn), placeInGmail: checked(placeInGmail), learnFromEdits: checked(learn), kinds: draftKinds },
          calendar: { bufferMinutes: Number(buffer.value), defaultDurationMinutes: Number(duration.value), avoidBackToBack: checked(backToBack), preferMornings: checked(mornings) },
          briefings: {
            morning: { enabled: checked(morningOn), at: morningTime.value },
            endOfDay: { enabled: checked(eodOn), at: eodTime.value },
            meeting: { enabled: checked(meetingOn), minutesBefore: Number(meetingBefore.value), externalOnly: checked(externalOnly) },
          },
          notifications: Object.fromEntries(Object.entries(notify).map(([name, row]) => [name, checked(row)])),
          webResearch: checked(web),
        },
      },
    });
    toast('Preferences saved.', 'success');
  }, { busy: 'Saving…' });

  return h(
    'form',
    { class: 'preferences', on: { submit: (event) => event.preventDefault() } },
    settings({ index: '01', title: 'Your working week', text: 'PigeonBox schedules reminders, briefings and send windows inside these hours.' }, field('Time zone', zone, guessed ? 'Detected from this browser. Save preferences to use it.' : null), h('div', { class: 'checks inline', attrs: { role: 'group', 'aria-label': 'Working days' } }, workdays), h('div', { class: 'grid-2' }, field('Day starts', workStart), field('Day ends', workEnd))),
    settings({ index: '02', title: 'Follow-ups', text: 'PigeonBox reminds you and prepares a draft. It never sends a follow-up for you.' }, field('Default wait (business days)', followDays), remindOpened, remindRevived, morningDraft, field('Morning prep time', morningAt)),
    settings({ index: '03', title: 'Background drafts', text: 'Drafts wait in PigeonBox, or in Gmail if you allow it. Nothing is sent.' }, draftsOn, placeInGmail, learn, h('p', { class: 'eyebrow kinds-label' }, 'Draft kinds'), h('div', { class: 'checks two', attrs: { role: 'group', 'aria-label': 'Draft kinds' } }, kinds)),
    settings({ index: '04', title: 'Calendar', text: 'Used when PigeonBox proposes times or prepares events for approval.' }, h('div', { class: 'grid-2' }, field('Buffer between meetings (minutes)', buffer), field('Default meeting length (minutes)', duration)), backToBack, mornings),
    settings({ index: '05', title: 'Briefings', text: 'Summaries built from synced mail and calendar.' }, morningOn, field('Morning briefing at', morningTime), eodOn, field('Wrap-up at', eodTime), meetingOn, field('Minutes before a meeting', meetingBefore), externalOnly),
    settings({ index: '06', title: 'Notifications', text: 'Where PigeonBox tells you, and about what. Outside your working hours, follow-up, draft and tracking alerts wait until your next workday starts.' }, Object.values(notify)),
    settings({ index: '07', title: 'Web research' }, web),
    h('div', { class: 'row sticky-actions' }, save, h('p', { class: 'hint' }, 'Saved to your PigeonBox server and used by every device signed in to this account.')),
  );
}
